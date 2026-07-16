/**
 * Regression: highlighting must be deterministic from the FIRST call
 * (spec 006 Task 4 prerequisite). Shiki's JavaScript regex engine compiles
 * grammar rules lazily, and before the warmup in `highlightCode` the first
 * tokenize after `loadLanguage` merged tokens differently than every later
 * call (`1;` as one token, then `1` + `;` forever after) — which broke
 * golden-file equality between the first and second export in a process.
 */
import { describe, expect, it } from "bun:test";
import { highlightCode } from "./highlight.js";

describe("highlightCode determinism", () => {
  it("returns identical tokens on the first and every subsequent call", async () => {
    const code = "const x = 1;\nexport function f(): number { return x; }";
    const first = await highlightCode(code, "ts");
    const second = await highlightCode(code, "ts");
    expect(first).toEqual(second);
    // The steady-state shape: number and punctuation are separate tokens.
    const line0 = first.lines[0].map((t) => t.text);
    expect(line0).toContain("1");
    expect(line0).toContain(";");
  });
});
