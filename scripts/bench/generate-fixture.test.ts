/**
 * Determinism + shape regression tests for the benchmark fixture generator
 * (spec 011). Same seed → identical JSON; exact page/block/table counts. No IO,
 * no mocks — the generator is a pure function.
 */
import { describe, expect, it } from "bun:test";
import { generateBenchTree } from "./generate-fixture.js";

describe("generateBenchTree", () => {
  it("is deterministic: same seed produces byte-identical JSON", () => {
    const a = generateBenchTree({ pages: 60, seed: 123 });
    const b = generateBenchTree({ pages: 60, seed: 123 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("diverges on a different seed", () => {
    const a = generateBenchTree({ pages: 20, seed: 1 });
    const b = generateBenchTree({ pages: 20, seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("emits exactly the requested page count", () => {
    const fixture = generateBenchTree({ pages: 500, seed: 7 });
    expect(fixture.chapters).toHaveLength(500);
    expect(fixture.pages).toBe(500);
  });

  it("places a 200-row table on every 10th page", () => {
    const fixture = generateBenchTree({ pages: 30, seed: 7 });
    const tablePages = fixture.chapters.filter((c) =>
      c.blocks.some((b) => b.type === "table" && b.rows.length === 200),
    );
    // pages 10, 20, 30 → 3 tables in a 30-page fixture.
    expect(tablePages).toHaveLength(3);
  });

  it("places a code block + PNG attachment on every 25th page", () => {
    const fixture = generateBenchTree({ pages: 50, seed: 7 });
    const codePages = fixture.chapters.filter((c) => c.blocks.some((b) => b.type === "codeBlock"));
    expect(codePages).toHaveLength(2); // pages 25, 50
    for (const page of codePages) {
      expect(page.attachments.length).toBe(1);
      expect(page.blocks.some((b) => b.type === "image")).toBe(true);
    }
  });

  it("every attachment referenced by a block is listed on its chapter", () => {
    const fixture = generateBenchTree({ pages: 25, seed: 7 });
    const page25 = fixture.chapters[24];
    const imageBlock = page25.blocks.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    if (imageBlock && imageBlock.type === "image" && imageBlock.source.kind === "attachment") {
      expect(page25.attachments).toContain(imageBlock.source.filename);
    }
  });
});
