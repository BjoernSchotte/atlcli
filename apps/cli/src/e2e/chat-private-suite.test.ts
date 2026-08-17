import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildChatPrivateCommandV1,
  chatPrivateSuiteEnvironmentV1,
  finalizeChatPrivateReviewV1,
  normalizePrivateSourceIdentityV1,
  parseChatPrivateSuiteArgumentsV1,
  parseChatPrivateSuiteV1,
  privateAnswerIntegrityIssuesV1,
  privateFactGroupMatchesV1,
  privateForbiddenClaimMatchesV1,
  privateOrderedFactGroupsMatchV1,
  projectPrivateAnswerV1,
  requireCleanPrivateProofRevisionV1,
  runChatPrivateSuiteV1,
  selectChatPrivateSuiteV1,
} from "./chat-private-suite.js";

const roots: string[] = [];
const cleanAuthority = { sourceRevision: async () => "a".repeat(40) };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sourceUrl = "https://tenant.invalid/wiki/spaces/SAFE/pages/100/Private-title";
const suite = parseChatPrivateSuiteV1({
  schema: "atlcli.chat-private-suite/v1",
  profile: "operator-profile",
  reportLanguage: "de",
  maxRunMinutes: 10,
  maxCostUsd: 2,
  pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
  cases: ["CASE01", "CASE02"].map((id, caseIndex) => ({
    id,
    projectKeys: [],
    spaceKeys: ["SAFE"],
    variants: caseIndex === 0 ? ["quick", "auto", "deep"] : ["quick", "auto", "deep", "deep-research"],
    turns: id === "CASE01" ? [1, 2, 3].map((turn) => ({
      question: `Private turn ${turn}`,
      gold: {
        requiredSourceUrls: [sourceUrl], allowedSourceUrls: [sourceUrl],
        requiredFactGroups: [[`supported fact ${turn}`]], forbiddenClaims: ["forbidden invention"], expectAbstention: false,
      },
    })) : [{
      question: "Private analytical question",
      gold: {
        requiredSourceUrls: [sourceUrl], allowedSourceUrls: [sourceUrl],
        requiredFactGroups: [["supported fact 1"]], forbiddenClaims: ["forbidden invention"], expectAbstention: false,
      },
    }],
  })),
});

function chatOutput(variant: "quick" | "auto" | "deep", turn: number): string {
  return JSON.stringify({
    sessionId: "research-session:private",
    answer: {
      messageMarkdown: `## Antwort\n\nSupported-fact ${turn}. [Quelle](${sourceUrl})`,
      citations: [{ url: sourceUrl }],
      strategy: { qualityMode: variant },
      run: {
        durationMs: 100,
        counts: { ptcCalls: 2, httpCalls: 1 },
        usage: { inputTokens: 100, outputTokens: 20 },
        modelRouting: { callsByRoute: { supervisor: 1 } },
      },
    },
  });
}

function researchOutput(): string {
  return JSON.stringify({
    sessionId: "research-session:private-research",
    report: {
      markdown: `# Bericht\n\nSupported fact 1.\n\n## Quellen\n\n[Quelle](${sourceUrl})`,
      sources: [{ url: sourceUrl }],
      run: { durationMs: 500, counts: { modelCalls: 7, ptcCalls: 4, httpCalls: 2 }, usage: { inputTokens: 300, outputTokens: 80 } },
    },
  });
}

describe("private Chat release suite", () => {
  test("requires private inputs and outputs outside the repository", () => {
    expect(() => parseChatPrivateSuiteArgumentsV1([
      "--suite", "relative.json", "--output-dir", "/private/output",
    ], "/repo")).toThrow("absolute");
    expect(() => parseChatPrivateSuiteArgumentsV1([
      "--suite", "/repo/private.json", "--output-dir", "/private/output",
    ], "/repo")).toThrow("outside");
  });

  test("isolates durable live sessions below the external artifact root", () => {
    const args = parseChatPrivateSuiteArgumentsV1([
      "--suite", "/private/suite.json", "--output-dir", "/private/output",
    ], "/repo");
    expect(chatPrivateSuiteEnvironmentV1(args, { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      ATLCLI_DISABLE_UPDATE_CHECK: "1",
      ATLCLI_RESEARCH_SESSIONS_DIR: "/private/output/sessions",
    });
  });

  test("refuses to issue revision-bound private proofs from a dirty worktree", () => {
    const revision = "a".repeat(40);
    expect(requireCleanPrivateProofRevisionV1({
      revision: ` ${revision}\n`,
      porcelainStatus: "",
    })).toBe(revision);
    expect(() => requireCleanPrivateProofRevisionV1({
      revision,
      porcelainStatus: " M packages/research/src/runtime.ts\n",
    })).toThrow("clean worktree");
    expect(() => requireCleanPrivateProofRevisionV1({
      revision: "short",
      porcelainStatus: "",
    })).toThrow("full Git commit revision");
  });

  test("selects one opaque case and variant for a bounded live proof", () => {
    const selected = selectChatPrivateSuiteV1(suite, {
      caseId: "CASE02",
      variant: "deep-research",
    });
    expect(selected.cases).toHaveLength(1);
    expect(selected.cases[0]).toMatchObject({
      id: "CASE02",
      variants: ["deep-research"],
    });
    expect(() => selectChatPrivateSuiteV1(suite, {
      caseId: "CASE01",
      variant: "deep-research",
    })).toThrow("not present");
  });

  test("builds production Chat follow-ups and the separate Deep Research command", () => {
    const args = parseChatPrivateSuiteArgumentsV1([
      "--suite", "/private/suite.json", "--output-dir", "/private/output",
    ], "/repo");
    const followUp = buildChatPrivateCommandV1({
      args, suite, entry: suite.cases[0]!, variant: "deep", turnIndex: 1,
      sessionId: "research-session:private", outputPath: "/private/output/turn.md", repositoryRoot: "/repo",
    });
    expect(followUp).toContain("chat");
    expect(followUp).toContain("--session");
    expect(followUp).toContain("research-session:private");
    expect(followUp).toContain("--thinking");
    expect(followUp).toContain("deep");
    expect(followUp).not.toContain("--max-run-minutes");
    expect(followUp).not.toContain("--language");

    const research = buildChatPrivateCommandV1({
      args, suite, entry: suite.cases[1]!, variant: "deep-research", turnIndex: 0,
      outputPath: "/private/output/research.md", repositoryRoot: "/repo",
    });
    expect(research).toContain("research");
    expect(research).not.toContain("--thinking");
    expect(research).toContain("--reconciliation");
  });

  test("projects structured Chat and Research output without accepting the wrong mode", () => {
    expect(projectPrivateAnswerV1(chatOutput("quick", 1), "quick").sourceUrls).toEqual([sourceUrl]);
    expect(projectPrivateAnswerV1(researchOutput(), "deep-research")).toMatchObject({
      qualityMode: "deep-research",
      modelCalls: 7,
    });
    expect(() => projectPrivateAnswerV1(chatOutput("auto", 1), "quick")).toThrow("invalid");
  });

  test("normalizes Confluence blog and page routes to the same content identity", () => {
    expect(normalizePrivateSourceIdentityV1(
      "https://tenant.invalid/wiki/spaces/~person/blog/2026/08/07/1178632199/Private-title",
    )).toBe("wiki:1178632199");
    expect(normalizePrivateSourceIdentityV1(
      "https://tenant.invalid/wiki/spaces/~person/pages/1178632199/Private-title",
    )).toBe("wiki:1178632199");
    expect(normalizePrivateSourceIdentityV1(
      "https://tenant.invalid/browse/SAFE-42",
    )).toBe("jira:SAFE-42");
  });

  test("matches equivalent German negative commercial boundaries", () => {
    expect(privateFactGroupMatchesV1(
      "Der Korridor ist weder Festpreis noch Aufwandsdeckel.",
      ["kein Festpreis", "weder einen Festpreis", "nicht als Festpreis"],
    )).toBe(true);
    expect(privateFactGroupMatchesV1(
      "Der Korridor ist ein Festpreis.",
      ["kein Festpreis", "weder einen Festpreis", "nicht als Festpreis"],
    )).toBe(false);
    expect(privateFactGroupMatchesV1(
      "Der Korridor ist eine Indikation ohne Festpreischarakter.",
      ["kein Festpreis", "weder einen Festpreis", "nicht als Festpreis"],
    )).toBe(true);
  });

  test("matches bounded commercial abbreviations and German adjective inflections", () => {
    expect(privateFactGroupMatchesV1(
      "Die Umsetzung erfolgt nach T&M.",
      ["Time & Material", "Time and Material"],
    )).toBe(true);
    expect(privateFactGroupMatchesV1(
      "Empfohlen wird das verlustfreie Profil.",
      ["verlustfreiem Profil", "verlustloses Profil"],
    )).toBe(true);
    expect(privateFactGroupMatchesV1(
      "Empfohlen wird das verlustfreiem Profil.",
      ["verlustfreie Profil"],
    )).toBe(true);
    expect(privateFactGroupMatchesV1(
      "Für den Betrieb hat Qualität Vorrang vor Geschwindigkeit.",
      ["Qualität vor Geschwindigkeit"],
    )).toBe(true);
    expect(privateFactGroupMatchesV1(
      "Der Durchsatz stieg von 0,42 → 0,60 tok/s.",
      ["0,42 tok/s"],
    )).toBe(true);
  });

  test("requires operator-authored ranked facts in their declared order", () => {
    const ranking = [
      ["Hebel A: +0,43"],
      ["Hebel B: +0,18"],
      ["Hebel C: +0,05"],
    ];
    expect(privateOrderedFactGroupsMatchV1(
      "1. Hebel A: +0,43\n2. Hebel B: +0,18\n3. Hebel C: +0,05",
      ranking,
    )).toBe(true);
    expect(privateOrderedFactGroupsMatchV1(
      "1. Hebel B: +0,18\n2. Hebel A: +0,43\n3. Hebel C: +0,05",
      ranking,
    )).toBe(false);
    expect(privateOrderedFactGroupsMatchV1("Beliebige Antwort", [])).toBe(true);
  });

  test("parses optional private ordered fact groups without requiring them", () => {
    const value = structuredClone(suite);
    value.cases[0]!.turns[0]!.gold.requiredOrderedFactGroups = [
      ["erster Messwert"],
      ["zweiter Messwert"],
    ];
    expect(parseChatPrivateSuiteV1(value).cases[0]!.turns[0]!.gold)
      .toMatchObject({
        requiredOrderedFactGroups: [
          ["erster Messwert"],
          ["zweiter Messwert"],
        ],
      });
    expect(suite.cases[1]!.turns[0]!.gold.requiredOrderedFactGroups).toEqual([]);
  });

  test("does not treat an explicit negation as a forbidden positive claim", () => {
    expect(privateForbiddenClaimMatchesV1(
      "Das Modell ist zu groß, um vollständig im RAM zu liegen.",
      "vollständig im RAM",
    )).toBe(false);
    expect(privateForbiddenClaimMatchesV1(
      "Dieses Profil ist nicht für interaktive Chats empfohlen.",
      "für interaktive Chats empfohlen",
    )).toBe(false);
    expect(privateForbiddenClaimMatchesV1(
      "Das Modell liegt vollständig im RAM.",
      "vollständig im RAM",
    )).toBe(true);
    expect(privateForbiddenClaimMatchesV1(
      "Dieses Profil ist für interaktive Chats empfohlen.",
      "für interaktive Chats empfohlen",
    )).toBe(true);
  });

  test("runs sequential production commands, scores local gold, and emits a neutral proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-chat-private-"));
    roots.push(root);
    const args = parseChatPrivateSuiteArgumentsV1([
      "--suite", join(root, "suite.json"), "--output-dir", join(root, "artifacts"),
    ], "/repository");
    const order: string[] = [];
    const proof = await runChatPrivateSuiteV1(args, suite, async (_command, context) => {
      order.push(`${context.caseId}:${context.variant}:${context.turnIndex}`);
      return {
        exitCode: 0,
        stdout: context.variant === "deep-research" ? researchOutput() : chatOutput(context.variant, context.turnIndex + 1),
        stderr: "Private live activity and provider trace",
      };
    }, cleanAuthority);
    expect(proof.status).toBe("passed");
    expect(proof.measurements.caseCount).toBe(2);
    expect(proof.measurements.runCount).toBe(7);
    expect(order[0]).toBe("CASE01:quick:0");
    expect(order.at(-1)).toBe("CASE02:deep-research:0");
    const persisted = await readFile(join(args.outputDirectory, "private-cli-proof.json"), "utf8");
    expect(persisted).not.toContain("Private turn");
    expect(persisted).not.toContain("tenant.invalid");
    expect(persisted).not.toContain("Private live activity");
    expect(persisted).toContain("private:CASE01");
  });

  test("classifies missing required facts separately from forbidden claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-chat-private-missing-fact-"));
    roots.push(root);
    const args = parseChatPrivateSuiteArgumentsV1([
      "--suite", join(root, "suite.json"), "--output-dir", join(root, "artifacts"),
    ], "/repository");
    const selected = selectChatPrivateSuiteV1(suite, { caseId: "CASE02", variant: "quick" });
    const proof = await runChatPrivateSuiteV1(args, selected, async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        sessionId: "research-session:private",
        answer: {
          messageMarkdown: `## Antwort\n\nA different supported detail. [Quelle](${sourceUrl})`,
          citations: [{ url: sourceUrl }],
          strategy: { qualityMode: "quick" },
          run: {
            durationMs: 100,
            counts: { ptcCalls: 1, httpCalls: 1 },
            usage: { inputTokens: 10, outputTokens: 5 },
            modelRouting: { callsByRoute: { supervisor: 1 } },
          },
        },
      }),
      stderr: "",
    }), cleanAuthority);

    expect(proof.status).toBe("failed");
    expect(proof.failureCodes).toContain("required-fact-missing");
    expect(proof.failureCodes).not.toContain("unsupported-claim");
  });

  test("fails private proof for structurally repeated conversational prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-chat-private-repetition-"));
    roots.push(root);
    const args = parseChatPrivateSuiteArgumentsV1([
      "--suite", join(root, "suite.json"), "--output-dir", join(root, "artifacts"),
    ], "/repository");
    const selected = selectChatPrivateSuiteV1(suite, { caseId: "CASE02", variant: "quick" });
    const repeated = "Supported fact 1 establishes the bounded result from the accepted source.";
    const proof = await runChatPrivateSuiteV1(args, selected, async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        sessionId: "research-session:private",
        answer: {
          messageMarkdown: `${repeated} [Quelle](${sourceUrl})\n\n${repeated}`,
          citations: [{ url: sourceUrl }],
          strategy: { qualityMode: "quick" },
          run: {
            durationMs: 100,
            counts: { ptcCalls: 1, httpCalls: 1 },
            usage: { inputTokens: 10, outputTokens: 5 },
            modelRouting: { callsByRoute: { supervisor: 1 } },
          },
        },
      }),
      stderr: "",
    }), cleanAuthority);

    expect(proof.status).toBe("failed");
    expect(proof.failureCodes).toContain("answer-integrity-failed");
    expect(proof.failureCodes).not.toContain("required-fact-missing");
  });

  test("allows report repetition without adding language-specific prose gates", () => {
    const repeated = [
      "# Bericht",
      "Supported fact 1 establishes the bounded result from the accepted source.",
      "## Ergebnisse",
      "Supported fact 1 establishes the bounded result from the accepted source.",
    ].join("\n\n");
    expect(privateAnswerIntegrityIssuesV1(repeated, "quick")).toContain("repeated-prose");
    expect(privateAnswerIntegrityIssuesV1(repeated, "deep-research")).toEqual([]);
  });

  test("compiles explicit operator and installed-extension decisions into neutral proofs", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-chat-private-review-"));
    roots.push(root);
    const args = parseChatPrivateSuiteArgumentsV1([
      "--suite", join(root, "suite.json"), "--output-dir", join(root, "artifacts"),
      "--review", join(root, "review.json"),
    ], "/repository");
    const decisions = {
      usefulness: true, sourceChoice: true, citations: true, visibleActivity: true,
      followUpCoherence: true, latencyCostTradeoff: true,
    };
    const runs = suite.cases.flatMap((entry) => entry.variants.map((variant) => ({ caseId: entry.id, variant, review: decisions })));
    const installedRuns = [
      { caseId: "CASE01", variant: "quick", durationMs: 10, costMicros: 1 },
      { caseId: "CASE01", variant: "auto", durationMs: 10, costMicros: 1 },
      { caseId: "CASE02", variant: "deep", durationMs: 10, costMicros: 1 },
    ].map((entry) => ({ ...entry, sourceSelection: true, citationSupport: true, outcome: true, modeIsolation: true, visibleActivity: true }));
    const result = await finalizeChatPrivateReviewV1(args, {
      schema: "atlcli.chat-private-review/v1", runs, installedRuns,
    }, cleanAuthority);
    expect(result.operator.status).toBe("passed");
    expect(result.installed.status).toBe("passed");
    const persisted = await readFile(join(args.outputDirectory, "private-operator-proof.json"), "utf8");
    expect(persisted).not.toContain("operator-profile");
    expect(persisted).toContain("private:CASE02");
  });
});
