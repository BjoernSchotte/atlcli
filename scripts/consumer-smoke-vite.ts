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
 * installed packages, and exposes a hook on globalThis. After the build the
 * driver asserts the `?url` imports resolved to real hashed files in the
 * build output (nothing falling through to a src/ path or workspace
 * symlink), then imports the PRODUCTION chunk under Bun (headless — a real
 * browser Worker adds nothing to the packaging proof) and compiles a fixture
 * to real, validated PDF bytes using the EMITTED wasm + font assets.
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPackages,
  packAll,
  run,
  type SmokeRunResult,
} from "./consumer-smoke.js";

/** pdf + pdf-compiler-browser + their @atlcli closure. */
const VITE_PACKAGES = [
  "@atlcli/core",
  "@atlcli/diagram",
  "@atlcli/confluence",
  "@atlcli/pdf",
  "@atlcli/pdf-compiler-browser",
];

const VITE_VERSION = "8.1.4"; // same major the harness builds with

const INDEX_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>atlcli vite smoke</title></head>
  <body><script type="module" src="/src/entry.ts"></script></body>
</html>
`;

const VITE_CONFIG = `import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  resolve: {
    // Same preference as apps/browser-export-harness — but NO "development":
    // this build must prove the packed tarballs' dist/ exports.
    conditions: ["browser"],
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
import wasmUrl from "@atlcli/pdf-compiler-browser/wasm?url";
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
import { runPdfExport, PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import { validatePdfOutput } from "@atlcli/pdf/internal";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { storageToBlocks } from "@atlcli/confluence";

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
};

type LoadBytes = (url: string) => Promise<Uint8Array>;

(globalThis as Record<string, unknown>).__ATLCLI_VITE_SMOKE = {
  wasmUrl,
  fontUrls,
  expectedFonts: PDF_RUNTIME_ASSETS.fonts.map((font) => font.fileName),
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
    let outBytes: Uint8Array | undefined;
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
          emit: async (_name: string, bytes: Uint8Array) => {
            outBytes = bytes;
          },
        },
      },
    );
    if (!outBytes) throw new Error("runPdfExport emitted nothing");
    const inspection = validatePdfOutput(outBytes);
    return { byteLength: outBytes.byteLength, pageCount: inspection.pageCount, tagged: inspection.tagged };
  },
};
`;

export interface ViteSmokeResult {
  projectDir: string;
  viteVersion: string;
  smokes: SmokeRunResult;
}

export async function runViteSmoke(baseDir?: string): Promise<ViteSmokeResult> {
  const workDir = baseDir ?? join(tmpdir(), `atlcli-vite-smoke-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });

  buildPackages();
  const tarballs = packAll(join(workDir, "tarballs"));

  const projectDir = join(workDir, "consumer");
  mkdirSync(join(projectDir, "src"), { recursive: true });

  const dependencies: Record<string, string> = {};
  for (const name of VITE_PACKAGES) {
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
  if (wasmAssets.length !== 1) {
    throw new Error(`expected exactly one hashed .wasm asset, found: ${wasmAssets.join(", ")}`);
  }
  if (ttfAssets.length !== 10) {
    throw new Error(`expected 10 hashed .ttf assets, found ${ttfAssets.length}: ${ttfAssets.join(", ")}`);
  }

  const chunkName = assets.find((a) => a.endsWith(".js"));
  if (!chunkName) throw new Error(`no built js chunk in ${assetsDir}`);
  const chunkPath = join(assetsDir, chunkName);
  const chunkSource = readFileSync(chunkPath, "utf8");
  // Nothing may fall through to a source path or workspace symlink: the
  // production chunk must reference only its own hashed ./assets/ files.
  for (const forbidden of ["/src/index", "workspace:", "node_modules/@atlcli"]) {
    if (chunkSource.includes(forbidden)) {
      throw new Error(`production chunk references "${forbidden}" — tarball resolution fell through`);
    }
  }

  // --- Execute the PRODUCTION chunk and compile with the EMITTED assets. ---
  await import(chunkPath);
  const hook = (globalThis as Record<string, unknown>).__ATLCLI_VITE_SMOKE as {
    wasmUrl: string;
    fontUrls: Record<string, string>;
    expectedFonts: string[];
    compile(load: (url: string) => Promise<Uint8Array>): Promise<{
      byteLength: number;
      pageCount: number;
      tagged: boolean;
    }>;
  };
  if (!hook) throw new Error("built chunk did not install the smoke hook — wrong chunk executed?");

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

  resolveAsset(hook.wasmUrl);
  for (const fileName of hook.expectedFonts) {
    const url = hook.fontUrls[fileName];
    if (!url) throw new Error(`no ?url import for canonical font ${fileName}`);
    resolveAsset(url);
  }

  const result = await hook.compile(async (url) => new Uint8Array(readFileSync(resolveAsset(url))));
  if (!result.tagged || result.pageCount < 1 || result.byteLength < 1000) {
    throw new Error(`vite smoke compile produced implausible output: ${JSON.stringify(result)}`);
  }

  return {
    projectDir,
    viteVersion: VITE_VERSION,
    smokes: {
      docx: "(not part of the vite smoke)",
      pdf: `PDF_SMOKE_OK vite-smoke.pdf pages=${result.pageCount} bytes=${result.byteLength}`,
    },
  };
}

if (import.meta.main) {
  const { projectDir, viteVersion, smokes } = await runViteSmoke();
  console.log(`vite tarball smoke OK in ${projectDir} (vite ${viteVersion})`);
  console.log(smokes.pdf);
}
