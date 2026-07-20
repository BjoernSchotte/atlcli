/**
 * Regression tests for the M1 acceptance corpus (spec 011, Benchmarks). The
 * corpus is the integrated product story (tree scope + labels + scroll macros +
 * Jira table + diagram macro). These lock its determinism and shape so a change
 * to any upstream fixture or parser surfaces as a golden-digest diff, not a
 * silent drift in what "M1 acceptance" actually exercises.
 *
 * Pure over the corpus JSON (no engine compile) — fast and version-independent.
 * The engine exports are proven byte-stable (deterministic) in
 * `run-m1-acceptance.ts`, which pins absolute PDF/DOCX bytes only within a run
 * (they depend on the pinned Typst wasm + font versions — see PLAN Risks).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  buildM1Corpus,
  composeM1Document,
  corpusBlockCount,
  labelledPageCount,
  M1_CORPUS_PAGES,
  M1_CORPUS_VERSION,
} from "@atlcli/export-fixtures";

/** Structural golden — a stable sha256 of the corpus node JSON. */
const M1_CORPUS_DIGEST = "bbf961b1b9267dd53949649ff812705a4f356bcc76f470ceb2359352b72d176c";

describe("M1 acceptance corpus", () => {
  it("is deterministic: same version → byte-identical JSON", async () => {
    const a = await buildM1Corpus();
    const b = await buildM1Corpus();
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
  });

  it("has the pinned page / block / label counts", async () => {
    const corpus = await buildM1Corpus();
    expect(corpus.version).toBe(M1_CORPUS_VERSION);
    expect(corpus.nodes.length).toBe(M1_CORPUS_PAGES);
    expect(corpusBlockCount(corpus)).toBe(172);
    expect(labelledPageCount(corpus)).toBe(16);
  });

  it("matches the golden structural digest", async () => {
    const corpus = await buildM1Corpus();
    const digest = createHash("sha256").update(JSON.stringify(corpus.nodes)).digest("hex");
    expect(digest).toBe(M1_CORPUS_DIGEST);
  });

  it("carries the integrated story: a Jira table + a floored diagram + scroll orientation", async () => {
    const corpus = await buildM1Corpus();
    const flat = corpus.nodes.flatMap((n) => n.blocks);
    expect(flat.some((b) => b.type === "table")).toBe(true); // Jira render
    expect(flat.some((b) => b.type === "orientation")).toBe(true); // scroll-landscape
    expect(flat.some((b) => b.type === "pageBreak")).toBe(true); // scroll-pagebreak
    expect(flat.some((b) => b.type === "unknown")).toBe(true); // draw.io floor
    expect(corpus.macroNotes.map((n) => n.code)).toContain("macro-rendered-via");
    expect(corpus.macroNotes.map((n) => n.code)).toContain("macro-degraded");
  });

  it("composes into a single document with no warning notes", async () => {
    const corpus = await buildM1Corpus();
    const composed = composeM1Document(corpus);
    expect(composed.blocks.length).toBeGreaterThan(corpusBlockCount(corpus));
    const warnings = composed.notes.filter((n) => n.level === "warning").map((n) => n.code);
    expect(warnings).toEqual([]);
  });
});
