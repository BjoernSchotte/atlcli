import { defineConfig } from "wxt";
import { fileURLToPath } from "node:url";
// Relative src import (not "@atlcli/docx/vite"): this config is loaded by
// wxt's own config loader (jiti, Node-style resolution) which does not request
// the "development" export condition — the package specifier would resolve to
// dist/ and break `bun install` (postinstall: wxt prepare) on a fresh clone
// before any build exists.
import { DOCX_BROWSER_VITE_DEFINES } from "../../packages/docx/src/vite";
import { patchOrtAsyncifyFactoryForMv3 } from "./scripts/patch-ort-jsep-csp";

const researchBrowserModule = (name: string): string =>
  fileURLToPath(new URL(`./utils/research/${name}.ts`, import.meta.url));

// WXT config for the atlcli Chrome extension (spec 002).
//
// The `manifest` block below declares the normative MV3 fields from PLAN §2.3.
// WXT owns the generated `background.service_worker` path and the sidepanel/
// offscreen HTML asset paths; everything else here is asserted verbatim by the
// manifest-validation test (Task 2) against the built `.output/chrome-mv3/manifest.json`.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // WXT auto-imports (unimport): its built-in `storage`/`browser` presets run as
  // a Vite transform over EVERY module in the graph — including the workspace
  // SOURCE we consume (`packages/*`). There the bare `storage` param in the
  // confluence converter gets rewritten to `import { storage } from
  // "wxt/utils/storage"`, which then fails to resolve and breaks the bundle.
  // `imports: false` does NOT stop this (it only disables user-dir scanning), so
  // we exclude workspace source from the transform. Our own code imports
  // everything explicitly, so nothing here relies on auto-imports.
  // `exclude` is honored by the underlying unimport unplugin's file filter but
  // is absent from WXT's narrower `imports` type — cast through it.
  imports: {
    eslintrc: { enabled: false },
    exclude: [/[\\/]packages[\\/]/],
  } as Parameters<typeof defineConfig>[0]["imports"],
  manifest: {
    name: "atlcli",
    // MV3 side panel + offscreen APIs baseline (PLAN §6 risk 1).
    // Chrome 140 is the oldest browser exercised by the real packed-extension
    // PDF.js worker test. The modern runtime's two newer standard operations are
    // supplied explicitly in both viewer and worker realms.
    minimum_chrome_version: "140",
    permissions: ["sidePanel", "offscreen", "storage", "tabs"],
    // The toolbar button. Required by the `setPanelBehavior({
    // openPanelOnActionClick: true })` call the service worker already makes,
    // and by `chrome.action.setBadgeText` — the ONLY notification channel spec
    // 010 T5.6 may use, because `chrome.notifications` would need a new
    // permission and this folder ships none. `action` is a manifest KEY, not a
    // permission, so the set asserted by tests/manifest.test.ts is unchanged.
    action: {},
    // api.media.atlassian.com: Cloud 302s attachment downloads to the media
    // CDN, which answers `Access-Control-Allow-Origin: *` — incompatible with
    // the session fetch's `credentials: "include"` unless the host permission
    // exempts that hop from CORS too (spec 005 image embedding, E2E finding).
    host_permissions: [
      "*://*.atlassian.net/*",
      "https://api.media.atlassian.com/*",
      "https://api.anthropic.com/*",
      "https://huggingface.co/*",
    ],
    // WASM in extension pages requires 'wasm-unsafe-eval' (Chrome >= 103).
    // Deliberately NOT 'unsafe-eval' — asserted by the Task 2 test.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    plugins: [
      {
        name: "research-browser-only-optional-dependencies",
        enforce: "pre",
        resolveId(source, importer) {
          if (source === "langsmith/experimental/sandbox") {
            return researchBrowserModule("langsmith-sandbox-browser-stub");
          }

          // Streamdown's public barrel eagerly retains lazy Mermaid and Shiki
          // chunks even when callers override `code` and disable controls.
          // Those optional rich renderers contain string-to-code paths that
          // violate the extension-page CSP. The chat supplies its own safe
          // code renderer, so keep Streamdown's parser/streaming renderer while
          // replacing only the unreachable rich-block modules in MV3 builds.
          if (importer?.includes("streamdown/dist/")) {
            if (source.startsWith("./code-block-") || source.startsWith("./mermaid-")) {
              return researchBrowserModule("streamdown-rich-block-browser-stub");
            }
            if (source === "mermaid") {
              return researchBrowserModule("streamdown-mermaid-browser-stub");
            }
          }

          // Anthropic SDK 0.115 imports its optional Node credential providers
          // eagerly from client.mjs. ChatAnthropic always supplies the user's
          // session-only apiKey, so these branches are unreachable. Alias only
          // the three imports from that exact upstream client module.
          if (
            !importer?.includes("@anthropic-ai/sdk/client.mjs") &&
            !importer?.includes("@anthropic-ai/sdk/client.js")
          ) {
            return null;
          }

          if (source === "./lib/credentials/types.mjs") {
            return researchBrowserModule("anthropic-browser-credential-types");
          }
          if (source === "./lib/credentials/token-cache.mjs") {
            return researchBrowserModule("anthropic-browser-token-cache");
          }
          if (source === "./lib/credentials/credential-chain.mjs") {
            return researchBrowserModule("anthropic-browser-credential-chain");
          }
          return null;
        },
      },
      {
        name: "mv3-csp-safe-ort-webgpu-factory",
        enforce: "post",
        generateBundle(_options, bundle) {
          const candidates = Object.values(bundle).filter(
            (item) =>
              item.type === "asset" &&
              /ort-wasm-simd-threaded[.]asyncify-[^/]+[.]mjs$/u.test(item.fileName),
          );
          // WXT invokes this plugin once per entrypoint build. Most entrypoints
          // do not contain the local-model worker (and therefore no ORT
          // factory); leave those bundles untouched. The worker build itself
          // must emit exactly one factory and is patched fail-closed below.
          if (candidates.length === 0) return;
          if (candidates.length !== 1 || candidates[0]?.type !== "asset") {
            throw new Error(
              `Expected one packaged ONNX Runtime WebGPU factory, found ${candidates.length}.`,
            );
          }
          const source = candidates[0].source;
          const text = typeof source === "string"
            ? source
            : new TextDecoder().decode(source);
          candidates[0].source = patchOrtAsyncifyFactoryForMv3(text);
        },
      },
    ],
    // Belt-and-suspenders for PLAN §6 risk 4: force Vite to resolve the
    // `browser` export condition of @atlcli/core so the Node barrel (with
    // node: imports) is never pulled into the extension bundle.
    resolve: {
      // `development` FIRST (spec 009): resolves the @atlcli/* workspace
      // packages to live src/ (their exports list the development condition
      // first), so `wxt dev` never serves stale dist/ output.
      conditions: ["development", "browser", "onnxruntime-web-use-extern-wasm"],
      alias: [
        {
          find: "langsmith/experimental/sandbox",
          replacement: researchBrowserModule("langsmith-sandbox-browser-stub"),
        },
        {
          find: "json-schema-to-typescript",
          replacement: researchBrowserModule(
            "json-schema-to-typescript-browser"
          ),
        },
        {
          find: "micromatch",
          replacement: researchBrowserModule("micromatch-browser"),
        },
        {
          find: "./lib/credentials/types.mjs",
          replacement: researchBrowserModule(
            "anthropic-browser-credential-types"
          ),
        },
        {
          find: "./lib/credentials/token-cache.mjs",
          replacement: researchBrowserModule("anthropic-browser-token-cache"),
        },
        {
          find: "./lib/credentials/credential-chain.mjs",
          replacement: researchBrowserModule(
            "anthropic-browser-credential-chain"
          ),
        },
        {
          find: /^deepagents$/,
          replacement: fileURLToPath(
            new URL("./utils/research/deepagents-browser-compat.ts", import.meta.url)
          ),
        },
      ],
    },
    // PDF.js imports workerSrc on the main thread for its LoopbackPort fallback.
    // Preserve the bootstrap's WorkerMessageHandler export instead of emitting
    // the default IIFE worker, which has no module namespace exports.
    worker: {
      format: "es",
      plugins: () => [
        {
          name: "preserve-worker-entry-exports",
          options(options) {
            return { ...options, preserveEntrySignatures: "exports-only" };
          },
        },
      ],
    },
    // Spec 004: PizZip / docxtemplater reference the Node `Buffer.*` globals,
    // which are undefined in the MV3 panel and rejected by the output-scan gate.
    // Rewrite those member expressions to the browser-safe helpers installed by
    // `@atlcli/docx/browser-entry` (a real shim, not a scan suppression). Bare
    // `typeof Buffer` (not a member access) is left alone — it correctly reads
    // as "undefined", keeping the libs on their Uint8Array feature-branch.
    define: {
      ...DOCX_BROWSER_VITE_DEFINES,
      // LangChain's approximate token counter has a guarded Node fast-path
      // for Buffer.byteLength. The guard selects its string-length fallback in
      // browsers, but the unreachable member expression still violates the
      // artifact gate. Keep the exact UTF-8 behavior without a Buffer global.
      "Buffer.byteLength":
        "(value => new TextEncoder().encode(String(value)).byteLength)",
      // Transformers.js contains a guarded CommonJS path in its otherwise
      // browser-safe environment module. Fold it away in the MV3 bundle.
      __dirname: "undefined",
      __filename: "undefined",
    },
  }),
});
