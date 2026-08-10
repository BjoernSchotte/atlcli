import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildResearchMultiTurnCliCommand,
  normalizeResearchMultiTurnOutputDirectory,
  parseResearchMultiTurnCliArguments,
  researchMultiTurnReportPath,
  runResearchMultiTurnHarness,
} from "./research-multi-turn.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("research CLI multi-turn live harness", () => {
  test("fixes scope, deadline, and total cost only on the first process", () => {
    const input = parseResearchMultiTurnCliArguments([
      "--output-dir", "/tmp/atlcli-research-multi-turn",
      "--question", "What is the current delivery status?",
      "--question", "Which earlier evidence supports that status?",
      "--project", "ATLCLI,SECOND",
      "--space", "DOCSY",
      "--max-run-minutes", "7",
      "--max-cost-usd", "0.75",
    ]);
    const first = buildResearchMultiTurnCliCommand(input, 1, undefined, "/tmp/atlcli-repository");
    const second = buildResearchMultiTurnCliCommand(input, 2, "research-session:fixed", "/tmp/atlcli-repository");

    expect(first).toContain("--conditions=development");
    expect(first.filter((value) => value === "--project")).toHaveLength(2);
    expect(first).toContain("--max-cost-usd");
    expect(first).toContain("0.75");
    expect(first).toContain("--max-run-minutes");
    expect(second).toContain("--session");
    expect(second).toContain("research-session:fixed");
    expect(second).not.toContain("--project");
    expect(second).not.toContain("--space");
    expect(second).not.toContain("--max-cost-usd");
    expect(second).not.toContain("--max-run-minutes");
  });

  test("rejects an unsafe output location and unbounded question set", () => {
    expect(() => normalizeResearchMultiTurnOutputDirectory("relative"))
      .toThrow("absolute");
    expect(() => normalizeResearchMultiTurnOutputDirectory("/repo/output", "/repo"))
      .toThrow("outside the repository");
    expect(() => parseResearchMultiTurnCliArguments([
      "--output-dir", "/tmp/research",
      "--question", "Only one question",
    ])).toThrow("at least twice");
    expect(() => parseResearchMultiTurnCliArguments([
      "--output-dir", "/tmp/research",
      "--question", "One",
      "--question", "Two",
      "--max-cost-usd", "25.01",
    ])).toThrow("at most 25");
  });

  test("runs isolated process turns against one returned session and checks every Markdown artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-multi-turn-"));
    roots.push(root);
    const input = parseResearchMultiTurnCliArguments([
      "--output-dir", root,
      "--question", "First bounded question",
      "--question", "Second bounded question",
      "--question", "Third bounded question",
      "--max-cost-usd", "0.50",
    ]);
    const commands: string[][] = [];
    const result = await runResearchMultiTurnHarness(input, async (command, turn) => {
      commands.push([...command]);
      await writeFile(
        researchMultiTurnReportPath(root, turn),
        `# Synthetic turn ${turn}\n\n## Sources\n\nNo synthetic sources.\n`,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ sessionId: "research-session:scripted-multi-turn" }),
      };
    });

    expect(result).toEqual({
      sessionId: "research-session:scripted-multi-turn",
      reportPaths: [
        researchMultiTurnReportPath(root, 1),
        researchMultiTurnReportPath(root, 2),
        researchMultiTurnReportPath(root, 3),
      ],
    });
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("--max-cost-usd");
    expect(commands.slice(1).every((command) => command.includes("--session"))).toBe(true);
  });

  test("stops if a later process does not retain the first session identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-multi-turn-"));
    roots.push(root);
    const input = parseResearchMultiTurnCliArguments([
      "--output-dir", root,
      "--question", "First bounded question",
      "--question", "Second bounded question",
    ]);
    await expect(runResearchMultiTurnHarness(input, async (_command, turn) => {
      await writeFile(
        researchMultiTurnReportPath(root, turn),
        `# Synthetic turn ${turn}\n\n## Sources\n\nNo synthetic sources.\n`,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ sessionId: `research-session:unexpected-${turn}` }),
      };
    })).rejects.toThrow("changed its durable session ID");
  });
});
