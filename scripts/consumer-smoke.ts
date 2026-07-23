#!/usr/bin/env bun
/**
 * Consumer smoke (spec 009, Consumer smoke) — tarball-install suite + the
 * shared machinery used by the filesystem-link and Node-LTS suites.
 *
 * Everything here is real: real `bun pm pack` tarballs, real installs
 * (transitive third-party deps come from the public registry, `@atlcli/*`
 * only ever from the local tarballs/dirs via `overrides`), real DOCX bytes
 * through `runExport`, real PDF bytes through `runPdfExport` +
 * `BrowserPdfCompiler` with the vendored wasm. No mocks, no registry
 * publish.
 */
import { Glob } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface PublishablePackage {
  name: string;
  dir: string;
}

/** Publishable set, derived from the fail-closed atlcli.publish classification. */
export function publishablePackages(): PublishablePackage[] {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  const out: PublishablePackage[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    for (const rel of new Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as {
        name?: string;
        atlcli?: { publish?: string };
      };
      if (manifest.atlcli?.publish && manifest.name) {
        out.push({ name: manifest.name, dir: join(repoRoot, dirname(rel)) });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The transitive `@atlcli/*` dependency closure of the given package names,
 * derived from the real manifests — never a hardcoded list, so new internal
 * dependency edges (e.g. pdf → export-macros) are picked up automatically.
 */
export function atlcliClosure(rootNames: string[]): string[] {
  const byName = new Map(publishablePackages().map((p) => [p.name, p.dir]));
  const seen = new Set<string>();
  const queue = [...rootNames];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    const dir = byName.get(name);
    if (!dir) throw new Error(`${name} is not in the publishable set`);
    seen.add(name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dep.startsWith("@atlcli/")) queue.push(dep);
    }
  }
  return [...seen].sort();
}

export function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function must(res: { exitCode: number; stdout: string; stderr: string }, what: string): void {
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${res.exitCode}):\n${res.stdout}\n${res.stderr}`);
  }
}

/** Build the publishable packages (dist + vendored wasm) via turbo. */
export function buildPackages(): void {
  must(
    run(
      ["bunx", "turbo", "run", "build", "--filter=./packages/*", "--output-logs=errors-only"],
      repoRoot,
    ),
    "turbo run build --filter=./packages/*",
  );
}

/** `bun pm pack` every publishable package into `destDir`; returns name → tarball path. */
export function packAll(destDir: string): Map<string, string> {
  mkdirSync(destDir, { recursive: true });
  const tarballs = new Map<string, string>();
  for (const pkg of publishablePackages()) {
    const pkgDest = join(destDir, pkg.name.replace(/[^a-z0-9-]/gi, "_"));
    mkdirSync(pkgDest, { recursive: true });
    must(run(["bun", "pm", "pack", "--destination", pkgDest], pkg.dir), `bun pm pack ${pkg.name}`);
    const tgz = readdirSync(pkgDest).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`no tarball produced for ${pkg.name} in ${pkgDest}`);
    tarballs.set(pkg.name, join(pkgDest, tgz));
  }
  return tarballs;
}

/**
 * DOCX smoke — plain .mjs so the same file runs under Bun AND plain Node.
 * Asserts dist (not src) resolution, drives `storageToBlocks` from the
 * installed confluence package, builds a minimal real template via the
 * installed `./fixtures` subpath, runs a real `runExport`, and unzips the
 * result to assert the heading landed in word/document.xml.
 */
export const DOCX_SMOKE_MJS = `
import { runExport } from "@atlcli/docx";
import { buildDocx, para, readPart } from "@atlcli/docx/fixtures";
import { unzipDocx } from "@atlcli/docx/scan";
import { storageToBlocks } from "@atlcli/confluence";

const resolved = import.meta.resolve("@atlcli/docx");
if (!resolved.includes("/dist/")) {
  throw new Error(\`@atlcli/docx resolved to \${resolved} — expected the built dist/ output\`);
}

const storage = "<h1>Smoke Heading</h1><p>Consumer smoke body with <code>INLINE_SMOKE</code>.</p>";

// The installed converter must produce a real block tree.
const { blocks, notes } = storageToBlocks(storage);
if (!Array.isArray(blocks) || blocks.length < 2) {
  throw new Error(\`storageToBlocks produced \${blocks?.length} blocks, expected >= 2\`);
}
if (!Array.isArray(notes)) throw new Error("storageToBlocks returned no notes array");

const templateBytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });

let outBytes;
const report = await runExport(
  {
    details: {
      id: "9001",
      title: "Smoke Page",
      url: "https://example.invalid/wiki/spaces/SMOKE/pages/9001",
      version: 1,
      spaceKey: "SMOKE",
      storage,
      created: "2026-07-01T08:00:00.000Z",
      modified: "2026-07-02T09:00:00.000Z",
      createdBy: { displayName: "Smoke Author" },
      modifiedBy: { displayName: "Smoke Editor" },
      labels: [],
    },
    template: { name: "smoke.docx", modificationDate: new Date("2026-07-10T00:00:00.000Z") },
    exportDate: new Date("2026-07-15T10:00:00.000Z"),
  },
  {
    templates: { getBytes: async () => templateBytes },
    output: {
      // DOCX's OutputSink still hands over a Uint8Array. Only the PDF sink
      // moved to a PdfBytesHandle (spec 010, T5.6) — see pdf-smoke.mjs.
      emit: async (_name, bytes) => {
        outBytes = bytes;
      },
    },
  },
);

if (!outBytes || outBytes.length < 1000) {
  throw new Error(\`export emitted \${outBytes?.length ?? 0} bytes — not a plausible docx\`);
}
// Valid zip magic (PK\\x03\\x04) and the fixture heading inside the document part.
if (outBytes[0] !== 0x50 || outBytes[1] !== 0x4b) throw new Error("output is not a zip archive");
const documentXml = readPart(outBytes, "word/document.xml");
if (!documentXml.includes("Smoke Heading")) {
  throw new Error("word/document.xml does not contain the fixture heading");
}
if (!documentXml.includes("Consumer smoke body with")) {
  throw new Error("word/document.xml does not contain the fixture paragraph");
}
if (!documentXml.includes('w:rFonts w:ascii="JetBrains Mono"')) {
  throw new Error("word/document.xml does not select the portable code face");
}
const zip = unzipDocx(outBytes);
const fontTable = zip.file("word/fontTable.xml")?.asText() ?? "";
const embeddedCodeFont =
  zip.file("word/fonts/atlcli-code-001b70dc-aa60-4ad5-90ec-18a0948e1eae.odttf")
    ?.asUint8Array();
if (!fontTable.includes('w:name="JetBrains Mono"') || embeddedCodeFont?.byteLength !== 273900) {
  throw new Error("the installed package did not embed its complete DOCX code font");
}
console.log("DOCX_SMOKE_OK", report.filename);
`;

/**
 * PDF smoke — plain .mjs for Bun AND Node. Wasm comes from the installed
 * package's `./wasm` subpath, fonts from the installed `@atlcli/pdf/fonts/*`
 * subpaths (both resolved against the CONSUMER's node_modules via
 * import.meta.resolve), compiled through the installed BrowserPdfCompiler.
 *
 * It also exercises the `PdfOutputSink.emit` contract itself (spec 010, T5.6):
 * the sink is handed a `PdfBytesHandle`, not a `Uint8Array`, and this fixture
 * walks BOTH representations a real host asks for — `asUint8Array()` (the Node
 * sink: write to disk) and `asBlob()`/`objectUrl()` (the browser/Forge sink:
 * hand to a download). Nothing else in the repo proves the handle works from a
 * consumer's position against the BUILT package.
 */
export const PDF_SMOKE_MJS = `
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPdfExport, isPdfBytesHandle, PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import { validatePdfOutput } from "@atlcli/pdf/internal";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { storageToBlocks } from "@atlcli/confluence";

for (const spec of ["@atlcli/pdf", "@atlcli/pdf-compiler-browser"]) {
  const resolved = import.meta.resolve(spec);
  if (!resolved.includes("/dist/")) {
    throw new Error(\`\${spec} resolved to \${resolved} — expected the built dist/ output\`);
  }
}

const packageBytes = (specifier) =>
  new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve(specifier))));

const wasm = packageBytes("@atlcli/pdf-compiler-browser/wasm");
const fonts = PDF_RUNTIME_ASSETS.fonts.map((font) =>
  packageBytes(\`@atlcli/pdf/fonts/\${font.fileName}\`),
);
const compiler = new BrowserPdfCompiler({
  wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  fonts,
});

const { blocks } = storageToBlocks("<h1>Smoke Heading</h1><p>PDF consumer smoke.</p>");

let emitted;
const report = await runPdfExport(
  {
    blocks,
    metadata: {
      title: "Smoke PDF",
      space: "SMOKE",
      version: 1,
      exportedAt: new Date("2026-07-15T10:00:00.000Z"),
    },
    filename: "smoke.pdf",
  },
  {
    assets: {
      resolve: async () => {
        throw new Error("the smoke fixture has no external assets");
      },
    },
    compiler,
    output: {
      // The signature a real Node host writes since spec 010 T5.6: the second
      // argument is a PdfBytesHandle. (The DOCX OutputSink above still takes a
      // Uint8Array — the asymmetry is deliberate, not an oversight.)
      emit: async (_name, handle) => {
        emitted = handle;
      },
    },
  },
);

if (!emitted) throw new Error("runPdfExport emitted nothing");

// --- The emit contract itself, checked with the guard the package exports ---
// Every assertion below reads the handle's API; if emit() ever hands over raw
// bytes again this is what has to notice, so it comes first.
if (!isPdfBytesHandle(emitted)) {
  throw new Error(
    "PdfOutputSink.emit did not hand over a PdfBytesHandle (spec 010, T5.6) — got " +
      (ArrayBuffer.isView(emitted) ? "a " + emitted.constructor.name : typeof emitted),
  );
}
if (emitted.mimeType !== "application/pdf") {
  throw new Error(\`handle mimeType is "\${emitted.mimeType}", expected application/pdf\`);
}

// --- Node sink path: asUint8Array() ---
const outBytes = await emitted.asUint8Array();
if (!(outBytes instanceof Uint8Array)) throw new Error("asUint8Array() did not return a Uint8Array");
if (emitted.size !== outBytes.byteLength) {
  throw new Error(\`handle.size \${emitted.size} != asUint8Array().byteLength \${outBytes.byteLength}\`);
}
const magic = String.fromCharCode(...outBytes.slice(0, 5));
if (magic !== "%PDF-") throw new Error(\`bad magic bytes: \${magic}\`);
const inspection = validatePdfOutput(outBytes);
if (!inspection.tagged || inspection.pageCount < 1) {
  throw new Error(\`invalid pdf structure: \${JSON.stringify(inspection)}\`);
}
// Borrowed, not copied — the point of the handle. Two calls hand back the SAME
// object, so a large document is never materialized twice side by side.
if ((await emitted.asUint8Array()) !== outBytes) {
  throw new Error("asUint8Array() copied the document instead of lending it");
}

// --- Download path: asBlob() ---
const blob = await emitted.asBlob();
if (blob.size !== emitted.size) {
  throw new Error(\`blob.size \${blob.size} != handle.size \${emitted.size}\`);
}
if (blob.type !== "application/pdf") throw new Error(\`blob.type is "\${blob.type}"\`);
if ((await emitted.asBlob()) !== blob) {
  throw new Error("asBlob() built a second copy instead of memoizing");
}
const fromBlob = new Uint8Array(await blob.arrayBuffer());
if (fromBlob.byteLength !== outBytes.byteLength) {
  throw new Error(\`blob carries \${fromBlob.byteLength} bytes, array carries \${outBytes.byteLength}\`);
}
if (String.fromCharCode(...fromBlob.slice(0, 5)) !== "%PDF-") {
  throw new Error("the blob does not carry the compiled PDF");
}

// --- Browser handoff: objectUrl(), or the documented refusal without it ---
if (typeof globalThis.URL?.createObjectURL === "function") {
  const url = await emitted.objectUrl();
  if (!url.startsWith("blob:")) throw new Error(\`objectUrl() returned "\${url}"\`);
  if ((await emitted.objectUrl()) !== url) {
    throw new Error("objectUrl() minted a second URL — the first one leaked");
  }
  emitted.release();
  const reminted = await emitted.objectUrl();
  if (reminted === url) throw new Error("objectUrl() handed back a URL release() revoked");
  emitted.release();
} else {
  let refused = false;
  await emitted.objectUrl().catch(() => {
    refused = true;
  });
  if (!refused) throw new Error("objectUrl() resolved without URL.createObjectURL");
}

console.log("PDF_SMOKE_OK", report?.filename ?? "smoke.pdf", "pages=" + inspection.pageCount);
`;

/** Type-consumption fixture: real imports from the four packages. */
export const TYPECHECK_MAIN_TS = `
import {
  runExport,
  type ExportEnv,
  type RunExportInput,
  type ExportReport,
  type TemplateSource,
  type OutputSink,
} from "@atlcli/docx";
import {
  runPdfExport,
  isPdfBytesHandle,
  pdfBytesFromUint8Array,
  PDF_RUNTIME_ASSETS,
  type PdfExportEnv,
  type RunPdfExportInput,
  type PdfCompilePort,
  type PdfCompileResult,
  type PdfOutputSink,
  type PdfBytesHandle,
} from "@atlcli/pdf";
import { storageToBlocks, type ExportBlock, type ExportNote } from "@atlcli/confluence";
import {
  BrowserPdfCompiler,
  type BrowserPdfCompilerAssets,
} from "@atlcli/pdf-compiler-browser";
import { resolveMacroBlocks } from "@atlcli/export-macros";
import { packTemplate, unpackTemplate, type TemplateManifest } from "@atlcli/template-pack";
import { nodePdfEnv, nodeDocxEnv, bundledDefaultTemplate } from "@atlcli/export-node";
import {
  createPdfExportJobExecutor,
  createTypescriptDocxExportJobExecutor,
} from "@atlcli/export-wiring/jobs";
// The remaining Node-compatible packages: type-check their barrels too, so
// the skipLibCheck:false proof covers every package the engines matrix
// marks Node-compatible (jira is deliberately absent — Bun-only).
import { getActiveProfile } from "@atlcli/core";
import { renderDiagram, type DiagramRenderResult } from "@atlcli/diagram";
import type { AtlcliPlugin } from "@atlcli/plugin-api";

const converted: { blocks: ExportBlock[]; notes: ExportNote[] } = storageToBlocks("<p>t</p>");

// A consumer must be able to NAME the emit contract, not merely receive it:
// a typed PdfOutputSink written against the barrel's own PdfBytesHandle type
// (spec 010, T5.6). This compiles under NodeNext with skipLibCheck:false, so
// it also proves the handle's .d.ts closure resolves for an external project.
const pdfSink: PdfOutputSink = {
  async emit(_name: string, bytes: PdfBytesHandle, context?: { signal?: AbortSignal }): Promise<void> {
    context?.signal?.throwIfAborted();
    const array: Uint8Array = await bytes.asUint8Array();
    const blob: Blob = await bytes.asBlob();
    const url: string = await bytes.objectUrl();
    const bytesLength: number = bytes.size;
    const mime: string = bytes.mimeType;
    bytes.release();
    void [array.byteLength, blob.size, url.length, bytesLength, mime, isPdfBytesHandle(bytes)];
  },
};
// If emit() ever went back to taking a Uint8Array, this assignment would stop
// compiling — the consumer type-check is the mutation detector for the type
// half of the contract, as the .mjs fixtures are for the runtime half.
const emittedByteShape: Parameters<PdfOutputSink["emit"]>[1] = pdfBytesFromUint8Array(
  new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
);
const surfaces: unknown[] = [
  runExport satisfies (input: RunExportInput, env: ExportEnv) => Promise<ExportReport>,
  runPdfExport,
  BrowserPdfCompiler,
  PDF_RUNTIME_ASSETS.fonts.length,
  converted.blocks.length,
  getActiveProfile,
  renderDiagram,
  resolveMacroBlocks,
  packTemplate,
  unpackTemplate,
  nodePdfEnv,
  nodeDocxEnv,
  bundledDefaultTemplate,
  createPdfExportJobExecutor,
  createTypescriptDocxExportJobExecutor,
  pdfSink,
  emittedByteShape,
];
const _extraTypes: [DiagramRenderResult, AtlcliPlugin, TemplateManifest] | null = null;
void _extraTypes;
const _envParts: [TemplateSource, OutputSink, PdfExportEnv, PdfCompilePort, PdfCompileResult, RunPdfExportInput, BrowserPdfCompilerAssets] | null = null;
void surfaces;
void _envParts;
export {};
`;

/**
 * The BASELINE-DESIGN §A5 batteries-included story, against the INSTALLED
 * packages: tree → composeChapters → runPdfExport(nodePdfEnv) to a real PDF
 * file, plus the zero-setup default-template DOCX path through nodeDocxEnv.
 * Plain .mjs — runs under Bun AND plain Node.
 */
export const EXPORT_NODE_SMOKE_MJS = `
import { readFileSync } from "node:fs";
import { fetchExportTree, composeChapters } from "@atlcli/confluence";
import { runPdfExport } from "@atlcli/pdf";
import { validatePdfOutput } from "@atlcli/pdf/internal";
import { runExport } from "@atlcli/docx";
import { readPart } from "@atlcli/docx/fixtures";
import { confluenceTreeSource, nodeDocxEnv, nodePdfEnv } from "@atlcli/export-node";

const resolved = import.meta.resolve("@atlcli/export-node");
if (!resolved.includes("/dist/")) {
  throw new Error(\`@atlcli/export-node resolved to \${resolved} — expected the built dist/ output\`);
}

const profile = {
  name: "smoke",
  baseUrl: "https://example.invalid",
  auth: { type: "apiToken", email: "smoke@example.invalid", token: "unused" },
};

// confluenceTreeSource(profile) must build the client-backed port (no network here).
const liveSource = confluenceTreeSource(profile);
if (typeof liveSource.getPage !== "function") throw new Error("confluenceTreeSource is not a TreeSource");

// A5 flow with an in-memory TreeSource (a legitimate port per the contract).
const pages = {
  "123": { title: "Handbook", storage: "<h1>Welcome</h1><p>Smoke handbook root.</p>", children: ["124"] },
  "124": { title: "Install Guide", storage: "<h1>Install</h1><p>Chapter two.</p>", children: [] },
};
const source = {
  getPage: async (id) => ({ id, title: pages[id].title, storage: pages[id].storage, version: 1, labels: [] }),
  getChildren: async (ref) =>
    (pages[ref.id]?.children ?? []).map((id, index) => ({
      id, title: pages[id].title, kind: "page", position: index, observedVersion: 1,
    })),
  getPageVersion: async (id) => ({ version: 1, title: pages[id].title }),
  getSpaceHomepageId: async () => null,
};

const tree = await fetchExportTree(source, { kind: "tree", rootPageId: "123" }, {});
if (!tree.complete) throw new Error("tree fetch incomplete");
const doc = composeChapters(tree.nodes);

await runPdfExport(
  { blocks: doc.blocks, metadata: { title: "Handbook", exportedAt: new Date("2026-07-15T10:00:00.000Z") }, filename: "handbook.pdf" },
  nodePdfEnv(profile, {
    outDir: ".",
    assets: { resolve: async () => { throw new Error("no assets in smoke"); } },
  }),
);
const pdf = new Uint8Array(readFileSync("handbook.pdf"));
if (String.fromCharCode(...pdf.slice(0, 5)) !== "%PDF-") throw new Error("bad pdf magic");
const inspection = validatePdfOutput(pdf);
if (!inspection.tagged || inspection.pageCount < 2) {
  throw new Error(\`invalid A5 pdf: \${JSON.stringify(inspection)}\`);
}

// Zero-setup DOCX: the bundled default template through nodeDocxEnv.
await runExport(
  {
    details: {
      id: "9002", title: "Default Template Smoke", url: "https://example.invalid/wiki/x",
      version: 1, spaceKey: "SMOKE", storage: "<h1>Smoke Heading</h1><p>Default template body.</p>",
      created: "2026-07-01T08:00:00.000Z", modified: "2026-07-02T09:00:00.000Z",
      createdBy: { displayName: "A" }, modifiedBy: { displayName: "B" }, labels: [],
    },
    template: { name: "default.docx", modificationDate: new Date("2026-07-10T00:00:00.000Z") },
    exportDate: new Date("2026-07-15T10:00:00.000Z"),
  },
  nodeDocxEnv({ outPath: "default-template.docx" }),
);
const docx = new Uint8Array(readFileSync("default-template.docx"));
if (!readPart(docx, "word/document.xml").includes("Smoke Heading")) {
  throw new Error("default-template docx missing the fixture heading");
}
console.log("EXPORT_NODE_SMOKE_OK", "pdfPages=" + inspection.pageCount);
`;

export interface ScaffoldOptions {
  /** dependency name → spec (file:… tarball or directory). */
  dependencies: Record<string, string>;
  /** Extra devDependencies (registry specs), e.g. typescript/@types/node. */
  devDependencies?: Record<string, string>;
  /** tsconfig moduleResolution — "bundler" (Bun/Vite-style) or "nodenext". */
  moduleResolution?: "bundler" | "nodenext";
}

/** Write the consumer project skeleton (manifest, tsconfig, smoke fixtures). */
export function scaffoldConsumer(dir: string, options: ScaffoldOptions): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name: "atlcli-smoke-consumer",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: options.dependencies,
    devDependencies: options.devDependencies ?? {},
    // `overrides` (bun + npm) and `pnpm.overrides` pin every transitive
    // `@atlcli/*` range to the same local artifacts, so internal ranges like
    // "@atlcli/core": "0.6.0" can never hit a registry (where they do not exist).
    overrides: options.dependencies,
    pnpm: { overrides: options.dependencies },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const nodenext = options.moduleResolution === "nodenext";
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: nodenext ? "NodeNext" : "ESNext",
      moduleResolution: nodenext ? "NodeNext" : "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
    },
    include: ["main.ts"],
  };
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  writeFileSync(join(dir, "main.ts"), TYPECHECK_MAIN_TS);
  writeFileSync(join(dir, "docx-smoke.mjs"), DOCX_SMOKE_MJS);
  writeFileSync(join(dir, "pdf-smoke.mjs"), PDF_SMOKE_MJS);
  if (options.dependencies["@atlcli/export-node"]) {
    writeFileSync(join(dir, "export-node-smoke.mjs"), EXPORT_NODE_SMOKE_MJS);
  }

  // Generic entrypoint smoke: every installed @atlcli/* package's `.` barrel
  // must import from its built dist and expose a non-empty surface. Generated
  // from the actual dependency list so newly classified packages are covered
  // automatically, with no hardcoded package list to forget.
  const names = Object.keys(options.dependencies).filter((n) => n.startsWith("@atlcli/"));
  writeFileSync(
    join(dir, "entrypoints-smoke.mjs"),
    `const names = ${JSON.stringify(names, null, 2)};
for (const name of names) {
  const resolved = import.meta.resolve(name);
  if (!resolved.includes("/dist/")) {
    throw new Error(\`\${name} resolved to \${resolved} — expected the built dist/ output\`);
  }
  const mod = await import(name);
  if (Object.keys(mod).length === 0) throw new Error(\`\${name} has no exports\`);
}
console.log("ENTRYPOINTS_SMOKE_OK", names.length);
`,
  );
}

/** Assert no installed @atlcli manifest still carries a workspace: range. */
export function assertNoWorkspaceLeak(dir: string): void {
  const scope = join(dir, "node_modules", "@atlcli");
  if (!existsSync(scope)) throw new Error(`${scope} missing — install did not produce @atlcli/*`);
  for (const entry of readdirSync(scope)) {
    const manifestPath = join(scope, entry, "package.json");
    if (!existsSync(manifestPath)) continue;
    const raw = readFileSync(manifestPath, "utf8");
    if (raw.includes('"workspace:')) {
      throw new Error(`workspace: range leaked into installed manifest ${manifestPath}`);
    }
  }
}

export interface SmokeRunResult {
  docx: string;
  pdf: string;
}

/** Run both smoke fixtures with the given runtime (["bun"] or ["node"]). */
export function runSmokes(
  dir: string,
  runtime: string[],
  env?: Record<string, string>,
): SmokeRunResult {
  const docx = run([...runtime, "docx-smoke.mjs"], dir, env);
  must(docx, `${runtime.join(" ")} docx-smoke.mjs`);
  if (!docx.stdout.includes("DOCX_SMOKE_OK")) {
    throw new Error(`docx smoke did not report success:\n${docx.stdout}\n${docx.stderr}`);
  }
  const pdf = run([...runtime, "pdf-smoke.mjs"], dir, env);
  must(pdf, `${runtime.join(" ")} pdf-smoke.mjs`);
  if (!pdf.stdout.includes("PDF_SMOKE_OK")) {
    throw new Error(`pdf smoke did not report success:\n${pdf.stdout}\n${pdf.stderr}`);
  }
  if (existsSync(join(dir, "export-node-smoke.mjs"))) {
    const exportNode = run([...runtime, "export-node-smoke.mjs"], dir, env);
    must(exportNode, `${runtime.join(" ")} export-node-smoke.mjs`);
    if (!exportNode.stdout.includes("EXPORT_NODE_SMOKE_OK")) {
      throw new Error(
        `export-node smoke did not report success:\n${exportNode.stdout}\n${exportNode.stderr}`,
      );
    }
  }
  return { docx: docx.stdout.trim(), pdf: pdf.stdout.trim() };
}

/** Run the generated entrypoints smoke (every installed @atlcli barrel from dist). */
export function runEntrypointsSmoke(
  dir: string,
  runtime: string[] = ["bun"],
  env?: Record<string, string>,
): void {
  const res = run([...runtime, "entrypoints-smoke.mjs"], dir, env);
  must(res, `${runtime.join(" ")} entrypoints-smoke.mjs`);
  if (!res.stdout.includes("ENTRYPOINTS_SMOKE_OK")) {
    throw new Error(`entrypoints smoke did not report success:\n${res.stdout}\n${res.stderr}`);
  }
}

/** Run the consumer-local tsc (installed by the consumer project itself). */
export function runConsumerTypecheck(dir: string): void {
  const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error(`typescript not installed in consumer at ${tsc}`);
  const res = run(["bun", tsc, "-p", "."], dir);
  must(res, "consumer tsc --noEmit (skipLibCheck: false)");
}

export const CONSUMER_DEV_DEPS = {
  typescript: "5.9.3",
  "@types/node": "25.0.5",
};

export interface TarballSmokeResult {
  projectDir: string;
  smokes: SmokeRunResult;
}

/**
 * The tarball-install suite: temp consumer project, all publishable tarballs
 * installed via bun with overrides, workspace-leak check, DOCX + PDF smokes
 * under Bun, and the skipLibCheck:false type-consumption check.
 */
export async function runTarballSmoke(baseDir?: string): Promise<TarballSmokeResult> {
  const workDir = baseDir ?? join(tmpdir(), `atlcli-consumer-smoke-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });

  buildPackages();
  const tarballs = packAll(join(workDir, "tarballs"));

  const projectDir = join(workDir, "consumer");
  const dependencies = Object.fromEntries(
    [...tarballs.entries()].map(([name, path]) => [name, `file:${path}`]),
  );
  scaffoldConsumer(projectDir, { dependencies, devDependencies: CONSUMER_DEV_DEPS });

  must(run(["bun", "install"], projectDir), "bun install (tarball consumer)");
  assertNoWorkspaceLeak(projectDir);

  runEntrypointsSmoke(projectDir);
  const smokes = runSmokes(projectDir, ["bun"]);
  runConsumerTypecheck(projectDir);
  return { projectDir, smokes };
}

if (import.meta.main) {
  const { projectDir, smokes } = await runTarballSmoke();
  console.log(`tarball consumer smoke OK in ${projectDir}`);
  console.log(smokes.docx);
  console.log(smokes.pdf);
}
