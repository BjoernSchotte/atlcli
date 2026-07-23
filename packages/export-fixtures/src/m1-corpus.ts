/**
 * M1 acceptance corpus (spec 011, Benchmarks — the integrated product story).
 *
 * A versioned 50-page `ExportPageNode[]` tree assembled from the SAME building
 * blocks as harness cases 002/003/004: tree scope (a root + 49 chapters),
 * labels on a subset of pages, the `scroll-*` content macros (page break,
 * landscape, caption table), a live-Jira-table macro, Forge ADF block, bodied,
 * and inline extensions, and a draw.io diagram macro (settles on the
 * placeholder floor offline — no PNG bytes, so the corpus stays byte-stable and
 * tenant-free). This is the concrete evidence behind UMSETZUNGSPLAN's "CLI
 * **and** harness" M1 acceptance line — NOT the engine-only bench fixture,
 * which starts from raw blocks and skips parsing + macro resolution.
 *
 * `buildM1Corpus()` is deterministic (fixed content, no PRNG-dependent shape):
 * the same version always yields byte-identical JSON, so `corpusDigest` is a
 * stable golden. The corpus is committed here so it is neither tenant- nor
 * network-dependent; `scripts/bench/run-m1-acceptance.ts` runs it through
 * `composeChapters` → both engines and pins the exports.
 */
import {
  composeChapters,
  storageToBlocks,
  type ComposeResult,
  type ExportBlock,
  type ExportNote,
  type ExportPageNode,
} from "@atlcli/confluence/browser";
import { resolveMacroFixtureBlocks } from "./macro-fixtures.js";

export const M1_CORPUS_VERSION = 2 as const;
export const M1_CORPUS_PAGES = 50;

/** A compact scroll-macro story (small table — NOT the 200-row case fixture). */
const M1_SCROLL_STORAGE =
  `<p>Section overview.</p>` +
  `<ac:structured-macro ac:name="scroll-pagebreak"/>` +
  `<ac:structured-macro ac:name="scroll-title">` +
  `<ac:parameter ac:name="title">Measurements</ac:parameter>` +
  `<ac:parameter ac:name="type">table</ac:parameter>` +
  `<ac:rich-text-body><table><tbody><tr><th>Metric</th><th>Value</th></tr>` +
  `<tr><td>latency</td><td>12ms</td></tr><tr><td>throughput</td><td>900</td></tr></tbody></table>` +
  `</ac:rich-text-body></ac:structured-macro>` +
  `<ac:structured-macro ac:name="scroll-landscape">` +
  `<ac:rich-text-body><p>A wide landscape region.</p></ac:rich-text-body>` +
  `</ac:structured-macro>`;

function text(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function page(
  pageId: string,
  title: string,
  depth: number,
  position: number,
  parentId: string | null,
  blocks: ExportBlock[],
  labels: string[],
): ExportPageNode {
  return {
    kind: "page",
    pageId,
    title,
    depth,
    effectiveDepth: depth,
    parentId,
    position,
    blocks,
    notes: [],
    meta: { labels, spaceKey: "TEST" },
  };
}

export interface M1Corpus {
  version: number;
  nodes: ExportPageNode[];
  /** Resolution notes from the macro pages (informational; not part of the tree). */
  macroNotes: ExportNote[];
}

/**
 * Build the deterministic 50-page corpus. Async because the macro pages run the
 * REAL resolver pass once (the resolved blocks are cloned onto each macro page).
 */
export async function buildM1Corpus(): Promise<M1Corpus> {
  const scroll = storageToBlocks(M1_SCROLL_STORAGE, { exporter: "word" });
  const macro = await resolveMacroFixtureBlocks("docx");

  const nodes: ExportPageNode[] = [
    page("m1-root", "M1 Acceptance Handbook", 0, 0, null, [
      { type: "heading", level: 1, content: text("M1 Acceptance Handbook") },
      {
        type: "paragraph",
        content: text(
          "Integrated export story: tree scope, labels, scroll macros, a Jira table, and a diagram macro.",
        ),
      },
    ], []),
  ];

  for (let i = 1; i < M1_CORPUS_PAGES; i++) {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 1, content: text(`Chapter ${i}`) },
      { type: "paragraph", content: text(`Body of chapter ${i} in the acceptance corpus.`) },
    ];
    if (i % 4 === 0) blocks.push(...clone(scroll.blocks));
    if (i % 6 === 0) blocks.push(...clone(macro.blocks));
    const labels = i % 3 === 0 ? ["m1-labeled"] : [];
    nodes.push(page(`m1-page-${i}`, `Chapter ${i}`, 1, i - 1, "m1-root", blocks, labels));
  }

  return { version: M1_CORPUS_VERSION, nodes, macroNotes: macro.notes };
}

/** Compose the corpus into a single document (heading offsets + chapter breaks). */
export function composeM1Document(corpus: M1Corpus): ComposeResult {
  return composeChapters(corpus.nodes);
}

/** Count of pages that carry at least one label (the labelled subset). */
export function labelledPageCount(corpus: M1Corpus): number {
  return corpus.nodes.filter((n) => n.meta.labels.length > 0).length;
}

/** Total block count across the corpus (a stable structural invariant). */
export function corpusBlockCount(corpus: M1Corpus): number {
  return corpus.nodes.reduce((sum, n) => sum + n.blocks.length, 0);
}
