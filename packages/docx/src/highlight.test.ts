/**
 * Determinism and source-fidelity regressions for the active shared
 * highlighting package. The real-browser harness separately pins the
 * JavaScript-engine identity and cold/preloaded behavior.
 */
import { describe, expect, it } from "bun:test";
import {
  canonicalCodeLanguage,
  highlightCode,
  installCodeHighlightEngine,
  prepareCodeHighlighting,
  type CodeLanguageId,
} from "@atlcli/code-highlight";

const REPRESENTATIVE_LANGUAGES = [
  ["typescript", "const answer: number = 42;"],
  ["tsx", "export const App = () => <main>Hello</main>;"],
  ["javascript", "export const answer = 42;"],
  ["jsx", "export const App = () => <main>Hello</main>;"],
  ["json", '{"answer":42}'],
  ["python", "answer: int = 42"],
  ["java", "final int answer = 42;"],
  ["kotlin", "val answer: Int = 42"],
  ["csharp", "var answer = 42;"],
  ["go", "answer := 42"],
  ["rust", "let answer: i32 = 42;"],
  ["c", "int answer = 42;"],
  ["cpp", "const int answer = 42;"],
  ["php", "<?php $answer = 42;"],
  ["ruby", "answer = 42"],
  ["shellscript", "answer=42"],
  ["sql", "SELECT 42 AS answer;"],
  ["yaml", "answer: 42"],
  ["html", "<main>Hello</main>"],
  ["xml", "<answer>42</answer>"],
  ["css", "main { color: red; }"],
  ["markdown", "# Answer\n\n42"],
] as const;

describe("browser code highlighting", () => {
  it("canonicalizes representative aliases", () => {
    const aliases: Record<string, CodeLanguageId> = {
      ts: "typescript",
      js: "javascript",
      py: "python",
      cs: "csharp",
      rs: "rust",
      rb: "ruby",
      shell: "shellscript",
      sh: "shellscript",
      yml: "yaml",
      md: "markdown",
    };
    for (const [alias, canonical] of Object.entries(aliases)) {
      expect(canonicalCodeLanguage(alias)).toBe(canonical);
      expect(canonicalCodeLanguage(canonical)).toBe(canonical);
    }
    expect(canonicalCodeLanguage("definitely-unknown")).toBeUndefined();
  });

  it("preserves equivalent token output for an alias and canonical id", async () => {
    const code = "const x: number = 1;";
    const alias = await highlightCode(code, "ts");
    const canonical = await highlightCode(code, "typescript");
    expect(alias).toEqual(canonical);
  });

  it("returns identical tokens on the first and every subsequent call", async () => {
    const code = "const x = 1;\nexport function f(): number { return x; }";
    const first = await highlightCode(code, "ts");
    const second = await highlightCode(code, "ts");
    expect(first).toEqual(second);
    expect(first.lines.flat().some(({ color }) => color !== undefined)).toBeTrue();
  });

  it("preserves every trailing empty source line after highlighting", async () => {
    const result = await highlightCode("const x = 1;\n\n", "ts");
    expect(result.skipped).toBeNull();
    expect(result.lines).toHaveLength(3);
    expect(
      result.lines.map((line) => line.map((token) => token.text).join("")),
    ).toEqual(["const x = 1;", "", ""]);
  });

  it("preloads aliases concurrently and is idempotent when warm", async () => {
    const coldTimings: number[] = [];
    const warmTimings: number[] = [];
    await Promise.all([
      prepareCodeHighlighting(["py"], undefined, {
        onTiming: (timing) => coldTimings.push(timing.grammarLoadMs),
      }),
      prepareCodeHighlighting(["python"], undefined, {
        onTiming: (timing) => coldTimings.push(timing.grammarLoadMs),
      }),
    ]);
    await prepareCodeHighlighting(["py", "python"], undefined, {
      onTiming: (timing) => warmTimings.push(timing.grammarLoadMs),
    });
    expect(coldTimings.filter((duration) => duration > 0)).toHaveLength(1);
    expect(warmTimings).toEqual([0]);
  });

  it("highlights representative fixtures with exact source text", async () => {
    await prepareCodeHighlighting(
      REPRESENTATIVE_LANGUAGES.map(([language]) => language),
    );
    for (const [language, code] of REPRESENTATIVE_LANGUAGES) {
      const result = await highlightCode(code, language);
      expect(result.skipped, language).toBeNull();
      expect(
        result.lines
          .map((line) => line.map(({ text }) => text).join(""))
          .join("\n"),
        language,
      ).toBe(code);
      expect(
        result.lines.flat().some(({ color }) => color !== undefined),
        language,
      ).toBeTrue();
    }
  });

  it("rejects an engine switch after the first highlighter use", async () => {
    await highlightCode("const x = 1;", "typescript");
    expect(() =>
      installCodeHighlightEngine({
        id: "late-test-engine",
        create: () => {
          throw new Error("must not be called");
        },
      }),
    ).toThrow("Cannot switch the code-highlighting engine");
  });
});
