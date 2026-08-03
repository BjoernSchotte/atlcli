import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildResearchPrivateSuiteCommand,
  parseResearchPrivateSuiteCliArguments,
  parseResearchPrivateSuiteV1,
  researchPrivateSuiteReportPath,
  runResearchPrivateSuite,
} from "./research-private-suite.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const suite = parseResearchPrivateSuiteV1({
  schema: "atlcli.research-private-suite/v1",
  profile: "operator-profile",
  asOf: "2026-08-03",
  timezone: "Europe/Berlin",
  reportLanguage: "de",
  effort: "lookup",
  reconciliation: "off",
  scopeExpansion: "strict",
  maxRunMinutes: 7,
  maxCostUsd: 1.25,
  cases: [{
    id: "A1",
    question: "Private question and source title must never enter metrics.",
    projectKeys: ["PRIVATEPROJ"],
    spaceKeys: ["PRIVATESPACE"],
  }],
});

describe("research CLI private suite harness", () => {
  test("keeps private suite and output paths outside the repository", () => {
    expect(() => parseResearchPrivateSuiteCliArguments([
      "--suite", "relative.json",
      "--output-dir", "/tmp/research-suite",
    ], "/repo")).toThrow("absolute");
    expect(() => parseResearchPrivateSuiteCliArguments([
      "--suite", "/repo/private.json",
      "--output-dir", "/tmp/research-suite",
    ], "/repo")).toThrow("outside");
    expect(() => parseResearchPrivateSuiteV1({ ...suite, cases: [{ ...suite.cases[0]!, id: "a1" }] }))
      .toThrow("case is invalid");
  });

  test("builds the bounded public CLI command without placing private fields in the metrics contract", () => {
    const input = parseResearchPrivateSuiteCliArguments([
      "--suite", "/private/suite.json",
      "--output-dir", "/private/artifacts",
    ], "/repo");
    const command = buildResearchPrivateSuiteCommand(input, suite, suite.cases[0]!, "/repo");
    expect(command).toContain("--as-of");
    expect(command).toContain("2026-08-03");
    expect(command).toContain("--language");
    expect(command).toContain("de");
    expect(command).toContain("--scope-expansion");
    expect(command).toContain("strict");
    expect(command).toContain("--reconciliation");
    expect(command).toContain("off");
    expect(command).toContain("--max-cost-usd");
    expect(command).toContain("1.25");
    expect(command).toContain("--json");
  });

  test("writes reports outside the checkout and sanitizes persisted metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-private-suite-"));
    roots.push(root);
    const input = parseResearchPrivateSuiteCliArguments([
      "--suite", join(root, "suite.json"),
      "--output-dir", join(root, "artifacts"),
    ], "/repository");
    await writeFile(input.suitePath, JSON.stringify(suite));
    let tick = 0;
    const metrics = await runResearchPrivateSuite(input, suite, async (_command, caseId) => {
      await writeFile(researchPrivateSuiteReportPath(input.outputDirectory, caseId), "# Private report\n\n## Sources\n\nPrivate source title\n");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ report: {
          title: "Private report title",
          question: suite.cases[0]!.question,
          run: {
            complete: true,
            counts: { ptcCalls: 7, httpCalls: 6, jiraItems: 2, confluenceItems: 3 },
          },
        } }),
        stderr: "Private provider details",
      };
    }, () => new Date(1_700_000_000_000 + tick++ * 1_000));

    expect(metrics.runs).toEqual([{
      id: "A1",
      status: "completed",
      durationMs: 1_000,
      markdownBytes: 51,
      complete: true,
      counts: { ptcCalls: 7, httpCalls: 6, jiraItems: 2, confluenceItems: 3 },
    }]);
    const written = await readFile(join(input.outputDirectory, "metrics.json"), "utf8");
    expect(written).not.toContain("Private question");
    expect(written).not.toContain("PRIVATEPROJ");
    expect(written).not.toContain("PRIVATESPACE");
    expect(written).not.toContain("Private report title");
    expect(written).not.toContain("Private provider details");
    expect(await readFile(join(input.outputDirectory, "A1.run.log"), "utf8"))
      .toBe("Private provider details");
  });

  test("persists a sanitized failure metric without reading a missing report", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-private-suite-"));
    roots.push(root);
    const input = parseResearchPrivateSuiteCliArguments([
      "--suite", join(root, "suite.json"),
      "--output-dir", join(root, "artifacts"),
    ], "/repository");
    const metrics = await runResearchPrivateSuite(input, suite, async () => ({
      exitCode: 1,
      stdout: "private failed provider response",
      stderr: "private failed provider details",
    }), () => new Date(1_700_000_000_000));

    expect(metrics.runs).toEqual([{
      id: "A1",
      status: "failed",
      durationMs: 0,
      markdownBytes: 0,
    }]);
    const written = await readFile(join(input.outputDirectory, "metrics.json"), "utf8");
    expect(written).not.toContain("private failed provider");
    expect(await readFile(join(input.outputDirectory, "A1.run.log"), "utf8"))
      .toBe("private failed provider details");
  });
});
