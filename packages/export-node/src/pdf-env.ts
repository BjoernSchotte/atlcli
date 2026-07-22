/**
 * Batteries-included PDF env for Node hosts (spec 009 / BASELINE-DESIGN §A5).
 *
 * Bundles the three seams `runPdfExport` needs — a token-auth
 * `PdfAssetResolver`, the wasm/font-wired `PdfCompilePort` (the same
 * `BrowserPdfCompiler` the CLI and browser hosts run — "browser" names the
 * wasm build target, not a DOM dependency; spec 008 T3.1 spike), and a
 * directory `PdfOutputSink` — so a host goes from a block tree to a PDF file
 * in a few lines.
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ConfluenceClient } from "@atlcli/confluence";
import { getConfluenceBaseUrl, type Profile } from "@atlcli/core";
import {
  PDF_RUNTIME_ASSETS,
  type PdfAssetRef,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportEnv,
  type PdfOutputSink,
  type PdfResolvedAsset,
} from "@atlcli/pdf";
import { createAssetByteCache, tokenAssetFetcher, type AssetClient } from "./asset-fetcher.js";

const require = createRequire(import.meta.url);

/**
 * Load the vendored, CSP-patched typst wasm and the eleven canonical fonts from
 * the INSTALLED packages (`@atlcli/pdf-compiler-browser/wasm`,
 * `@atlcli/pdf/fonts/*`) — plain `require.resolve`, so it works identically
 * under Node and Bun, from a workspace link or an installed tarball. (The
 * CLI's release binaries keep their own embedded-asset loader; everything
 * else should use this.)
 */
export async function loadNodePdfCompilerAssets(): Promise<{ wasm: ArrayBuffer; fonts: Uint8Array[] }> {
  const wasmBytes = await readFile(require.resolve("@atlcli/pdf-compiler-browser/wasm"));
  const fonts = await Promise.all(
    PDF_RUNTIME_ASSETS.fonts.map(
      async (font) => new Uint8Array(await readFile(require.resolve(`@atlcli/pdf/fonts/${font.fileName}`)))
    )
  );
  // Standalone ArrayBuffer → the ArrayBuffer-only wasm init branch
  // (WebAssembly.instantiate), never the browser Response/string path.
  const wasm = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
  return { wasm, fonts };
}

let compilerPromise: Promise<PdfCompilePort> | null = null;

/**
 * One shared compiler per process (`reset_shadow()` runs between compiles, so
 * a single instance serves every page/document). Lazily created; a load
 * failure clears the cache so a retry can re-attempt.
 */
export function nodePdfCompiler(): Promise<PdfCompilePort> {
  if (compilerPromise) return compilerPromise;
  compilerPromise = (async () => {
    const { BrowserPdfCompiler } = await import("@atlcli/pdf-compiler-browser");
    const { wasm, fonts } = await loadNodePdfCompilerAssets();
    return new BrowserPdfCompiler({ wasm, fonts });
  })().catch((error) => {
    compilerPromise = null;
    throw error;
  });
  return compilerPromise;
}

/** A {@link PdfCompilePort} that defers wasm/font loading to first use. */
export function lazyNodePdfCompiler(): PdfCompilePort {
  return {
    compile: async (bundle, context) => (await nodePdfCompiler()).compile(bundle, context),
  };
}

/**
 * Token-auth {@link PdfAssetResolver} over the shared attachment fetcher +
 * verified disk cache. Media type stays `application/octet-stream` so
 * `preparePdfDocument` sniffs it from the bytes.
 */
export function tokenPdfAssetResolver(
  client: AssetClient,
  baseUrl: string,
  options: { cacheDir?: string } = {}
): PdfAssetResolver {
  const cache = createAssetByteCache(baseUrl, options.cacheDir);
  const fetcher = tokenAssetFetcher(client, cache);
  return {
    async resolve(ref: PdfAssetRef, context?: { signal?: AbortSignal }): Promise<PdfResolvedAsset> {
      const url = ref.kind === "attachment" ? (ref.filename ?? "") : (ref.url ?? "");
      const bytes = await fetcher.fetch(
        {
          url,
          ...(ref.pageId ? { pageId: ref.pageId } : {}),
          ...(ref.filename ? { filename: ref.filename } : {}),
        },
        context?.signal ? { signal: context.signal } : {}
      );
      return {
        bytes,
        mediaType: "application/octet-stream",
        ...(ref.filename ? { filename: ref.filename } : {}),
      };
    },
  };
}

/**
 * A {@link PdfOutputSink} writing `<outDir>/<emitted filename>` (directories
 * created as needed). Path traversal out of `outDir` is refused.
 */
export function dirPdfOutputSink(outDir: string): PdfOutputSink {
  return {
    async emit(name, bytes, context) {
      context?.signal?.throwIfAborted();
      const dir = resolve(outDir);
      const target = join(dir, basename(name));
      await mkdir(dir, { recursive: true });
      // `bytes` is a PdfBytesHandle since spec 010 T5.6. For the default
      // array-backed handle this hands back the compiler's own buffer.
      await writeFile(target, await bytes.asUint8Array());
    },
  };
}

export interface NodePdfEnvOptions {
  /** Output directory for the emitted PDF (default: the current directory). */
  outDir?: string;
  /** Override the disk-cache directory for attachment bytes. */
  cacheDir?: string;
  /** Override the compiler port (tests, alternative compilers). */
  compiler?: PdfCompilePort;
  /** Override the asset resolver (e.g. hosts without attachment access). */
  assets?: PdfAssetResolver;
}

/**
 * The complete {@link PdfExportEnv} for a Node host (BASELINE-DESIGN §A5):
 * token-auth assets from the profile's Confluence site, the wasm/font-wired
 * compiler, and a directory output sink. Pass straight to `runPdfExport`.
 */
export function nodePdfEnv(profile: Profile, options: NodePdfEnvOptions = {}): PdfExportEnv {
  const assets =
    options.assets ??
    tokenPdfAssetResolver(
      new ConfluenceClient(profile),
      getConfluenceBaseUrl(profile),
      options.cacheDir ? { cacheDir: options.cacheDir } : {}
    );
  return {
    assets,
    compiler: options.compiler ?? lazyNodePdfCompiler(),
    output: dirPdfOutputSink(options.outDir ?? "."),
  };
}
