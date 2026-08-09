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
  privateFactGroupMatchesV1,
  projectPrivateAnswerV1,
  runChatPrivateSuiteV1,
} from "./chat-private-suite.js";

const roots: string[] = [];
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
      run: { durationMs: 500, counts: { ptcCalls: 4, httpCalls: 2 }, usage: { inputTokens: 300, outputTokens: 80 } },
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
    expect(projectPrivateAnswerV1(researchOutput(), "deep-research").qualityMode).toBe("deep-research");
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
    });
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
    });
    expect(result.operator.status).toBe("passed");
    expect(result.installed.status).toBe("passed");
    const persisted = await readFile(join(args.outputDirectory, "private-operator-proof.json"), "utf8");
    expect(persisted).not.toContain("operator-profile");
    expect(persisted).toContain("private:CASE02");
  });
});
