/**
 * Node-side implementations of the export-env interfaces (spec 006 Task 5).
 *
 * Deliberately in their own module, exported only from the Node barrel
 * (`index.ts`) — the browser entry must never pull `node:fs` into its graph
 * (the `check:browser` gate would fail). A Node host (CLI, MCP server,
 * Org-Server) composes these with a token-auth {@link AssetFetcher} to get a
 * full {@link ExportEnv}.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetFetcher, OutputSink, SvgRasterizer, TemplateSource } from "./env.js";

/**
 * A {@link TemplateSource} that reads the template from one fixed file path.
 * The `id` passed by {@link runExport} is ignored — a CLI invocation names
 * exactly one template.
 */
export function fileTemplateSource(path: string): TemplateSource {
  return {
    async getBytes(): Promise<Uint8Array> {
      return new Uint8Array(await readFile(path));
    },
  };
}

/**
 * An {@link OutputSink} that writes to one fixed file path, ignoring the
 * report's suggested filename (the CLI user chose the output path).
 */
export function fileOutputSink(path: string): OutputSink {
  return {
    async emit(_name: string, bytes: Uint8Array): Promise<void> {
      await writeFile(path, bytes);
    },
  };
}

/**
 * An {@link AssetFetcher} that fails on first use. Since spec 005 landed,
 * hosts without an asset path should simply OMIT `assets` from their
 * {@link ExportEnv} (images then degrade to `image-skipped` report notes);
 * inject this only where an asset fetch indicates a real wiring gap that
 * should surface loudly (as an `image-embed-failed` warning note).
 */
export function unsupportedAssetFetcher(reason = "asset fetching is not wired for this host"): AssetFetcher {
  return {
    fetch(): Promise<Uint8Array> {
      return Promise.reject(new Error(reason));
    },
  };
}

/**
 * Byte inputs for {@link resvgSvgRasterizer}. Every field is optional: a
 * plain Node host omits them all and the adapter resolves the resvg wasm
 * through `node_modules` and the fonts from this package's bundled set. A
 * host whose filesystem is NOT the package tree at runtime — the compiled
 * CLI binary — reads its embedded copies and passes the bytes explicitly.
 */
export interface ResvgRasterizerAssets {
  /** `@resvg/resvg-wasm` module bytes (`index_bg.wasm`). */
  wasm?: Uint8Array;
  /** TTF/OTF font buffers for SVG text. Defaults to the bundled fonts. */
  fonts?: Uint8Array[];
  /** Family used for text without a resolvable `font-family`. */
  defaultFontFamily?: string;
}

/**
 * The fonts bundled with this package (`fonts/`, licensed under the SIL OFL,
 * see the LICENSE files there): Inter and JetBrains Mono — exactly the two
 * families beautiful-mermaid's diagram SVGs name, so text renders with the
 * same metrics the layout was computed with. resvg's wasm build has no
 * access to system fonts (deliberately: identical output on every host), so
 * font bytes MUST come from somewhere — these are the default.
 */
export async function bundledDiagramFonts(): Promise<Uint8Array[]> {
  const dir = fileURLToPath(new URL("../fonts/", import.meta.url));
  const files = (await readdir(dir)).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
  if (files.length === 0) throw new Error(`no bundled fonts found in ${dir}`);
  return Promise.all(files.map((f) => readFile(join(dir, f)).then((b) => new Uint8Array(b))));
}

/** Resolve the resvg wasm bytes from the installed `@resvg/resvg-wasm`. */
async function defaultResvgWasm(): Promise<Uint8Array> {
  const require = createRequire(import.meta.url);
  return new Uint8Array(await readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
}

/** `initWasm` accepts bytes exactly once per process; memoize around it. */
let resvgInit: Promise<typeof import("@resvg/resvg-wasm")> | null = null;

function loadResvg(wasm?: Uint8Array): Promise<typeof import("@resvg/resvg-wasm")> {
  if (!resvgInit) {
    resvgInit = (async () => {
      const resvg = await import("@resvg/resvg-wasm");
      await resvg.initWasm(wasm ?? (await defaultResvgWasm()));
      return resvg;
    })();
    // A failed init (unreadable wasm) must not poison later attempts.
    resvgInit.catch(() => {
      resvgInit = null;
    });
  }
  return resvgInit;
}

/**
 * An {@link SvgRasterizer} over [resvg](https://github.com/yisibl/resvg-js)'s
 * WebAssembly build (spec 005a §2.4, Node leg): the diagram SVG is rendered
 * to PNG entirely in-process — no browser, no canvas, no native addon. The
 * wasm build is chosen over the napi one deliberately: the CLI's release
 * binaries are cross-compiled from one Linux runner, which can never embed
 * another platform's `.node` addon, while one `.wasm` asset serves every
 * target identically.
 *
 * Everything resvg can't resolve is prepared on the way in: the engine
 * flattens beautiful-mermaid's CSS custom properties / `color-mix()` before
 * the SVG reaches any rasterizer (`flattenSvgStyles` in `@atlcli/diagram`),
 * and the bundled
 * Inter + JetBrains Mono fonts satisfy the SVG's `font-family` stacks with
 * no system-font dependency. Rasterization failures reject — the engine
 * routes that diagram to the readable code-block fallback.
 */
export function resvgSvgRasterizer(assets: ResvgRasterizerAssets = {}): SvgRasterizer {
  let fontsPromise: Promise<Uint8Array[]> | null = null;
  return {
    async rasterize(svg, { widthPx }): Promise<Uint8Array> {
      const { Resvg } = await loadResvg(assets.wasm);
      fontsPromise ??= assets.fonts ? Promise.resolve(assets.fonts) : bundledDiagramFonts();
      const fonts = await fontsPromise;
      const renderer = new Resvg(svg, {
        // The engine asks for 2× the intrinsic size; height follows from the
        // preserved aspect ratio.
        fitTo: { mode: "width", value: widthPx },
        font: {
          fontBuffers: fonts,
          defaultFontFamily: assets.defaultFontFamily ?? "Inter",
          loadSystemFonts: false,
        },
      });
      return renderer.render().asPng();
    },
  };
}
