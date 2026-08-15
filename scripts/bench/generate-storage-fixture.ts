/**
 * END-TO-END-TIER fixture generator (spec 011, Benchmarks).
 *
 * Where `generate-fixture.ts` emits already-parsed `ExportBlock[]`, this
 * generator emits **Confluence storage XHTML** — the bytes the real pipeline
 * actually receives — plus an in-memory {@link TreeSource} that serves them.
 * That is the whole point of the second tier: storage parsing, macro
 * resolution, and the tree walk are exactly the costs the engine tier is blind
 * to, and they are not small.
 *
 * Deterministic: the same `(pages, seed)` always produces byte-identical
 * storage for every page, so a trend line moves because the code moved.
 *
 * Shape per page mirrors the engine fixture (3 headings, prose, a list; every
 * 10th page a 200-row table; every 25th a code block + an attachment image) and
 * adds the macro traffic the engine tier cannot have: `scroll-title` /
 * `scroll-pagebreak` (every 8th page), a resolvable Jira JQL macro (every 12th),
 * and a draw.io macro that settles on the placeholder floor (every 20th).
 *
 * Run: `bun scripts/bench/generate-storage-fixture.ts [--pages N] [--seed S]`
 * Emits `scripts/bench/out/storage-<pages>.json` (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TreeChild,
  TreeNodeRef,
  TreeSource,
  TreeSourcePage,
  TreeSourceVersion,
} from "@atlcli/confluence";

/** mulberry32 — the same tiny deterministic PRNG the engine fixture uses. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEXICON = [
  "export", "confluence", "document", "chapter", "section", "render", "engine",
  "typst", "docx", "parity", "fixture", "benchmark", "deterministic", "compose",
  "heading", "paragraph", "table", "diagram", "anchor", "orientation",
];

function words(rand: () => number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(LEXICON[Math.floor(rand() * LEXICON.length)]!);
  return out.join(" ");
}

/** The storage XHTML for one benchmark page. Pure over `(rand, pageNumber)`. */
export function benchPageStorage(rand: () => number, pageNumber: number): string {
  const parts: string[] = [];
  parts.push(`<h1>Chapter ${pageNumber}: ${words(rand, 3)}</h1>`);
  parts.push(`<p>${words(rand, 24 + Math.floor(rand() * 16))}</p>`);
  parts.push(`<h2>${words(rand, 3)}</h2>`);
  parts.push(`<p>${words(rand, 24 + Math.floor(rand() * 16))}</p>`);

  const items: string[] = [];
  const itemCount = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < itemCount; i++) items.push(`<li>${words(rand, 6)}</li>`);
  parts.push(`<ul>${items.join("")}</ul>`);

  parts.push(`<h3>${words(rand, 2)}</h3>`);
  parts.push(`<p>${words(rand, 24 + Math.floor(rand() * 16))}</p>`);

  if (pageNumber % 8 === 0) {
    parts.push(`<ac:structured-macro ac:name="scroll-pagebreak"/>`);
    parts.push(
      `<ac:structured-macro ac:name="scroll-title">` +
        `<ac:parameter ac:name="title">${words(rand, 2)}</ac:parameter>` +
        `<ac:parameter ac:name="type">table</ac:parameter>` +
        `<ac:rich-text-body><table><tbody><tr><th>Metric</th><th>Value</th></tr>` +
        `<tr><td>${words(rand, 1)}</td><td>${Math.floor(rand() * 1000)}</td></tr>` +
        `</tbody></table></ac:rich-text-body></ac:structured-macro>`,
    );
  }

  if (pageNumber % 10 === 0) {
    const rows: string[] = [`<tr><th>${words(rand, 1)}</th><th>${words(rand, 1)}</th><th>${words(rand, 1)}</th></tr>`];
    for (let r = 1; r < 200; r++) {
      rows.push(`<tr><td>${words(rand, 3)}</td><td>${words(rand, 3)}</td><td>${words(rand, 3)}</td></tr>`);
    }
    parts.push(`<table><tbody>${rows.join("")}</tbody></table>`);
  }

  if (pageNumber % 12 === 0) {
    parts.push(
      `<ac:structured-macro ac:name="jira">` +
        `<ac:parameter ac:name="jqlQuery">project = BENCH ORDER BY created</ac:parameter>` +
        `<ac:parameter ac:name="columns">key,summary,status</ac:parameter>` +
        `</ac:structured-macro>`,
    );
  }

  if (pageNumber % 20 === 0) {
    parts.push(
      `<ac:structured-macro ac:name="drawio">` +
        `<ac:parameter ac:name="diagramName">architecture-${pageNumber}</ac:parameter>` +
        `</ac:structured-macro>`,
    );
  }

  if (pageNumber % 25 === 0) {
    const lines: string[] = [];
    const lineCount = 8 + Math.floor(rand() * 8);
    for (let i = 0; i < lineCount; i++) lines.push(`const value_${i} = ${Math.floor(rand() * 1000)};`);
    parts.push(
      `<ac:structured-macro ac:name="code">` +
        `<ac:parameter ac:name="language">typescript</ac:parameter>` +
        `<ac:plain-text-body><![CDATA[${lines.join("\n")}]]></ac:plain-text-body>` +
        `</ac:structured-macro>`,
    );
    parts.push(
      `<ac:image ac:alt="bench figure ${pageNumber}">` +
        `<ri:attachment ri:filename="bench-asset-${pageNumber}.png"/></ac:image>`,
    );
  }

  return parts.join("");
}

export interface StorageBenchPage {
  id: string;
  title: string;
  storage: string;
  version: number;
  labels: string[];
}

export interface StorageBenchFixture {
  seed: number;
  pages: number;
  rootId: string;
  pageList: StorageBenchPage[];
}

/**
 * Generate `pages` storage-format pages: a root page plus `pages - 1` children
 * at depth 1. Every third child carries a label so the label-filter code path
 * has something to look at.
 */
export function generateStorageFixture(options: { pages?: number; seed?: number } = {}): StorageBenchFixture {
  const pages = options.pages ?? 500;
  const seed = options.seed ?? 0x9e3779b9;
  const rand = mulberry32(seed);
  const pageList: StorageBenchPage[] = [];
  for (let p = 0; p < pages; p++) {
    pageList.push({
      id: `bench-page-${p + 1}`,
      title: p === 0 ? "Benchmark Handbook" : `Chapter ${p + 1}`,
      storage: benchPageStorage(rand, p + 1),
      version: 1,
      labels: p > 0 && p % 3 === 0 ? ["bench-labeled"] : [],
    });
  }
  return { seed, pages, rootId: pageList[0]!.id, pageList };
}

/**
 * An in-memory {@link TreeSource} over a generated fixture. This is a real port
 * implementation, not a mock: `fetchExportTree` cannot tell it apart from the
 * REST-backed source, which is the point — the benchmark exercises the true
 * traversal + body-walk code path with the network removed so the number
 * measures our code rather than a tenant's latency.
 */
export function storageFixtureTreeSource(fixture: StorageBenchFixture): TreeSource {
  const byId = new Map(fixture.pageList.map((page) => [page.id, page]));
  return {
    async getPage(id: string): Promise<TreeSourcePage> {
      const page = byId.get(id);
      if (!page) throw new Error(`bench tree source: unknown page ${id}`);
      return {
        id: page.id,
        title: page.title,
        storage: page.storage,
        version: page.version,
        labels: page.labels,
        spaceKey: "BENCH",
      };
    },
    async getChildren(nodeRef: TreeNodeRef): Promise<TreeChild[]> {
      if (nodeRef.id !== fixture.rootId) return [];
      return fixture.pageList.slice(1).map((page, index) => ({
        id: page.id,
        title: page.title,
        kind: "page" as const,
        position: index,
        observedVersion: page.version,
      }));
    },
    async getPageVersion(id: string): Promise<TreeSourceVersion> {
      const page = byId.get(id);
      if (!page) throw new Error(`bench tree source: unknown page ${id}`);
      return { version: page.version, title: page.title };
    },
    async getSpaceHomepageId(): Promise<string> {
      return fixture.rootId;
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const pagesArg = args.indexOf("--pages");
  const seedArg = args.indexOf("--seed");
  const pages = pagesArg >= 0 ? Number(args[pagesArg + 1]) : 500;
  const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : undefined;

  const fixture = generateStorageFixture({ pages, seed });
  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "out", `storage-${pages}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture));
  const bytes = fixture.pageList.reduce((n, p) => n + p.storage.length, 0);
  process.stdout.write(
    `generate-storage-fixture: ${fixture.pages} pages, ${(bytes / 1024).toFixed(0)}KB storage → ${outPath}\n`,
  );
}

if (import.meta.main) main();
