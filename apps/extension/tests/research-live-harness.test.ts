import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSanitizedLiveResearchMetricsV1,
  normalizeLiveResearchOutputPath,
  parseLiveResearchHarnessArguments,
  writeLiveResearchMarkdownArtifact,
} from "../scripts/research-agent-live-mayflower.js";
import type { ResearchReportV1 } from "../utils/research/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function privateReport(): ResearchReportV1 {
  return {
    schema: "atlcli.research-report/v1",
    title: "Private title",
    question: "Private question",
    scope: {
      siteOrigin: "https://private.invalid",
      jiraProjectKeys: ["PRIVATE"],
      confluenceSpaceKeys: ["SECRET"],
    },
    executiveSummary: "Private summary",
    findings: [{
      id: "finding-1",
      classification: "fact",
      summary: "Private finding",
      sourceIds: ["source-1"],
    }],
    relationships: [],
    limitations: ["Private limitation"],
    sources: [{
      id: "source-1",
      product: "jira",
      title: "Private source",
      url: "https://private.invalid/browse/PRIVATE-1",
    }],
    run: {
      model: "claude-sonnet-4-6",
      wikiProvider: "rest",
      startedAt: "2026-07-31T10:00:00.000Z",
      completedAt: "2026-07-31T10:01:00.000Z",
      durationMs: 60_000,
      complete: true,
      counts: {
        ptcCalls: 3,
        httpCalls: 4,
        jiraItems: 2,
        confluenceItems: 1,
      },
      usage: { inputTokens: 100, outputTokens: 50 },
      warnings: ["Private warning"],
    },
    markdown: "# Private report\n",
  };
}

describe("local live research characterization harness", () => {
  test("parses an explicit output, question, and one-to-ten-minute timeout", () => {
    expect(
      parseLiveResearchHarnessArguments([
        "--output",
        "/tmp/report.md",
        "--question=What changed?",
        "--max-run-minutes",
        "7",
      ]),
    ).toEqual({
      outputPath: "/tmp/report.md",
      question: "What changed?",
      maxRunMinutes: 7,
    });
    expect(() => parseLiveResearchHarnessArguments([])).toThrow("--output is required");
    expect(() =>
      parseLiveResearchHarnessArguments([
        "--output=/tmp/report.md",
        "--max-run-minutes=11",
      ])
    ).toThrow("integer from 1 to 10");
    expect(() =>
      parseLiveResearchHarnessArguments([
        "--output=/tmp/report.md",
        "--api-key=forbidden",
      ])
    ).toThrow("Unknown option");
  });

  test("requires an absolute Markdown path outside the repository", () => {
    expect(() => normalizeLiveResearchOutputPath("report.md", "/repo")).toThrow(
      "absolute path",
    );
    expect(() => normalizeLiveResearchOutputPath("/repo/private/report.md", "/repo"))
      .toThrow("outside the repository");
    expect(() => normalizeLiveResearchOutputPath("/tmp/report.txt", "/repo"))
      .toThrow(".md extension");
    expect(normalizeLiveResearchOutputPath("/tmp/report.md", "/repo")).toBe(
      "/tmp/report.md",
    );
  });

  test("creates a private new Markdown artifact and refuses overwrite", async () => {
    const repositoryRoot = await temporaryDirectory("atlcli-live-repo-");
    const artifactRoot = await temporaryDirectory("atlcli-live-artifact-");
    const outputPath = join(artifactRoot, "nested", "report.md");
    expect(
      await writeLiveResearchMarkdownArtifact(
        outputPath,
        "# Report\n",
        repositoryRoot,
      ),
    ).toBe(outputPath);
    expect(await readFile(outputPath, "utf8")).toBe("# Report\n");
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    await expect(
      writeLiveResearchMarkdownArtifact(outputPath, "overwrite", repositoryRoot),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  test("emits aggregate metrics without report, scope, source, or warning text", () => {
    const metrics = buildSanitizedLiveResearchMetricsV1(
      privateReport(),
      [
        { tool: "jira.issue.search", inputKind: "search", outcome: "success" },
        { tool: "jira.issue.search", inputKind: "search", outcome: "success" },
        { tool: "wiki.page.get", inputKind: "detail", outcome: "error" },
      ],
      [
        {
          role: "wiki-retrieval",
          status: "started",
          uniqueTask: true,
        },
        {
          role: "wiki-retrieval",
          status: "completed",
          uniqueTask: true,
          durationMs: 42,
          errorMessage: "Private subagent message",
        },
      ],
    );
    expect(metrics).toMatchObject({
      schema: "atlcli.research-live-characterization/v1",
      complete: true,
      sourceCount: 1,
      findingCount: 1,
      relationshipCount: 0,
      limitationCount: 1,
      warningCount: 1,
      ptcDiagnostics: [
        {
          tool: "jira.issue.search",
          inputKind: "search",
          outcome: "success",
          count: 2,
        },
        {
          tool: "wiki.page.get",
          inputKind: "detail",
          outcome: "error",
          count: 1,
        },
      ],
      subagentDiagnostics: [
        {
          role: "wiki-retrieval",
          status: "completed",
          count: 1,
          totalDurationMs: 42,
        },
        {
          role: "wiki-retrieval",
          status: "started",
          count: 1,
          totalDurationMs: 0,
        },
      ],
    });
    const serialized = JSON.stringify(metrics);
    for (const privateText of [
      "Private question",
      "PRIVATE",
      "SECRET",
      "private.invalid",
      "Private source",
      "Private warning",
      "Private report",
      "Private subagent message",
    ]) {
      expect(serialized).not.toContain(privateText);
    }
  });
});
