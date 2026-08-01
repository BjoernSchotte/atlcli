import { afterEach, describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESEARCH_BRIEF_PREFLIGHT_OUTCOME_SCHEMA_V1,
  RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
  ResearchContractError,
  createMemoryResearchWorkspace,
  prepareResearchBriefPreflightV1,
  type ResearchReportV1,
} from "@atlcli/research";
import { createStandardResearchBriefV1 } from "@atlcli/research/graph";
import {
  buildResearchRequest,
  defaultResearchCliDependencies,
  handleResearch,
  parseResearchCliInput,
  researchArtifactPath,
  writeResearchMarkdownAtomic,
  type ResearchCliDependencies,
  type ResearchCliWorkspace,
} from "./research.js";

const profile: Profile = {
  name: "mayflower",
  baseUrl: "https://tenant-a.atlassian.net",
  project: "ATLCLI",
  space: "DOCSY",
  auth: { type: "apiToken", email: "test@example.invalid", token: "test" },
};

const report: ResearchReportV1 = {
  schema: "atlcli.research-report/v1",
  title: "Synthetic report",
  question: "Find related content",
  scope: {
    siteOrigin: "https://tenant-a.atlassian.net",
    jiraProjectKeys: ["ATLCLI"],
    confluenceSpaceKeys: ["DOCSY"],
  },
  executiveSummary: "Synthetic.",
  findings: [],
  relationships: [],
  limitations: [],
  sources: [],
  run: {
    model: "claude-sonnet-4-6",
    wikiProvider: "rest",
    startedAt: "2026-07-31T12:00:00.000Z",
    completedAt: "2026-07-31T12:00:01.000Z",
    durationMs: 1_000,
    complete: true,
    counts: { ptcCalls: 0, httpCalls: 0, jiraItems: 0, confluenceItems: 0 },
    warnings: [],
  },
  markdown: "# Synthetic report\n\nExact bytes.",
};

interface CliHarness {
  dependencies: ResearchCliDependencies;
  stdout: string[];
  stderr: string[];
  writes: Map<string, string>;
  workspaces: Array<ResearchCliWorkspace & { disposed: boolean }>;
  runInputs: Parameters<ResearchCliDependencies["runAgent"]>[0][];
  triggerInterrupt(): void;
}

function cliHarness(options: {
  apiKey?: string;
  profile?: Profile;
  result?: ResearchReportV1;
  runError?: Error;
  abortAtDeadline?: boolean;
} = {}): CliHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes = new Map<string, string>();
  const workspaces: Array<ResearchCliWorkspace & { disposed: boolean }> = [];
  const runInputs: Parameters<ResearchCliDependencies["runAgent"]>[0][] = [];
  let interrupt: (() => void) | undefined;
  const dependencies: ResearchCliDependencies = {
    resolveProfile: async () => options.profile ?? profile,
    resolveScope: async ({ request }) => ({
      schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
      kind: "ready",
      request,
      mentions: [],
      resolutions: [],
    }),
    prepareBrief: ({ request, policy, asOf, timezone }) =>
      prepareResearchBriefPreflightV1(createStandardResearchBriefV1(request.question, {
        scope: request.scope,
        scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
        limits: request.limits,
        asOf,
        timezone,
        policy,
      })),
    readApiKey: () => options.apiKey ?? "sk-ant-test-command-only",
    async createWorkspace() {
      const memory = createMemoryResearchWorkspace();
      const workspace = Object.assign(memory, {
        root: `/tmp/research-workspace-${workspaces.length + 1}`,
        disposed: false,
        async dispose() { workspace.disposed = true; },
      });
      workspaces.push(workspace);
      return workspace;
    },
    async runAgent(input) {
      runInputs.push(input);
      input.onEvent({
        kind: "phase",
        seq: 1,
        at: "2026-07-31T12:00:00.000Z",
        phase: "researching",
      });
      input.onEvent({
        kind: "subagent",
        seq: 2,
        at: "2026-07-31T12:00:00.000Z",
        taskId: "research-task:1",
        roleId: "wiki-retrieval",
        status: "started",
      });
      input.onEvent({
        kind: "capability",
        seq: 3,
        at: "2026-07-31T12:00:00.000Z",
        callId: "wiki.search:1",
        toolId: "wiki.search",
        inputKind: "search",
        status: "completed",
        itemCount: 10,
        durationMs: 42,
      });
      input.onEvent({
        kind: "decision",
        seq: 4,
        at: "2026-07-31T12:00:00.000Z",
        decisionId: "deterministic-evidence-validation",
        status: "started",
        reasonCode: "validate-before-render",
      });
      if (input.signal.aborted) {
        throw new ResearchContractError("cancelled", "The research run was cancelled.");
      }
      if (options.runError) throw options.runError;
      const result = options.result ?? report;
      await input.workspace.writeFile("/artifacts/report.md", result.markdown);
      return result;
    },
    async writeAtomic(path, contents) { writes.set(path, contents); },
    artifactPath: () => "/external/artifact/report.md",
    createSessionId: () => "research-test-run",
    writeStdout: (contents) => { stdout.push(contents); },
    writeStderr: (contents) => { stderr.push(contents); },
    emitOutput: (data) => { stdout.push(`${JSON.stringify(data, null, 2)}\n`); },
    fail(failOpts, _code, errCode, message, details): never {
      if (failOpts.json) {
        stdout.push(`${JSON.stringify({ error: { code: errCode, message, details: details ?? {} } }, null, 2)}\n`);
      }
      throw new Error(message);
    },
    scheduleAbort(callback) {
      if (options.abortAtDeadline) callback();
      return "deadline";
    },
    cancelScheduledAbort: () => undefined,
    listenForInterrupt(callback) {
      interrupt = callback;
      return () => { interrupt = undefined; };
    },
  };
  return {
    dependencies,
    stdout,
    stderr,
    writes,
    workspaces,
    runInputs,
    triggerInterrupt: () => interrupt?.(),
  };
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("research CLI one-shot contract", () => {
  test("parses repeatable locked scope flags and the fixed-date question context", () => {
    const input = parseResearchCliInput(
      ["Which", "items", "are", "related?"],
      {
        project: ["atlcli,platform", "ATLCLI"],
        space: "DOCSY,KB",
        "as-of": "2026-07-31T12:00:00+02:00",
        timezone: "Europe/Berlin",
        "keep-session": true,
      },
    );
    expect(input.projectKeys).toEqual(["ATLCLI", "PLATFORM"]);
    expect(input.spaceKeys).toEqual(["DOCSY", "KB"]);
    expect(input.keepSession).toBe(true);
    expect(input.maxRunMinutes).toBe(10);
    expect(input.policy).toEqual({
      schema: "atlcli.research-one-shot-policy/v1",
      requestedEffort: "auto",
      requestedPlanApproval: "default",
      scopeExpansionMode: "ask",
      requestedReconciliation: "auto",
    });
    expect(input.question).toContain("As-of date: 2026-07-31T10:00:00.000Z.");
    expect(input.question).toContain("Timezone: Europe/Berlin.");
  });

  test("accepts a bounded workflow deadline override", () => {
    const input = parseResearchCliInput(["Find related content"], { "max-run-minutes": "7" });
    const request = buildResearchRequest(input, profile);
    expect(input.maxRunMinutes).toBe(7);
    expect(request.limits.maxRunMs).toBe(7 * 60_000);
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": true })).toThrow("requires a value");
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": "0" })).toThrow("between 1 and 10");
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": "2.5" })).toThrow("between 1 and 10");
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": "11" })).toThrow("between 1 and 10");
  });

  test("uses profile defaults only when explicit keys are absent", () => {
    const input = parseResearchCliInput(["Find related content"], {});
    const request = buildResearchRequest(input, profile);
    expect(request.scope).toMatchObject({
      siteOrigin: "https://tenant-a.atlassian.net",
      jiraProjectKeys: ["ATLCLI"],
      confluenceSpaceKeys: ["DOCSY"],
    });
    expect(request.limits).toMatchObject({
      maxSearchPagesPerProduct: 5,
      maxBodyCharsPerItem: 50_000,
      maxRunMs: 600_000,
    });
    expect(request.scopeSeeds).toMatchObject([
      { binding: { key: "ATLCLI", source: "profile_default", authority: "approved" }, precedence: 200 },
      { binding: { key: "DOCSY", source: "profile_default", authority: "approved" }, precedence: 200 },
    ]);
  });

  test("preserves explicit key order as locked CLI scope provenance", () => {
    const input = parseResearchCliInput(["Find related content"], {
      project: ["SECOND,FIRST"],
      space: ["B,A"],
    });
    const request = buildResearchRequest(input, profile);
    expect(request.scope.jiraProjectKeys).toEqual(["SECOND", "FIRST"]);
    expect(request.scope.confluenceSpaceKeys).toEqual(["B", "A"]);
    expect(request.scopeSeeds?.map((seed) => [
      seed.binding.key,
      seed.binding.source,
      seed.binding.authority,
    ])).toEqual([
      ["SECOND", "cli_flag", "locked"],
      ["FIRST", "cli_flag", "locked"],
      ["B", "cli_flag", "locked"],
      ["A", "cli_flag", "locked"],
    ]);
  });

  test("accepts one-shot policy flags while keeping durable-session flags reserved", () => {
    expect(() => parseResearchCliInput(["question"], { resume: "r1" })).toThrow("reserved for durable sessions");
    expect(() => parseResearchCliInput(["question"], { "plan-only": true })).toThrow("--plan-only");
    expect(parseResearchCliInput(["question"], {
      effort: "deep",
      "plan-approval": "automatic",
      "scope-expansion": "exact-linked",
      reconciliation: "required",
    }).policy).toEqual({
      schema: "atlcli.research-one-shot-policy/v1",
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      scopeExpansionMode: "exact-linked",
      requestedReconciliation: "required",
    });
    expect(() => parseResearchCliInput(["question"], { effort: "unbounded" })).toThrow("--effort must be one of");
    expect(() => parseResearchCliInput(["question"], { "plan-approval": "required" })).toThrow("only automatic");
  });

  test("rejects unknown, secret, missing-value and repeated scalar flags", () => {
    expect(() => parseResearchCliInput(["question"], { "api-key": "sk-ant-test-command-only" }))
      .toThrow("never accepted as command-line flags");
    expect(() => parseResearchCliInput(["question"], { unknown: "value" }))
      .toThrow("Unknown research option: --unknown");
    expect(() => parseResearchCliInput(["question"], { profile: true }))
      .toThrow("--profile requires a value");
    expect(() => parseResearchCliInput(["question"], { output: "" }))
      .toThrow("--output requires a value");
    expect(() => parseResearchCliInput(["question"], { timezone: ["UTC", "Europe/Berlin"] }))
      .toThrow("--timezone may be specified only once");
    expect(() => parseResearchCliInput(["question"], { json: "false" }))
      .toThrow("--json does not accept a value");
  });

  test("validates fixed dates and IANA timezones before the shared request", () => {
    expect(() => parseResearchCliInput(["question"], { "as-of": "2026-02-30" })).toThrow("--as-of");
    expect(() => parseResearchCliInput(["question"], { "as-of": "2026-07-31T12:00:00" })).toThrow("timezone");
    expect(() => parseResearchCliInput(["question"], { timezone: "Not/AZone" })).toThrow("IANA");
  });

  test("prints command help without resolving credentials", async () => {
    const harness = cliHarness({ apiKey: undefined });
    harness.dependencies.resolveProfile = async () => { throw new Error("must not resolve"); };
    await handleResearch([], { help: true }, { json: false }, harness.dependencies);
    expect(harness.stdout.join("")).toContain("atlcli research <question>");
  });

  test("fails before workspace creation for a missing profile or key", async () => {
    const missingProfile = cliHarness();
    missingProfile.dependencies.resolveProfile = async () => undefined;
    await expect(handleResearch(["question"], {}, { json: false }, missingProfile.dependencies))
      .rejects.toThrow("No active profile");
    expect(missingProfile.workspaces).toHaveLength(0);

    const missingKey = cliHarness();
    missingKey.dependencies.readApiKey = () => undefined;
    await expect(handleResearch(["question"], {}, { json: false }, missingKey.dependencies))
      .rejects.toThrow("ANTHROPIC_API_KEY is missing");
    expect(missingKey.workspaces).toHaveLength(0);
  });

  test("stops on typed scope clarification before reading the key or creating a workspace", async () => {
    const harness = cliHarness();
    let keyReads = 0;
    harness.dependencies.readApiKey = () => {
      keyReads += 1;
      return "sk-ant-must-not-be-read";
    };
    harness.dependencies.resolveScope = async () => ({
      schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
      kind: "clarification_required",
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        reason: "ambiguous",
        mentionId: "mention:scope-1",
        candidateIds: [
          "research-scope-candidate:confluence-space-account-1",
          "research-scope-candidate:confluence-space-account-2",
        ],
        productHint: "confluence",
        entityKindHint: "space",
        rerunGuidance: ["Pass an exact Confluence space with --space <KEY>."],
      },
      candidateChoices: [],
      mentions: [],
      resolutions: [],
    });
    await expect(handleResearch(
      ["Research the Account Management space."],
      { json: true },
      { json: true },
      harness.dependencies,
    )).rejects.toThrow("Research scope requires clarification");
    expect(keyReads).toBe(0);
    expect(harness.workspaces).toHaveLength(0);
    expect(harness.runInputs).toHaveLength(0);
    expect(harness.stderr.join("")).toContain(
      "stop_reason=clarification-required reason=ambiguous mention=mention:scope-1 candidates=2",
    );
    expect(JSON.parse(harness.stdout.join(""))).toMatchObject({
      error: {
        details: {
          outcome: {
            schema: "atlcli.research-scope-preflight-outcome/v1",
            kind: "clarification_required",
            clarification: { reason: "ambiguous" },
          },
        },
      },
    });
  });

  test("stops on required brief clarification before graph, key, workspace, or agent work", async () => {
    const harness = cliHarness();
    let keyReads = 0;
    harness.dependencies.readApiKey = () => {
      keyReads += 1;
      return "sk-ant-must-not-be-read";
    };
    harness.dependencies.prepareBrief = () => ({
      schema: RESEARCH_BRIEF_PREFLIGHT_OUTCOME_SCHEMA_V1,
      kind: "clarification_required",
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        sessionId: "research-session:cli-brief",
        turnId: "research-turn:cli-brief",
        briefRevision: 3,
        questions: [{
          id: "clarification:time-window",
          prompt: "Which reporting window should be used?",
          required: true,
        }],
        assumptionsRequiringDecision: [{
          id: "assumption:include-archived",
          text: "Archived content would be included.",
          requiresUserDecision: true,
          status: "proposed",
        }],
      },
    });
    await expect(handleResearch(
      ["Research the approved scopes."],
      { json: true },
      { json: true },
      harness.dependencies,
    )).rejects.toThrow("Research brief requires clarification");
    expect(keyReads).toBe(0);
    expect(harness.workspaces).toHaveLength(0);
    expect(harness.runInputs).toHaveLength(0);
    expect(harness.stderr.join("")).toContain(
      "stop_reason=clarification-required brief_revision=3 questions=1 assumptions=1",
    );
    expect(JSON.parse(harness.stdout.join(""))).toMatchObject({
      error: {
        details: {
          outcome: {
            schema: "atlcli.research-brief-preflight-outcome/v1",
            kind: "clarification_required",
            clarification: {
              briefRevision: 3,
              questions: [{ id: "clarification:time-window" }],
              assumptionsRequiringDecision: [{ id: "assumption:include-archived" }],
            },
          },
        },
      },
    });
  });

  test("uses the host-resolved natural scope in the graph and agent request", async () => {
    const harness = cliHarness();
    harness.dependencies.resolveScope = async ({ request }) => {
      const resolved = buildResearchRequest(
        parseResearchCliInput(["question"], { project: "ATLCLI", space: "ACCOUNT" }),
        profile,
      );
      return {
        schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
        kind: "ready",
        request: { ...resolved, question: request.question },
        mentions: [],
        resolutions: [],
      };
    };
    await handleResearch(
      ["Research the Account Management space."],
      {},
      { json: false },
      harness.dependencies,
    );
    expect(harness.runInputs[0]?.request.scope.confluenceSpaceKeys).toEqual(["ACCOUNT"]);
    expect(harness.runInputs[0]?.researchGraph.approvalEnvelope.allowedScopeBindingIds)
      .toEqual(expect.arrayContaining([
        "scope-binding:cli_flag:confluence:ACCOUNT",
      ]));
    expect(harness.stderr.join("")).toContain("confluence:ACCOUNT:cli_flag:locked");
  });

  test("resolves exact Jira keys and same-tenant project links through the production CLI catalog boundary", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url.href);
      if (url.pathname === "/rest/api/3/project/search" && url.searchParams.get("query") === "DEMO") {
        return Response.json({
          values: [{ id: "103", key: "DEMO", name: "Demo project", archived: false }],
          total: 1,
        });
      }
      if (url.pathname === "/rest/api/3/project/DEMO") {
        return Response.json({ id: "103", key: "DEMO", name: "Demo project", archived: false });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const keyOutcome = await defaultResearchCliDependencies.resolveScope({
        profile,
        request: buildResearchRequest(
          parseResearchCliInput(["Research", "Jira", "project", "DEMO."], {}),
          profile,
        ),
      });
      const link = `${profile.baseUrl}/projects/DEMO/summary`;
      const linkOutcome = await defaultResearchCliDependencies.resolveScope({
        profile,
        request: buildResearchRequest(
          parseResearchCliInput(["Research", `${link}.`], {}),
          profile,
        ),
      });

      expect(keyOutcome).toMatchObject({
        kind: "ready",
        request: { scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["DOCSY"] } },
        resolutions: [{
          state: "resolved",
          resolvedCandidateId: "research-scope-candidate:jira-project-demo",
          uniquenessProof: "exact_key_lookup",
          requiresUserChoice: false,
        }],
      });
      expect(linkOutcome).toMatchObject({
        kind: "ready",
        request: { scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["DOCSY"] } },
        resolutions: [{
          state: "resolved",
          resolvedCandidateId: "research-scope-candidate:jira-project-demo",
          uniquenessProof: "exact_reference_lookup",
          requiresUserChoice: false,
        }],
      });
      expect(requests.filter((url) => url.includes("/rest/api/3/project/search"))).toHaveLength(1);
      expect(requests.filter((url) => url.includes("/rest/api/3/project/DEMO"))).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stops a default deep plan before reading the key, workspace, or agent", async () => {
    const harness = cliHarness();
    let keyReads = 0;
    harness.dependencies.readApiKey = () => {
      keyReads += 1;
      return "sk-ant-must-not-be-read";
    };
    await expect(handleResearch(
      ["Perform exhaustive contradiction analysis across Jira and Confluence."],
      { effort: "deep", json: true },
      { json: true },
      harness.dependencies,
    )).rejects.toThrow("requires approval");
    expect(keyReads).toBe(0);
    expect(harness.workspaces).toHaveLength(0);
    expect(harness.runInputs).toHaveLength(0);
    expect(JSON.parse(harness.stdout.join(""))).toMatchObject({
      error: {
        code: "ATLCLI_ERR_VALIDATION",
        details: {
          outcome: {
            schema: "atlcli.research-plan-approval-required/v1",
            kind: "plan_approval_required",
            resolvedEffort: "deep",
            resolvedPlanApproval: "required",
          },
        },
      },
    });
    expect(harness.stderr.join("")).toContain("stop_reason=plan-approval-required");
  });

  test("runs the identical deep plan only after explicit automatic approval", async () => {
    const harness = cliHarness();
    await handleResearch(
      ["Perform exhaustive contradiction analysis across Jira and Confluence."],
      { effort: "deep", "plan-approval": "automatic" },
      { json: false },
      harness.dependencies,
    );
    expect(harness.runInputs).toHaveLength(1);
    expect(harness.runInputs[0]?.researchGraph).toMatchObject({
      resolvedEffort: "deep",
      status: "approved",
      approvalEnvelope: { status: "approved" },
    });
    expect(harness.stderr.join("")).toContain("effort=deep plan_approval=approved");
  });

  test("keeps Markdown stdout and --output bytes identical and redacts the key", async () => {
    const secret = "sk-ant-test-command-secret-material";
    const harness = cliHarness({ apiKey: secret });
    await handleResearch(
      ["Find", "related", "content"],
      { output: "/chosen/report.md" },
      { json: false },
      harness.dependencies,
    );
    expect(harness.stdout.join("")).toBe(report.markdown);
    expect(harness.writes.get("/chosen/report.md")).toBe(report.markdown);
    expect(harness.writes.get("/external/artifact/report.md")).toBe(report.markdown);
    expect(harness.stderr.join("")).not.toContain(secret);
    expect(harness.stderr.join("")).not.toContain("key=present");
    expect(harness.runInputs[0]?.apiKey).toBe(secret);
    expect(harness.workspaces[0]?.disposed).toBe(true);
  });

  test("emits one JSON document on stdout while progress remains on stderr", async () => {
    const harness = cliHarness();
    await handleResearch(["Find related content"], { json: true }, { json: true }, harness.dependencies);
    const parsed = JSON.parse(harness.stdout.join(""));
    expect(parsed.report.markdown).toBe(report.markdown);
    expect(harness.stdout.join("")).not.toContain("[research]");
    expect(harness.stderr.join("")).toContain("[research] phase=researching");
    expect(harness.stderr.join("")).toContain("subagent=wiki-retrieval task=research-task:1 status=started");
    expect(harness.stderr.join("")).toContain("tool=wiki.search call=wiki.search:1 kind=search status=completed items=10 duration_ms=42");
    expect(harness.stderr.join("")).toContain("decision=deterministic-evidence-validation status=started reason=validate-before-render");
  });

  test("cleans an unretained workspace after cancellation and handled failure", async () => {
    const cancelled = cliHarness({ abortAtDeadline: true });
    await expect(handleResearch(["question"], {}, { json: false }, cancelled.dependencies))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(cancelled.workspaces[0]?.disposed).toBe(true);

    const failed = cliHarness({ runError: new Error("synthetic provider failure") });
    await expect(handleResearch(["question"], {}, { json: false }, failed.dependencies))
      .rejects.toThrow("synthetic provider failure");
    expect(failed.workspaces[0]?.disposed).toBe(true);
  });

  test("retains the mode-restricted session workspace when requested", async () => {
    const harness = cliHarness();
    await handleResearch(["question"], { "keep-session": true }, { json: false }, harness.dependencies);
    expect(harness.workspaces[0]?.disposed).toBe(false);
    expect(harness.stderr.join("")).toContain("session=research-test-run");
    expect(harness.stderr.join("")).toContain("workspace=/tmp/research-workspace-1");
  });

  test("atomically writes a mode-restricted Markdown file", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-output-test-"));
    temporaryRoots.push(root);
    const path = join(root, "nested", "report.md");
    await writeResearchMarkdownAtomic(path, report.markdown);
    expect(await readFile(path, "utf8")).toBe(report.markdown);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("places every report in a timestamped Documents artifact directory", () => {
    expect(researchArtifactPath(new Date("2026-07-31T08:55:17.123Z"))).toMatch(
      /Documents\/atlcli\/artefacts\/research-2026-07-31-08-55-17-123\/report\.md$/,
    );
  });
});
