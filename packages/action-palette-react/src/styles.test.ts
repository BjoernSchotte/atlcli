import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const stylesheet = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");

function mediaBlock(query: string): string {
  const start = stylesheet.indexOf(`@media (${query})`);
  if (start < 0) throw new Error(`Missing media query: ${query}`);

  const openingBrace = stylesheet.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < stylesheet.length; index += 1) {
    const token = stylesheet[index];
    if (token === "{") depth += 1;
    if (token === "}") depth -= 1;
    if (depth === 0) return stylesheet.slice(start, index + 1);
  }
  throw new Error(`Unclosed media query: ${query}`);
}

describe("host-agnostic palette styling", () => {
  test("snapshots reduced-motion and forced-colors contracts", () => {
    expect(mediaBlock("prefers-reduced-motion: reduce")).toMatchInlineSnapshot(`
"@media (prefers-reduced-motion: reduce) {
  .atlcli-action-palette-frame,
  .atlcli-action-palette-progress {
    animation-duration: 0.01ms;
    animation-iteration-count: 1;
  }

  .atlcli-action-palette-option {
    transition-duration: 0.01ms;
  }
}"
`);
    expect(mediaBlock("forced-colors: active")).toMatchInlineSnapshot(`
"@media (forced-colors: active) {
  .atlcli-action-palette-frame,
  .atlcli-action-palette-search-row,
  .atlcli-action-palette-footer,
  .atlcli-action-palette-option[data-active=\"true\"],
  .atlcli-action-palette-panel-actions button,
  .atlcli-action-palette-field input,
  .atlcli-action-palette-field textarea,
  .atlcli-action-palette-field select {
    border: 1px solid CanvasText;
    background: Canvas;
    color: CanvasText;
    box-shadow: none;
  }

  .atlcli-action-palette-option[data-active=\"true\"] {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }

  .atlcli-action-palette-primary,
  .atlcli-action-palette-status-mark {
    background: Highlight;
    color: HighlightText;
  }
}"
`);
  });

  test("uses logical directional properties and supports compact containers", () => {
    expect(stylesheet).toContain("@container atlcli-palette (max-width: 30rem)");
    expect(stylesheet).toContain("padding-inline:");
    expect(stylesheet).toContain("margin-inline:");
    expect(stylesheet).toContain("border-block-start:");
    expect(stylesheet).toContain("border-block-end:");
    expect(stylesheet).not.toMatch(/(?:margin|padding|border)-(?:left|right)\s*:/u);
  });

  test("has no remote resources or host-specific selectors", () => {
    expect(stylesheet).not.toMatch(/url\s*\(/u);
    expect(stylesheet).not.toMatch(/(?:chrome-extension|atlassian|forge|wxt)/iu);
  });
});
