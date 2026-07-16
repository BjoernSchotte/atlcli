/**
 * Regression tests for the Word E2E finding (spec 005a): beautiful-mermaid
 * SVGs style everything through CSS custom properties + color-mix() + class
 * rules, which Word's svgBlip renderer cannot resolve — diagrams rendered
 * all-black with missing arrowheads. Flattening must leave ONLY the portable
 * SVG subset: literal presentation attributes, no <style>, no var(), no
 * color-mix(). Runs against the REAL renderer output (no fixtures-only).
 */
import { describe, expect, it } from "bun:test";
import { flattenSvgStyles } from "./svg-flatten.js";
import { renderDiagram, type DiagramRenderResult } from "./index.js";

function svgOf(result: DiagramRenderResult): string {
  expect(result.kind).toBe("svg");
  return (result as Extract<DiagramRenderResult, { kind: "svg" }>).svg;
}

/** Every construct Word cannot resolve must be gone. */
function expectPortable(svg: string): void {
  expect(svg).not.toContain("var(");
  expect(svg).not.toContain("color-mix(");
  expect(svg).not.toContain("<style>");
  expect(svg).not.toContain("@import");
  expect(svg).not.toContain("--bg:");
}

describe("flattenSvgStyles — unit", () => {
  it("resolves var() chains, fallbacks and color-mix() into literal attributes", () => {
    const input =
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" style="--bg:#ffffff;--fg:#000000;background:var(--bg)">` +
      `<style>svg { --_line: var(--line, color-mix(in srgb, var(--fg) 50%, var(--bg))); }</style>` +
      `<line x1="0" y1="0" x2="9" y2="9" stroke="var(--_line)"/>` +
      `<rect fill="var(--fg)" width="4" height="4"/>` +
      `</svg>`;
    const out = flattenSvgStyles(input);
    expectPortable(out);
    expect(out).toContain('stroke="#808080"'); // 50% mix of black on white
    expect(out).toContain('fill="#000000"');
    // Background painted as a real rect (Word ignores CSS background).
    expect(out).toContain('<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>');
  });

  it("inlines class rules with CSS-over-attribute precedence and multi-class selectors", () => {
    const input =
      `<svg xmlns="http://www.w3.org/2000/svg" style="--bg:#ffffff;--fg:#000000">` +
      `<style>.bar { stroke-width: 1.5; } .bar.c0 { fill: var(--fg); } rect.c0 { opacity: 0.5; }</style>` +
      `<rect class="bar c0" fill="#123456" width="4" height="4"/>` +
      `<rect class="bar" fill="#123456" width="4" height="4"/>` +
      `</svg>`;
    const out = flattenSvgStyles(input);
    // The .bar.c0 rule REPLACES the fill attribute (CSS beats presentation attrs)…
    expect(out).toContain('fill="#000000"');
    expect(out).toContain('stroke-width="1.5"');
    expect(out).toContain('opacity="0.5"');
    // …but the rule-less second rect keeps its own fill.
    expect(out).toContain('fill="#123456"');
  });

  it("leaves non-CSS style attributes (style=\"solid\") untouched", () => {
    const input =
      `<svg xmlns="http://www.w3.org/2000/svg"><polyline style="solid" points="0,0 1,1"/></svg>`;
    expect(flattenSvgStyles(input)).toContain('style="solid"');
  });
});

describe("flattenSvgStyles — real renderer output (Word regression)", () => {
  it("flowchart: literal node fill / arrowhead colors, background rect, no <style>", async () => {
    const svg = svgOf(await renderDiagram("graph TD\n  A[Start] --> B[Done]"));
    expectPortable(svg);
    // Default theme (bg #FFFFFF, fg #27272A): node fill = 3% mix, arrow = 85% mix.
    expect(svg).toContain('fill="#f9f9f9"');
    expect(svg).toContain('fill="#47474a"'); // arrowhead marker — "keine Pfeile" fix
    expect(svg).toContain('fill="#FFFFFF"'); // background rect
    // Text carries the font stack as a literal attribute now.
    expect(svg).toMatch(/<text[^>]*font-family="/);
  });

  it("xychart: class-based series colors become literal stroke/fill", async () => {
    const svg = svgOf(
      await renderDiagram('xychart-beta\n  title "S"\n  x-axis [a, b]\n  bar [1, 2]')
    );
    expectPortable(svg);
    expect(svg).toContain('stroke="#3b82f6"'); // series 0 (accent fallback)
    expect(svg).toContain('fill="#cee0fd"'); // bar fill: 25% series color on white
  });

  it("every supported type flattens portable", async () => {
    const sources = [
      "stateDiagram-v2\n  [*] --> A\n  A --> [*]",
      "sequenceDiagram\n  A->>B: hi",
      "classDiagram\n  X <|-- Y",
      "erDiagram\n  A ||--o{ B : has",
    ];
    for (const source of sources) {
      expectPortable(svgOf(await renderDiagram(source)));
    }
  });

  it("theme overrides survive flattening as literals", async () => {
    const svg = svgOf(
      await renderDiagram("graph TD\n  A --> B", { bg: "#101820", fg: "#FEE715", accent: "#FF0000" })
    );
    expectPortable(svg);
    expect(svg).toContain('fill="#101820"'); // background rect
    expect(svg).toContain("#FEE715"); // text fill
    expect(svg).toContain('fill="#FF0000"'); // accent drives the arrowheads
  });
});
