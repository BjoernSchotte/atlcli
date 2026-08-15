import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

const GAP_ANALYSIS = new URL(
  "../specs/export-gap-analysis-adf-notation/GAP-ANALYSIS.md",
  import.meta.url,
);

interface ProgressRegister {
  rows: string[];
  closed: number;
  open: number;
}

function parseProgressRegister(markdown: string): ProgressRegister {
  const lines = markdown.split("\n");
  const rows: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.startsWith("| Done |")) continue;

    index += 2;
    while (lines[index]?.startsWith("|")) {
      const row = lines[index]!;
      expect(row).toMatch(/^\| \[[ x]\] \|/);
      rows.push(row);
      index += 1;
    }
  }

  const closed = rows.filter((row) => row.startsWith("| [x] |")).length;
  return { rows, closed, open: rows.length - closed };
}

describe("ADF gap progress register", () => {
  it("keeps every progress-table row checkable and the orientation count exact", async () => {
    const markdown = await readFile(GAP_ANALYSIS, "utf8");
    const register = parseProgressRegister(markdown);
    const orientation = markdown.match(
      /Current matrix orientation: \*\*(\d+) of (\d+) rows closed; (\d+) rows? open\.\*\*/,
    );

    expect(orientation).not.toBeNull();
    expect(register.rows.length).toBeGreaterThan(0);
    expect(register).toMatchObject({
      closed: Number(orientation![1]),
      open: Number(orientation![3]),
    });
    expect(register.rows.length).toBe(Number(orientation![2]));
  });

  it("does not use Partial for locally actionable progress-table work", async () => {
    const markdown = await readFile(GAP_ANALYSIS, "utf8");
    const { rows } = parseProgressRegister(markdown);

    for (const row of rows.filter((candidate) => candidate.startsWith("| [ ] |"))) {
      expect(row).toMatch(/\b(?:Open|Partial)\b/);
      if (/\bPartial\b/.test(row)) {
        expect(row).toMatch(/\b(?:external|parallel)\b/i);
      }
    }
  });
});
