#!/usr/bin/env bun
/**
 * Vite tarball smoke (spec 009, Consumer smoke).
 *
 * A throwaway Vite project (scaffolded in a scratch dir — NOT apps/extension
 * or the harness, which resolve `workspace:*`) installs the PACKED tarballs
 * and runs a production `vite build` with the same `browser` condition
 * preference the harness uses — and deliberately WITHOUT `development`, so
 * every resolution must come from the tarballs' dist/ exports.
 *
 * The entry imports `@atlcli/pdf-compiler-browser/wasm?url` and
 * `@atlcli/pdf/fonts/*.ttf?url` exactly like
 * apps/browser-export-harness/src/pdf-worker.ts, bundles the full compile
 * pipeline (runPdfExport + BrowserPdfCompiler + storageToBlocks) from the
 * installed packages, imports the background executor from the packed
 * `@atlcli/export-wiring/jobs` subpath (which also carries the DOCX engine's
 * package-relative JetBrains Mono face), and exposes a hook on globalThis. After
 * the build the driver asserts the `?url` imports resolved to real hashed files
 * in the build output (nothing falling through to a src/ path or workspace
 * symlink), then imports the PRODUCTION chunk under Bun (headless — a real
 * browser Worker adds nothing to the packaging proof) and compiles a fixture
 * to real, validated PDF bytes using the EMITTED wasm + font assets — through
 * the `PdfBytesHandle` the sink is handed since spec 010 T5.6, exercising the
 * `asBlob()`/`objectUrl()` half a browser host actually uses.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocx, para } from "../packages/docx/src/fixtures.js";
import {
  atlcliClosure,
  buildPackages,
  packAll,
  run,
  type SmokeRunResult,
} from "./consumer-smoke.js";

/** Browser DOCX/PDF roots plus background wiring; the transitive @atlcli
 * closure is derived from the real manifests (never a hardcoded list). */
const VITE_ROOTS = [
  "@atlcli/import-core",
  "@atlcli/import-pdf",
  "@atlcli/docx",
  "@atlcli/pdf",
  "@atlcli/pdf-compiler-browser",
  "@atlcli/export-wiring",
];
const DOCX_TEMPLATE_BYTES = buildDocx({
  body: para("$scroll.title") + para("$scroll.content"),
});
const PDF_IMPORT_FIXTURE_BYTES = readFileSync(
  join(import.meta.dir, "../specs/import-pdf-mvp/fixtures/complex-tagged.pdf"),
);
const PDF_IMPORT_UNTAGGED_FIXTURE_BYTES = readFileSync(
  join(import.meta.dir, "../specs/import-pdf-mvp/fixtures/simple-untagged.pdf"),
);
const PDFIUM_WASM_SHA256 = "c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8";

const VITE_VERSION = "8.1.4"; // same major the harness builds with

const INDEX_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>atlcli vite smoke</title></head>
  <body><script type="module" src="/src/entry.ts"></script></body>
</html>
`;

const VITE_CONFIG = `import { defineConfig } from "vite";
import { DOCX_BROWSER_VITE_DEFINES } from "@atlcli/docx/vite";

export default defineConfig({
  base: "./",
  resolve: {
    // Same preference as apps/browser-export-harness — but NO "development":
    // this build must prove the packed tarballs' dist/ exports.
    conditions: ["browser"],
  },
  define: {
    ...DOCX_BROWSER_VITE_DEFINES,
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
    // The modulepreload polyfill references \`document\` at import time; this
    // smoke executes the production chunk headlessly, and the polyfill is
    // irrelevant to the packaging contract under test.
    modulePreload: false,
  },
});
`;

/** Mirrors apps/browser-export-harness/src/pdf-worker.ts's ?url imports. */
const ENTRY_TS = `
// This must be the first DOCX-related edge: export-wiring/jobs also reaches
// the engine graph, so the canonical entry has to establish its runtime first.
import {
  memoryTemplateSource,
  runExport as runDocxExport,
  unzipDocx,
} from "@atlcli/docx/browser-entry";
import wasmUrl from "@atlcli/pdf-compiler-browser/wasm?url";
import pdfiumWasmUrl from "@atlcli/import-pdf/wasm?url";
import sansRegularUrl from "@atlcli/pdf/fonts/SourceSans3-Regular.ttf?url";
import sansItalicUrl from "@atlcli/pdf/fonts/SourceSans3-It.ttf?url";
import sansSemiBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Semibold.ttf?url";
import sansBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Bold.ttf?url";
import serifRegularUrl from "@atlcli/pdf/fonts/SourceSerif4-Regular.ttf?url";
import serifItalicUrl from "@atlcli/pdf/fonts/SourceSerif4-It.ttf?url";
import serifSemiBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Semibold.ttf?url";
import serifBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Bold.ttf?url";
import codeRegularUrl from "@atlcli/pdf/fonts/SourceCodePro-Regular.ttf?url";
import codeBoldUrl from "@atlcli/pdf/fonts/SourceCodePro-Bold.ttf?url";
import arabicRegularUrl from "@atlcli/pdf/fonts/NotoSansArabic-Regular.ttf?url";
import symbolsRegularUrl from "@atlcli/pdf/fonts/NotoSansSymbols2-Regular.ttf?url";
import emojiRegularUrl from "@atlcli/pdf/fonts/NotoEmoji-wght.ttf?url";
import { runPdfExport, isPdfBytesHandle, PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import type { PdfBytesHandle } from "@atlcli/pdf";
import { validatePdfOutput } from "@atlcli/pdf/internal";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { IMPORT_DOCUMENT_SCHEMA_V2, documentToAdf } from "@atlcli/import-core";
import {
  PDF_FACTS_SCHEMA_V1,
  PDF_FACTS_SCHEMA_V2,
  createBrowserPdfiumFactsAdapter,
  createBrowserPdfiumFactsAdapterV2,
  normalizeTaggedPdfFacts,
  normalizeUntaggedPdfFacts,
  preservePdfFigures,
} from "@atlcli/import-pdf/browser-worker";
import {
  createPageAttachmentWriterV1,
  storageToBlocks,
} from "@atlcli/confluence/browser";
import {
  createPdfExportJobExecutor,
  createTypescriptDocxExportJobExecutor,
} from "@atlcli/export-wiring/jobs";

const fontUrls: Record<string, string> = {
  "SourceSans3-Regular.ttf": sansRegularUrl,
  "SourceSans3-It.ttf": sansItalicUrl,
  "SourceSans3-Semibold.ttf": sansSemiBoldUrl,
  "SourceSans3-Bold.ttf": sansBoldUrl,
  "SourceSerif4-Regular.ttf": serifRegularUrl,
  "SourceSerif4-It.ttf": serifItalicUrl,
  "SourceSerif4-Semibold.ttf": serifSemiBoldUrl,
  "SourceSerif4-Bold.ttf": serifBoldUrl,
  "SourceCodePro-Regular.ttf": codeRegularUrl,
  "SourceCodePro-Bold.ttf": codeBoldUrl,
  "NotoSansArabic-Regular.ttf": arabicRegularUrl,
  "NotoSansSymbols2-Regular.ttf": symbolsRegularUrl,
  "NotoEmoji-wght.ttf": emojiRegularUrl,
};

type LoadBytes = (url: string) => Promise<Uint8Array>;

(globalThis as Record<string, unknown>).__ATLCLI_VITE_SMOKE = {
  importCoreProof:
    documentToAdf({ blocks: [] }).type === "doc" &&
    IMPORT_DOCUMENT_SCHEMA_V2 === "atlcli.import-document/2",
  importPdfProof:
    PDF_FACTS_SCHEMA_V1 === "atlcli.pdf-facts/1" &&
    PDF_FACTS_SCHEMA_V2 === "atlcli.pdf-facts/2" &&
    typeof createBrowserPdfiumFactsAdapter === "function" &&
    typeof createBrowserPdfiumFactsAdapterV2 === "function",
  wasmUrl,
  pdfiumWasmUrl,
  fontUrls,
  expectedFonts: PDF_RUNTIME_ASSETS.fonts.map((font) => font.fileName),
  jobsEntrypointLoaded:
    typeof createPdfExportJobExecutor === "function" &&
    typeof createTypescriptDocxExportJobExecutor === "function",
  async attachmentContract() {
    let calls = 0;
    let createPath = "";
    let contentTypeIntroduced = false;
    let authorizationIntroduced = false;
    let minorEdit = "";
    let fileSize = -1;
    const writer = createPageAttachmentWriterV1(async (path, init) => {
      calls++;
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      createPath = path;
      const headers = new Headers(init?.headers);
      contentTypeIntroduced = headers.has("Content-Type");
      authorizationIntroduced = headers.has("Authorization");
      const form = init?.body as FormData;
      minorEdit = String(form.get("minorEdit"));
      fileSize = (form.get("file") as File).size;
      return new Response(JSON.stringify({
        results: [{
          id: "packed-att-1",
          title: "packed.pdf",
          metadata: { mediaType: "application/pdf" },
          extensions: { fileSize },
          version: { number: 1 },
          _links: { download: "/download/attachments/123/packed.pdf" },
        }],
      }), { status: 200 });
    });
    const attachment = await writer.create({
      pageId: "123",
      filename: "packed.pdf",
      body: new Blob(["packed-pdf"], { type: "application/pdf" }),
      mimeType: "application/pdf",
    });
    return {
      calls,
      createPath,
      contentTypeIntroduced,
      authorizationIntroduced,
      minorEdit,
      fileSize,
      attachmentId: attachment.id,
    };
  },
  async compileDocx() {
    // Test setup injects a known-good binary fixture. The production consumer
    // imports only the stable browser entry, not the fixture subpath.
    const templateBytes = new Uint8Array(${JSON.stringify([...DOCX_TEMPLATE_BYTES])});
    let emitted: Uint8Array | undefined;
    const report = await runDocxExport(
      {
        details: {
          id: "browser-entry-smoke",
          title: "Combined Browser Entry",
          url: "https://example.invalid/wiki/browser-entry-smoke",
          version: 1,
          spaceKey: "SMOKE",
          storage: "<h1>Vite DOCX Heading</h1><p>One ordered browser entry.</p>",
          created: "2026-07-01T08:00:00.000Z",
          modified: "2026-07-02T09:00:00.000Z",
          createdBy: { displayName: "Smoke Author" },
          modifiedBy: { displayName: "Smoke Editor" },
          labels: [],
        },
        template: {
          name: "browser-entry-smoke.docx",
          modificationDate: new Date("2026-07-10T00:00:00.000Z"),
        },
        exportDate: new Date("2026-07-15T10:00:00.000Z"),
      },
      {
        templates: memoryTemplateSource(templateBytes),
        output: {
          emit: async (_name, bytes) => {
            emitted = bytes;
          },
        },
      },
    );
    if (!emitted) throw new Error("combined DOCX browser entry emitted nothing");
    const bytes: Uint8Array = emitted;
    const documentXml = unzipDocx(bytes).file("word/document.xml")?.asText() ?? "";
    return {
      byteLength: bytes.byteLength,
      filename: report.filename,
      hasHeading: documentXml.includes("Vite DOCX Heading"),
      hasBody: documentXml.includes("One ordered browser entry."),
    };
  },
  async analyzePdfImport(loadBytes: LoadBytes) {
    const fixtureBytes = new Uint8Array(${JSON.stringify([...PDF_IMPORT_FIXTURE_BYTES])});
    const pdfiumWasm = await loadBytes(pdfiumWasmUrl);
    const adapter = createBrowserPdfiumFactsAdapter({ wasmBinary: pdfiumWasm });
    const result = await adapter.analyze(fixtureBytes);
    const resultV2 = await createBrowserPdfiumFactsAdapterV2({ wasmBinary: pdfiumWasm })
      .analyze(fixtureBytes);
    const semantics = await normalizeTaggedPdfFacts(result.facts, result.factsDigest);
    const figures = await preservePdfFigures(
      result.facts,
      result.factsDigest,
      fixtureBytes,
      adapter,
      semantics,
    );
    const untaggedFixtureBytes = new Uint8Array(${JSON.stringify([...PDF_IMPORT_UNTAGGED_FIXTURE_BYTES])});
    const untaggedResult = await adapter.analyze(untaggedFixtureBytes);
    const untaggedSemantics = await normalizeUntaggedPdfFacts(
      untaggedResult.facts,
      untaggedResult.factsDigest,
    );
    const taggedTable = semantics.document.blocks.find((block) => block.type === "table");
    return {
      pageCount: result.facts.pageCount,
      complete: result.facts.completeness.complete,
      classification: result.facts.classification,
      engine: result.facts.provenance.engine,
      wasmSha256: result.facts.provenance.wasmSha256,
      factsDigest: result.factsDigest,
      factsSchemaV2: resultV2.facts.schema,
      factsDigestV2: resultV2.factsDigest,
      semanticDigest: semantics.semanticDigest,
      figureSemanticDigest: figures.semanticDigest,
      titleCandidate: semantics.document.titleCandidate,
      blockTypes: semantics.document.blocks.map((block) => block.type),
      figureBlockTypes: figures.document.blocks.map((block) => block.type),
      figureCount: figures.figures.length,
      figureAssetCount: figures.document.assets.length,
      figureModes: figures.figures.map((figure) => figure.mode),
      figureAuthorAlt: figures.figures.every((figure) => figure.authorAlt),
      taggedTableRows: taggedTable?.type === "table" ? taggedTable.rows.length : 0,
      taggedTableCells: taggedTable?.type === "table"
        ? taggedTable.rows.reduce((count, row) => count + row.cells.length, 0)
        : 0,
      taggedTableHeaders: taggedTable?.type === "table"
        ? taggedTable.rows.flatMap((row) => row.cells).filter((cell) => cell.header).length
        : 0,
      untaggedTitleCandidate: untaggedSemantics.document.titleCandidate,
      untaggedBlockTypes: untaggedSemantics.document.blocks.map((block) => block.type),
      untaggedFallbackPages: untaggedSemantics.requiresFallbackPages,
      untaggedSemanticDigest: untaggedSemantics.semanticDigest,
    };
  },
  async compile(loadBytes: LoadBytes) {
    const wasm = await loadBytes(wasmUrl);
    const fonts = await Promise.all(
      PDF_RUNTIME_ASSETS.fonts.map((font) => loadBytes(fontUrls[font.fileName])),
    );
    const compiler = new BrowserPdfCompiler({
      wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
      fonts,
    });
    const { blocks } = storageToBlocks("<h1>Vite Smoke Heading</h1><p>Bundled tarball compile.</p>");
    // Since spec 010 T5.6 the sink is handed a PdfBytesHandle, not a
    // Uint8Array. This is the BROWSER position, where the handle's reason for
    // existing lives: the download path wants a Blob/object URL and must get
    // one without the whole document being materialized a second time.
    let emitted: PdfBytesHandle | undefined;
    await runPdfExport(
      {
        blocks,
        metadata: { title: "Vite Smoke", exportedAt: new Date("2026-07-15T10:00:00.000Z") },
        filename: "vite-smoke.pdf",
      },
      {
        assets: {
          resolve: async () => {
            throw new Error("the vite smoke fixture has no external assets");
          },
        },
        compiler,
        output: {
          emit: async (_name: string, handle: PdfBytesHandle) => {
            emitted = handle;
          },
        },
      },
    );
    if (!emitted) throw new Error("runPdfExport emitted nothing");
    const handle: PdfBytesHandle = emitted;
    // The guard travels in the bundled browser barrel too; a revert to raw
    // bytes fails here rather than three assertions later with a stranger error.
    const isHandle = isPdfBytesHandle(handle);
    if (!isHandle) {
      throw new Error("PdfOutputSink.emit did not hand over a PdfBytesHandle (spec 010, T5.6)");
    }
    const bytes = await handle.asUint8Array();
    const borrowed = (await handle.asUint8Array()) === bytes;
    const blob = await handle.asBlob();
    const blobMemoized = (await handle.asBlob()) === blob;
    const objectUrl = await handle.objectUrl();
    const urlMemoized = (await handle.objectUrl()) === objectUrl;
    const inspection = validatePdfOutput(bytes);
    const result = {
      byteLength: bytes.byteLength,
      handleSize: handle.size,
      mimeType: handle.mimeType,
      pageCount: inspection.pageCount,
      tagged: inspection.tagged,
      isHandle,
      borrowed,
      blobSize: blob.size,
      blobType: blob.type,
      blobMemoized,
      objectUrlScheme: objectUrl.slice(0, 5),
      urlMemoized,
    };
    handle.release();
    return result;
  },
};
`;

export interface ViteSmokeResult {
  projectDir: string;
  viteVersion: string;
  smokes: SmokeRunResult;
}

async function withBrowserBufferScope<T>(action: () => Promise<T>): Promise<T> {
  // The built chunk is imported under Bun only to keep this smoke headless.
  // Mask Bun's Node-compatible Buffer global while PizZip detects its host so
  // the bundle executes the same Uint8Array path as an actual browser.
  const scope = globalThis as Record<string, unknown>;
  const originalBuffer = scope.Buffer;
  scope.Buffer = undefined;
  try {
    return await action();
  } finally {
    scope.Buffer = originalBuffer;
  }
}

export async function runViteSmoke(baseDir?: string): Promise<ViteSmokeResult> {
  const workDir = baseDir ?? join(tmpdir(), `atlcli-vite-smoke-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });

  buildPackages();
  const tarballs = packAll(join(workDir, "tarballs"));

  const projectDir = join(workDir, "consumer");
  mkdirSync(join(projectDir, "src"), { recursive: true });

  const dependencies: Record<string, string> = {};
  for (const name of atlcliClosure(VITE_ROOTS)) {
    const tarball = tarballs.get(name);
    if (!tarball) throw new Error(`${name} was not packed`);
    dependencies[name] = `file:${tarball}`;
  }
  const manifest = {
    name: "atlcli-vite-smoke-consumer",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies,
    devDependencies: { vite: VITE_VERSION },
    overrides: dependencies,
    pnpm: { overrides: dependencies },
  };
  writeFileSync(join(projectDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(projectDir, "index.html"), INDEX_HTML);
  writeFileSync(join(projectDir, "vite.config.mjs"), VITE_CONFIG);
  writeFileSync(join(projectDir, "src", "entry.ts"), ENTRY_TS);

  const install = run(["bun", "install"], projectDir);
  if (install.exitCode !== 0) {
    throw new Error(`bun install (vite consumer) failed:\n${install.stdout}\n${install.stderr}`);
  }

  // Production build, executed with plain node like an ordinary Vite user.
  const build = run(["node", "node_modules/vite/bin/vite.js", "build"], projectDir);
  if (build.exitCode !== 0) {
    throw new Error(`vite build failed:\n${build.stdout}\n${build.stderr}`);
  }

  // --- Assert the ?url contract against the actual build output. ---
  const distDir = join(projectDir, "dist");
  const assetsDir = join(distDir, "assets");
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];

  const wasmAssets = assets.filter((a) => a.endsWith(".wasm"));
  const ttfAssets = assets.filter((a) => a.endsWith(".ttf"));
  if (wasmAssets.length !== 2) {
    throw new Error(
      `expected exactly two hashed .wasm assets (Typst and PDFium), found: ${wasmAssets.join(", ")}`,
    );
  }

  const javaScriptAssets = assets.filter((asset) => asset.endsWith(".js"));
  for (const asset of javaScriptAssets) {
    const source = readFileSync(join(assetsDir, asset), "utf8");
    if (
      /engine-oniguruma/i.test(asset) ||
      source.includes("findNextOnigScannerMatch") ||
      source.includes("Must invoke loadWasm first.")
    ) {
      throw new Error(
        `packed browser consumer emitted an Oniguruma/Shiki-WASM chunk: ${asset}`,
      );
    }
  }
  const chunkName = javaScriptAssets.find((asset) =>
    readFileSync(join(assetsDir, asset), "utf8").includes("__ATLCLI_VITE_SMOKE"),
  );
  if (!chunkName) {
    throw new Error(
      `no built entry chunk installed __ATLCLI_VITE_SMOKE; inspected: ${javaScriptAssets.join(", ")}`,
    );
  }
  const chunkPath = join(assetsDir, chunkName);
  const chunkSource = readFileSync(chunkPath, "utf8");
  // Nothing may fall through to a source path or workspace symlink: the
  // production chunk must reference only its own hashed ./assets/ files.
  for (const forbidden of ["/src/index", "workspace:", "node_modules/@atlcli"]) {
    if (chunkSource.includes(forbidden)) {
      throw new Error(`production chunk references "${forbidden}" — tarball resolution fell through`);
    }
  }
  for (const [name, pattern] of [
    ["eval", /(?:^|[^\w$.])eval\s*\(/m],
    ["new Function", /\bnew\s+Function\s*\(/m],
    ["PDFium CDN", /cdn\.jsdelivr\.net\/npm\/@embedpdf\/pdfium/i],
  ] as const) {
    if (pattern.test(chunkSource)) {
      throw new Error(`production browser chunk contains forbidden ${name}`);
    }
  }

  // --- Execute the PRODUCTION chunk and compile with the EMITTED assets. ---
  const { hook, docxResult, attachmentResult } = await withBrowserBufferScope(async () => {
    await import(chunkPath);
    const hook = (globalThis as Record<string, unknown>).__ATLCLI_VITE_SMOKE as {
      wasmUrl: string;
      pdfiumWasmUrl: string;
      fontUrls: Record<string, string>;
      expectedFonts: string[];
      importCoreProof: boolean;
      importPdfProof: boolean;
      jobsEntrypointLoaded: boolean;
      attachmentContract(): Promise<{
        calls: number;
        createPath: string;
        contentTypeIntroduced: boolean;
        authorizationIntroduced: boolean;
        minorEdit: string;
        fileSize: number;
        attachmentId: string;
      }>;
      compileDocx(): Promise<{
        byteLength: number;
        filename: string;
        hasHeading: boolean;
        hasBody: boolean;
      }>;
      analyzePdfImport(load: (url: string) => Promise<Uint8Array>): Promise<{
        pageCount: number;
        complete: boolean;
        classification: string;
        engine: string;
        wasmSha256: string;
        factsDigest: string;
        factsSchemaV2: string;
        factsDigestV2: string;
        semanticDigest: string;
        figureSemanticDigest: string;
        titleCandidate?: string;
        blockTypes: string[];
        figureBlockTypes: string[];
        figureCount: number;
        figureAssetCount: number;
        figureModes: string[];
        figureAuthorAlt: boolean;
        taggedTableRows: number;
        taggedTableCells: number;
        taggedTableHeaders: number;
        untaggedTitleCandidate?: string;
        untaggedBlockTypes: string[];
        untaggedFallbackPages: number[];
        untaggedSemanticDigest: string;
      }>;
      compile(load: (url: string) => Promise<Uint8Array>): Promise<{
        byteLength: number;
        handleSize: number;
        mimeType: string;
        pageCount: number;
        tagged: boolean;
        isHandle: boolean;
        borrowed: boolean;
        blobSize: number;
        blobType: string;
        blobMemoized: boolean;
        objectUrlScheme: string;
        urlMemoized: boolean;
      }>;
    };
    if (!hook) throw new Error("built chunk did not install the smoke hook — wrong chunk executed?");
    if (!hook.importCoreProof) {
      throw new Error("packed @atlcli/import-core browser entry did not execute its semantic projection");
    }
    if (!hook.importPdfProof) {
      throw new Error("packed @atlcli/import-pdf browser-worker entry did not expose the facts adapter");
    }
    if (!hook.jobsEntrypointLoaded) {
      throw new Error(
        "packed @atlcli/export-wiring/jobs did not expose both PDF and TypeScript DOCX executors",
      );
    }
    return {
      hook,
      docxResult: await hook.compileDocx(),
      attachmentResult: await hook.attachmentContract(),
    };
  });
  if (
    docxResult.byteLength < 1_000
    || !docxResult.hasHeading
    || !docxResult.hasBody
    || !docxResult.filename.endsWith(".docx")
  ) {
    throw new Error(
      `vite smoke combined DOCX entry produced implausible output: ${JSON.stringify(docxResult)}`,
    );
  }
  if (
    attachmentResult.calls !== 2
    || attachmentResult.createPath !== "/wiki/rest/api/content/123/child/attachment"
    || attachmentResult.contentTypeIntroduced
    || attachmentResult.authorizationIntroduced
    || attachmentResult.minorEdit !== "true"
    || attachmentResult.fileSize !== 10
    || attachmentResult.attachmentId !== "packed-att-1"
  ) {
    throw new Error(
      `vite smoke attachment writer contract failed: ${JSON.stringify(attachmentResult)}`,
    );
  }
  const docxCodeFontAssets = ttfAssets.filter((asset) =>
    /^JetBrainsMono-Regular-[A-Za-z0-9_-]+\.ttf$/u.test(asset),
  );
  if (docxCodeFontAssets.length !== 1) {
    throw new Error(
      `expected one hashed JetBrains Mono DOCX code font, found: ${docxCodeFontAssets.join(", ")}`,
    );
  }
  if (ttfAssets.length !== hook.expectedFonts.length + docxCodeFontAssets.length) {
    throw new Error(
      `expected ${hook.expectedFonts.length} PDF fonts plus one DOCX code font, ` +
      `found ${ttfAssets.length}: ${ttfAssets.join(", ")}`,
    );
  }
  if (!chunkSource.includes(docxCodeFontAssets[0]!)) {
    throw new Error("the packed production chunk does not reference its emitted DOCX code font");
  }

  const resolveAsset = (url: string): string => {
    // With base "./" Vite computes asset URLs at runtime relative to
    // import.meta.url — under this headless import that yields file:// URLs
    // into dist/assets/. A plain "./assets/..." string is equally fine.
    let path: string;
    if (url.startsWith("file://")) path = new URL(url).pathname;
    else if (url.startsWith("./assets/")) path = join(distDir, url.slice(2));
    else throw new Error(`?url import resolved to "${url}" — expected a hashed dist/assets/ file`);
    if (!existsSync(path)) throw new Error(`emitted asset missing on disk: ${path}`);
    // realpath both sides: macOS tmpdir lives behind the /var -> /private/var symlink.
    if (!realpathSync(path).startsWith(join(realpathSync(assetsDir), "/"))) {
      throw new Error(`?url import "${url}" escapes the build output (${path})`);
    }
    return path;
  };

  const typstWasmPath = resolveAsset(hook.wasmUrl);
  const pdfiumWasmPath = resolveAsset(hook.pdfiumWasmUrl);
  if (typstWasmPath === pdfiumWasmPath) {
    throw new Error("Typst and PDFium ?url imports unexpectedly resolved to the same asset");
  }
  const emittedPdfiumSha256 = createHash("sha256")
    .update(readFileSync(pdfiumWasmPath))
    .digest("hex");
  if (emittedPdfiumSha256 !== PDFIUM_WASM_SHA256) {
    throw new Error(
      `emitted PDFium WASM digest drifted: ${emittedPdfiumSha256} != ${PDFIUM_WASM_SHA256}`,
    );
  }
  for (const fileName of hook.expectedFonts) {
    const url = hook.fontUrls[fileName];
    if (!url) throw new Error(`no ?url import for canonical font ${fileName}`);
    resolveAsset(url);
  }

  const result = await hook.compile(async (url) => new Uint8Array(readFileSync(resolveAsset(url))));
  if (!result.tagged || result.pageCount < 1 || result.byteLength < 1000) {
    throw new Error(`vite smoke compile produced implausible output: ${JSON.stringify(result)}`);
  }

  const importResult = await hook.analyzePdfImport(
    async (url) => new Uint8Array(readFileSync(resolveAsset(url))),
  );
  if (
    importResult.pageCount !== 1
    || !importResult.complete
    || importResult.classification !== "tagged"
    || importResult.engine !== "pdfium"
    || importResult.wasmSha256 !== PDFIUM_WASM_SHA256
    || !/^[a-f0-9]{64}$/u.test(importResult.factsDigest)
    || importResult.factsSchemaV2 !== "atlcli.pdf-facts/2"
    || !/^[a-f0-9]{64}$/u.test(importResult.factsDigestV2)
    || !/^[a-f0-9]{64}$/u.test(importResult.semanticDigest)
    || !/^[a-f0-9]{64}$/u.test(importResult.figureSemanticDigest)
    || importResult.titleCandidate !== "Structured Garden Report"
    || importResult.blockTypes.join(",") !== "heading,paragraph,table"
    || importResult.figureBlockTypes.join(",") !== "heading,paragraph,table,image,paragraph"
    || importResult.figureCount !== 1
    || importResult.figureAssetCount !== 1
    || importResult.figureModes.join(",") !== "native-raster"
    || !importResult.figureAuthorAlt
    || importResult.taggedTableRows !== 2
    || importResult.taggedTableCells !== 4
    || importResult.taggedTableHeaders !== 2
    || importResult.untaggedTitleCandidate !== "Quarterly Garden Notes"
    || importResult.untaggedBlockTypes.join(",") !== "heading,paragraph,paragraph,paragraph,heading,list"
    || importResult.untaggedFallbackPages.length !== 0
    || !/^[a-f0-9]{64}$/u.test(importResult.untaggedSemanticDigest)
  ) {
    throw new Error(
      `vite smoke PDF import produced implausible facts: ${JSON.stringify(importResult)}`,
    );
  }

  // --- The PdfOutputSink.emit contract from the bundled consumer's position
  // (spec 010, T5.6). Asserted HERE, not only inside the built chunk, so a
  // silently-degraded hook (fewer fields) fails instead of passing vacuously.
  if (!result.isHandle) {
    throw new Error("the vite consumer's sink was not handed a PdfBytesHandle (spec 010, T5.6)");
  }
  if (result.handleSize !== result.byteLength) {
    throw new Error(`handle.size ${result.handleSize} != asUint8Array().byteLength ${result.byteLength}`);
  }
  if (result.mimeType !== "application/pdf") {
    throw new Error(`handle.mimeType is "${result.mimeType}", expected application/pdf`);
  }
  if (!result.borrowed) {
    throw new Error("asUint8Array() copied the document instead of lending it");
  }
  // The Blob path is the whole reason the handle exists: the download must get
  // a Blob of the SAME bytes without a second full copy of the document.
  if (result.blobSize !== result.byteLength || result.blobType !== "application/pdf") {
    throw new Error(`asBlob() produced ${result.blobSize} bytes of "${result.blobType}"`);
  }
  if (!result.blobMemoized) {
    throw new Error("asBlob() built a second copy instead of memoizing");
  }
  if (result.objectUrlScheme !== "blob:") {
    throw new Error(`objectUrl() did not return a blob: URL (got "${result.objectUrlScheme}…")`);
  }
  if (!result.urlMemoized) {
    throw new Error("objectUrl() minted a second URL — the first one leaked");
  }

  return {
    projectDir,
    viteVersion: VITE_VERSION,
    smokes: {
      docx:
        `DOCX_SMOKE_OK ${docxResult.filename} bytes=${docxResult.byteLength}`,
      pdf: `PDF_SMOKE_OK vite-smoke.pdf pages=${result.pageCount} bytes=${result.byteLength}`,
    },
  };
}

if (import.meta.main) {
  const { projectDir, viteVersion, smokes } = await runViteSmoke();
  console.log(`vite tarball smoke OK in ${projectDir} (vite ${viteVersion})`);
  console.log(smokes.docx);
  console.log(smokes.pdf);
}
