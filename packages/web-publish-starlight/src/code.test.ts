import { expect, test } from "bun:test";
import { resolveStarlightCodePresentationV1 } from "./code.js";

test("derives only fixed Expressive Code metadata from normalized code-block fields", () => {
  expect(resolveStarlightCodePresentationV1({
    type: "codeBlock", language: "TypeScript", code: "const answer = 42;", wrap: true, highlightLines: [3, 1],
  })).toEqual({ language: "typescript", languageLabel: "TypeScript", wrap: true, meta: "wrap {1,3}" });
});

test("falls back to text instead of passing a hostile language token to the highlighter", () => {
  expect(resolveStarlightCodePresentationV1({
    type: "codeBlock", language: "ts\"><script>", code: "safe",
  })).toEqual({ language: "text", languageLabel: "Text", wrap: false, meta: "" });
});
