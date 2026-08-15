import { describe, expect, it } from "bun:test";
import { EDITABILITY_BUDGETS, assessEditability } from "./assess.js";
import { buildImportPreview } from "./preview.js";
import { parseDocx } from "./parse.js";
import { buildDocxFixture, p, r } from "./test-support.js";
import type { ImportBlock } from "./model.js";

function paragraphs(count: number, text: string): ImportBlock[] {
  return Array.from({ length: count }, () => ({
    type: "paragraph" as const,
    runs: [{ kind: "text" as const, text }],
  }));
}

describe("assessEditability", () => {
  it("rates a small document ok with exact metrics", () => {
    const doc = parseDocx(
      buildDocxFixture({ body: p(r("Title"), { style: "Heading1" }) + p(r("Body")) }),
    );
    const assessment = assessEditability(doc.blocks);
    expect(assessment.level).toBe("ok");
    expect(assessment.recommendation).toBeUndefined();
    expect(assessment.nodeCount).toBeGreaterThan(0);
    expect(assessment.adfBytes).toBeGreaterThan(0);
    expect(assessment.tableCells).toBe(0);
    expect(assessment.images).toBe(0);
  });

  it("escalates to caution past the node budget and recommends splitting", () => {
    const blocks = paragraphs(EDITABILITY_BUDGETS.caution.nodeCount, "x");
    const assessment = assessEditability(blocks);
    expect(assessment.level).toBe("caution");
    expect(assessment.recommendation).toContain("--split");
  });

  it("escalates to risk past the byte budget", () => {
    // Few nodes, huge payload: byte budget trips independently of node count.
    const blocks = paragraphs(100, "y".repeat(25_000));
    const assessment = assessEditability(blocks);
    expect(assessment.adfBytes).toBeGreaterThan(EDITABILITY_BUDGETS.risk.adfBytes);
    expect(assessment.level).toBe("risk");
  });

  it("counts table cells against their own budget", () => {
    const row = `<w:tr><w:tc>${p(r("a"))}</w:tc><w:tc>${p(r("b"))}</w:tc></w:tr>`;
    const doc = parseDocx(buildDocxFixture({ body: `<w:tbl>${row.repeat(3)}</w:tbl>` }));
    const assessment = assessEditability(doc.blocks);
    expect(assessment.tableCells).toBe(6);
  });

  it("is part of the import preview", async () => {
    const doc = parseDocx(buildDocxFixture({ body: p(r("tiny")) }));
    const preview = await buildImportPreview(doc, { spaceKey: "DOCSY", title: "T" });
    expect(preview.editability.level).toBe("ok");
  });
});
