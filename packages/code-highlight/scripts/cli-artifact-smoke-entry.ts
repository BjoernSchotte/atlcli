import {
  getCodeHighlightEngineId,
  highlightCode,
} from "../src/index.js";

const result = await highlightCode(
  "const answer: number = 42;",
  "typescript",
  "github-light",
);
if (
  getCodeHighlightEngineId() !== "oniguruma" ||
  result.skipped !== null ||
  !result.lines.flat().some(({ color }) => color !== undefined)
) {
  throw new Error("compiled code-highlighting smoke failed");
}
console.log("CODE_HIGHLIGHT_CLI_OK");
