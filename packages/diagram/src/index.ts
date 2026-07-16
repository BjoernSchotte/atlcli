/**
 * `@atlcli/diagram` — mermaid → SVG rendering (spec 005a Task 2).
 *
 * A deliberately **format-agnostic adapter**: this package knows nothing
 * about DOCX, PDF or any export container. It turns mermaid source into a
 * themed SVG string; each export path then embeds that SVG its own way —
 * DOCX as svgBlip + rasterized PNG fallback (`@atlcli/docx`, spec 005a),
 * PDF natively as vector (spec 007). Keep it that way: no OOXML, no zip,
 * no rasterization in here.
 *
 * `renderDiagram` renders via
 * [`beautiful-mermaid`](https://github.com/lukilabs/beautiful-mermaid) — a
 * self-contained renderer (own parser/layout/text metrics, **not** mermaid.js)
 * that is synchronous, DOM-free and MV3-CSP-clean (no `eval`/`new Function`;
 * its elkjs layout runs the in-process FakeWorker, never a real `Worker`).
 *
 * The module is isomorphic and follows the docx `highlight.ts` lazy pattern:
 * beautiful-mermaid (+ its ~1.5 MB elkjs dependency) is only reached through a
 * dynamic `import()`, so hosts that never see a mermaid block never load the
 * chunk. Diagram-type detection runs BEFORE that import — a page with only
 * unsupported diagram types (Gantt, Pie, …) also skips the chunk entirely.
 *
 * Nothing here throws: every outcome is a {@link DiagramRenderResult}, and the
 * caller routes non-`svg` results to its own fallback (the DOCX path uses the
 * spec-004 pinned code block).
 */

/**
 * Diagram color theme (spec 005a Task 4). `bg` + `fg` are the two base
 * values; beautiful-mermaid derives the full scheme from them via
 * `color-mix()`. The optional roles override single derivations so the
 * diagram can match the export's brand colors exactly.
 */
export interface DiagramTheme {
  /** Background color (CSS color, e.g. `#FFFFFF`). */
  bg: string;
  /** Foreground / primary text color. */
  fg: string;
  /** Edge/connector color. */
  line?: string;
  /** Arrow heads, highlights. */
  accent?: string;
  /** Secondary text, edge labels. */
  muted?: string;
  /** Node/box fill tint. */
  surface?: string;
  /** Node/group stroke color. */
  border?: string;
  /** Font family for all diagram text. */
  font?: string;
}

/**
 * The default theme when no brand colors are configured: beautiful-mermaid's
 * zinc-light palette (white background, near-black text), which matches the
 * export's github-light code blocks and neutral body text.
 */
export const DEFAULT_DIAGRAM_THEME: DiagramTheme = { bg: "#FFFFFF", fg: "#27272A" };

export type DiagramRenderResult =
  | {
      kind: "svg";
      svg: string;
      /** Intrinsic pixel size from the SVG root (layout-computed, rounded up). */
      widthPx: number;
      heightPx: number;
    }
  | { kind: "unsupported"; diagramType: string }
  | { kind: "failed"; reason: string };

/**
 * Diagram types beautiful-mermaid renders, keyed by the first token of the
 * mermaid header line. Values are normalized headers: `classDiagram-v2` is
 * mermaid's alias for the same class-diagram grammar, but beautiful-mermaid
 * only accepts the unsuffixed header, so the token is rewritten.
 */
const SUPPORTED_HEADERS: Record<string, string | null> = {
  graph: null,
  flowchart: null,
  stateDiagram: null,
  "stateDiagram-v2": null,
  sequenceDiagram: null,
  classDiagram: null,
  "classDiagram-v2": "classDiagram",
  erDiagram: null,
  xychart: null,
  "xychart-beta": null,
};

/** Human-readable names for known-but-unsupported mermaid diagram types. */
const UNSUPPORTED_TYPES: Record<string, string> = {
  gantt: "Gantt",
  pie: "Pie",
  mindmap: "Mindmap",
  timeline: "Timeline",
  gitGraph: "Git graph",
  journey: "User journey",
  quadrantChart: "Quadrant chart",
  requirementDiagram: "Requirement",
  C4Context: "C4",
  C4Container: "C4",
  C4Component: "C4",
  C4Dynamic: "C4",
  C4Deployment: "C4",
  "sankey-beta": "Sankey",
  "block-beta": "Block",
  "packet-beta": "Packet",
  kanban: "Kanban",
  "architecture-beta": "Architecture",
  zenuml: "ZenUML",
  radar: "Radar",
};

/**
 * Split mermaid source into (optional YAML frontmatter, body): mermaid allows
 * a leading `---\ntitle: …\n---` block, which beautiful-mermaid's header check
 * rejects — the body is what gets type-detected and rendered.
 */
function stripFrontmatter(source: string): string {
  const m = source.match(/^\s*---\r?\n[\s\S]*?\r?\n\s*---\s*\r?\n/);
  return m ? source.slice(m[0].length) : source;
}

/**
 * The first meaningful line's leading token — skipping blank lines and `%%`
 * comment/directive lines — or `null` for effectively-empty source.
 */
function headerToken(body: string): string | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*)/);
    return m ? m[1] : line;
  }
  return null;
}

import { flattenSvgStyles } from "./svg-flatten.js";

// Exported for consumers that bring their own SVG (the PDF path can flatten
// any diagram SVG to the portable subset) and for direct unit testing.
export { flattenSvgStyles } from "./svg-flatten.js";

type BeautifulMermaid = typeof import("beautiful-mermaid");

let rendererPromise: Promise<BeautifulMermaid> | null = null;

/** Lazy-load beautiful-mermaid exactly once (the `highlight.ts` pattern). */
function loadRenderer(): Promise<BeautifulMermaid> {
  if (!rendererPromise) rendererPromise = import("beautiful-mermaid");
  return rendererPromise;
}

/**
 * Start loading the renderer chunk (~1.5 MB with elkjs) in the background —
 * a host that knows an export is likely (the extension panel on mount, say)
 * calls this so the FIRST diagram render doesn't pay the import. Never
 * throws and never rejects; a failed warm just means {@link renderDiagram}
 * retries the import itself.
 */
export function warmDiagramRenderer(): void {
  void loadRenderer().catch(() => {
    rendererPromise = null;
  });
}

/** Intrinsic pixel size from the SVG root's width/height attributes. */
function intrinsicSize(svg: string): { widthPx: number; heightPx: number } | null {
  const w = svg.match(/<svg[^>]*\bwidth="([\d.]+)"/)?.[1];
  const h = svg.match(/<svg[^>]*\bheight="([\d.]+)"/)?.[1];
  const widthPx = Math.ceil(Number(w));
  const heightPx = Math.ceil(Number(h));
  if (!w || !h || !widthPx || !heightPx || !Number.isFinite(widthPx) || !Number.isFinite(heightPx)) {
    return null;
  }
  return { widthPx, heightPx };
}

/**
 * Render mermaid `source` to a themed SVG string, or say why it can't be:
 * a known-unsupported diagram type is reported **by name** (`unsupported`,
 * without ever loading the renderer chunk); a parse/layout error is `failed`.
 * Never throws.
 */
export async function renderDiagram(
  source: string,
  theme: DiagramTheme = DEFAULT_DIAGRAM_THEME
): Promise<DiagramRenderResult> {
  const body = stripFrontmatter(source);
  const token = headerToken(body);
  if (!token) return { kind: "failed", reason: "the diagram source is empty" };

  const unsupported = UNSUPPORTED_TYPES[token];
  if (unsupported) return { kind: "unsupported", diagramType: unsupported };

  if (!(token in SUPPORTED_HEADERS)) {
    return { kind: "failed", reason: `unrecognized diagram type "${token}"` };
  }

  const normalizedHeader = SUPPORTED_HEADERS[token];
  const input = normalizedHeader
    ? body.replace(new RegExp(`^(\\s*)${token}`, "m"), `$1${normalizedHeader}`)
    : body;

  try {
    const { renderMermaidSVG } = await loadRenderer();
    // Flattening resolves the CSS custom properties / color-mix() /
    // class rules into literal attributes — Word's svgBlip renderer (and
    // the PDF path's SVG consumers) don't support them, and dropping the
    // <style> blocks also removes the external Google-Fonts @import.
    const svg = flattenSvgStyles(renderMermaidSVG(input, { ...theme }));
    const size = intrinsicSize(svg);
    if (!size) return { kind: "failed", reason: "the rendered SVG has no usable intrinsic size" };
    return { kind: "svg", svg, ...size };
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
