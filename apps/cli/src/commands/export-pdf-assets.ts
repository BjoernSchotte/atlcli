/**
 * The CLI's PDF compiler assets (spec 008 T3.1): the pinned typst.ts WASM plus
 * the 12 canonical fonts, materialized as EMBEDDED assets and fed into the
 * runtime-agnostic {@link BrowserPdfCompiler}.
 *
 * The `with { type: "file" }` imports are the load-bearing part, mirroring
 * `export-rasterizer.ts`. Under `bun run` they resolve to the real files in
 * `node_modules` / `packages/pdf/.fonts`; under `bun build --compile` (the
 * release binaries Homebrew installs) each file is embedded into the executable
 * and the import yields its `$bunfs` path. Either way `readFile` works and the
 * CLI compiles PDFs with zero runtime dependencies.
 *
 * Spike verdict (T3.1): the `BrowserPdfCompiler` load path is runtime-agnostic —
 * "browser" names the wasm build target, not a DOM dependency. Passing an
 * `ArrayBuffer` to `initTypst({ module_or_path })` reaches
 * `WebAssembly.instantiate(module, imports)` directly (glue
 * `typst_ts_web_compiler.mjs:1163`, `else` branch), touching no `fetch`,
 * `document`, `window`, or `Response`. The `Response`/string init branches
 * (`:1144-1161`, `:1606-1607`) are browser-only and MUST NEVER be used from the
 * CLI. See the "Spike results" section of the 008 PLAN.
 *
 * Unlike the mermaid rasterizer, a load failure here is a HARD error: PDF export
 * cannot degrade to a "diagram-as-code" fallback, so the loader throws.
 */
import typstWasm from "@atlcli/pdf-compiler-browser/wasm" with { type: "file" };
import sourceSansRegular from "@atlcli/pdf/fonts/SourceSans3-Regular.ttf" with { type: "file" };
import sourceSansItalic from "@atlcli/pdf/fonts/SourceSans3-It.ttf" with { type: "file" };
import sourceSansSemibold from "@atlcli/pdf/fonts/SourceSans3-Semibold.ttf" with { type: "file" };
import sourceSansBold from "@atlcli/pdf/fonts/SourceSans3-Bold.ttf" with { type: "file" };
import sourceSerifRegular from "@atlcli/pdf/fonts/SourceSerif4-Regular.ttf" with { type: "file" };
import sourceSerifItalic from "@atlcli/pdf/fonts/SourceSerif4-It.ttf" with { type: "file" };
import sourceSerifSemibold from "@atlcli/pdf/fonts/SourceSerif4-Semibold.ttf" with { type: "file" };
import sourceSerifBold from "@atlcli/pdf/fonts/SourceSerif4-Bold.ttf" with { type: "file" };
import sourceCodeRegular from "@atlcli/pdf/fonts/SourceCodePro-Regular.ttf" with { type: "file" };
import sourceCodeBold from "@atlcli/pdf/fonts/SourceCodePro-Bold.ttf" with { type: "file" };
import notoSymbolsRegular from "@atlcli/pdf/fonts/NotoSansSymbols2-Regular.ttf" with { type: "file" };
import notoEmojiRegular from "@atlcli/pdf/fonts/NotoEmoji-wght.ttf" with { type: "file" };
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import type { PdfCompilePort } from "@atlcli/pdf";
import type { BrowserPdfCompilerFontSourceV1 } from "@atlcli/pdf-compiler-browser";

/**
 * Resolve a `with { type: "file" }` import path to something `readFile` can open
 * from any CWD. In source runs and `bun build --compile` binaries the path is
 * already absolute (a `node_modules` path or a `$bunfs` path). In a plain
 * `bun build --target bun` dist bundle the import yields a path RELATIVE to the
 * emitted bundle directory (`./asset-<hash>.wasm`); `readFile` would resolve
 * that against the process CWD and fail (see the T3.1 spike). Anchoring relative
 * paths to `import.meta.dir` (the bundle's own directory) makes all three modes
 * work without a browser-only `import.meta.resolve` round-trip.
 */
function assetFilePath(imported: string): string {
  return isAbsolute(imported) ? imported : resolve(import.meta.dir, imported);
}

/**
 * The font file paths in the CANONICAL manifest order (`PDF_RUNTIME_ASSETS`).
 * A parity assertion below fails loudly if these drift from the manifest — the
 * same guard the harness worker runs (`assertStaticAssetParity`).
 */
const FONT_FILES: ReadonlyArray<{ fileName: string; path: string }> = [
  { fileName: "SourceSans3-Regular.ttf", path: sourceSansRegular },
  { fileName: "SourceSans3-It.ttf", path: sourceSansItalic },
  { fileName: "SourceSans3-Semibold.ttf", path: sourceSansSemibold },
  { fileName: "SourceSans3-Bold.ttf", path: sourceSansBold },
  { fileName: "SourceSerif4-Regular.ttf", path: sourceSerifRegular },
  { fileName: "SourceSerif4-It.ttf", path: sourceSerifItalic },
  { fileName: "SourceSerif4-Semibold.ttf", path: sourceSerifSemibold },
  { fileName: "SourceSerif4-Bold.ttf", path: sourceSerifBold },
  { fileName: "SourceCodePro-Regular.ttf", path: sourceCodeRegular },
  { fileName: "SourceCodePro-Bold.ttf", path: sourceCodeBold },
  { fileName: "NotoSansSymbols2-Regular.ttf", path: notoSymbolsRegular },
  { fileName: "NotoEmoji-wght.ttf", path: notoEmojiRegular },
];

/**
 * Assert the embedded font set exactly matches the canonical manifest (name and
 * order). A build that drops or reorders a font would otherwise silently ship a
 * PDF with the wrong glyphs; this turns that into a hard, named failure.
 */
export function assertPdfAssetParity(): void {
  const expected = PDF_RUNTIME_ASSETS.fonts.map((font) => font.fileName);
  const actual = FONT_FILES.map((font) => font.fileName);
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(
      `The CLI's embedded PDF fonts do not match the canonical manifest. ` +
        `Expected [${expected.join(", ")}], got [${actual.join(", ")}].`
    );
  }
}

/**
 * Load the embedded typst wasm bytes and the 12 canonical fonts. A failure here
 * is a hard error (PDF export cannot degrade) — the caller surfaces it as a
 * `configuration`-phase failure.
 */
export async function loadPdfCompilerAssets(): Promise<{ wasm: ArrayBuffer; fonts: Uint8Array[] }> {
  assertPdfAssetParity();
  const [wasmBytes, ...fonts] = await Promise.all([
    readFile(assetFilePath(typstWasm)),
    ...FONT_FILES.map(async (font) => new Uint8Array(await readFile(assetFilePath(font.path)))),
  ]);
  // Copy into a standalone ArrayBuffer so the ArrayBuffer-only wasm init branch
  // (WebAssembly.instantiate) is taken — never the browser Response/string path.
  const wasm = wasmBytes.buffer.slice(
    wasmBytes.byteOffset,
    wasmBytes.byteOffset + wasmBytes.byteLength
  );
  return { wasm, fonts };
}

let compilerPromise: Promise<PdfCompilePort> | null = null;

function demandAwareFontSources(): BrowserPdfCompilerFontSourceV1[] {
  assertPdfAssetParity();
  return FONT_FILES.map((font, index) => {
    const manifest = PDF_RUNTIME_ASSETS.fonts[index]!;
    return {
      assetId: manifest.assetId,
      sha256: manifest.sha256,
      load: async (context = {}) => {
        context.signal?.throwIfAborted();
        const bytes = new Uint8Array(
          await readFile(assetFilePath(font.path)),
        );
        context.signal?.throwIfAborted();
        return bytes;
      },
    };
  });
}

/**
 * Lazily create ONE compiler per CLI process (spike lifecycle decision T3.1):
 * `reset_shadow()` runs between pages inside `compile()`, so a single instance
 * serves every page of a tree/space export. The import is dynamic so non-export
 * commands never pay the multi-MB wasm cost. A load failure clears the cache so
 * a retry can re-attempt (mirrors the harness worker).
 */
export function getPdfCompiler(): Promise<PdfCompilePort> {
  if (compilerPromise) return compilerPromise;
  compilerPromise = (async () => {
    const { BrowserPdfCompiler } = await import("@atlcli/pdf-compiler-browser");
    assertPdfAssetParity();
    const wasmBytes = await readFile(assetFilePath(typstWasm));
    const wasm = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    );
    return new BrowserPdfCompiler({
      wasm,
      fonts: demandAwareFontSources(),
    });
  })().catch((error) => {
    compilerPromise = null;
    throw error;
  });
  return compilerPromise;
}
