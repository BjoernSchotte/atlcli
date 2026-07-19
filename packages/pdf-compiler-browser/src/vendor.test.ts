import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import { ATLCLI_TYPST_TEMPLATE, validatePdfOutput } from "@atlcli/pdf/internal";
import { ensurePdfFonts, PDF_FONT_CACHE_DIR } from "../../pdf/scripts/ensure-fonts.js";
import { PDF_RUNTIME_ASSETS } from "../../pdf/src/runtime-assets.js";
import {
  ensureVendoredTypst,
  verifyVendoredTypst,
  PATCH_MARKER,
  VENDORED_MJS,
  VENDORED_WASM,
} from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./compiler.js";

/**
 * Vendored typst.ts regression tests (spec 009, Special cases) — no mocks.
 *
 * Loads the real vendored glue + wasm under Bun and asserts the CSP patch
 * BEHAVIOR (the allowlist wrapper throws on an unexpected dynamic function
 * body), not just the marker string. The wrappers live in the wasm import
 * object, so the test captures that object by intercepting
 * `WebAssembly.instantiate` during a real init, then calls the wrappers
 * directly with strings written into the instance's exported memory.
 */

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
});

describe("vendored typst.ts glue (spec 009)", () => {
  it("verifies: files present, sha256 pins match, patch markers present, no new Function", () => {
    expect(() => verifyVendoredTypst()).not.toThrow();
    const glue = readFileSync(VENDORED_MJS, "utf8");
    expect(glue.split(PATCH_MARKER).length - 1).toBeGreaterThanOrEqual(2);
    expect(glue).not.toContain("new Function(");
  });

  it("the patched glue throws on unexpected dynamic function bodies and allows the static allowlist", async () => {
    // Import a FRESH copy of the glue: the module is a singleton whose init
    // caches the wasm instance, so if another test file initialized it first,
    // no WebAssembly.instantiate call would be observable here. The glue is
    // fully standalone (no imports), so a byte-identical copy at a different
    // path yields an independent module instance.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const freshGluePath = join(mkdtempSync(join(tmpdir(), "atlcli-vendor-glue-")), "glue.mjs");
    writeFileSync(freshGluePath, readFileSync(VENDORED_MJS));
    const glue = (await import(freshGluePath)) as {
      default: (options: { module_or_path: ArrayBuffer }) => Promise<unknown>;
    };
    const wasmBytes = readFileSync(VENDORED_WASM);

    type WbgImports = Record<string, (...args: number[]) => unknown>;
    let capturedImports: { wbg?: WbgImports } | undefined;
    let capturedInstance: WebAssembly.Instance | undefined;

    const originalInstantiate = WebAssembly.instantiate;
    (WebAssembly as { instantiate: unknown }).instantiate = async function patchedInstantiate(
      bytesOrModule: BufferSource | WebAssembly.Module,
      imports?: WebAssembly.Imports,
    ) {
      capturedImports = imports as typeof capturedImports;
      const result = await (
        originalInstantiate as (
          b: BufferSource | WebAssembly.Module,
          i?: WebAssembly.Imports,
        ) => Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance>
      ).call(WebAssembly, bytesOrModule, imports);
      capturedInstance =
        (result as WebAssembly.WebAssemblyInstantiatedSource).instance ??
        (result as WebAssembly.Instance);
      return result;
    };

    try {
      await glue.default({
        module_or_path: wasmBytes.buffer.slice(
          wasmBytes.byteOffset,
          wasmBytes.byteOffset + wasmBytes.byteLength,
        ) as ArrayBuffer,
      });
    } finally {
      (WebAssembly as { instantiate: unknown }).instantiate = originalInstantiate;
    }

    const wbg = capturedImports?.wbg;
    expect(wbg, "wasm import object was not captured").toBeDefined();
    const noArgsKey = Object.keys(wbg!).find((k) => k.startsWith("__wbg_new_no_args"));
    const withArgsKey = Object.keys(wbg!).find((k) => k.startsWith("__wbg_new_with_args"));
    expect(noArgsKey, "no __wbg_new_no_args_* import found").toBeDefined();
    expect(withArgsKey, "no __wbg_new_with_args_* import found").toBeDefined();

    // Write probe strings into the live wasm memory so getStringFromWasm0
    // can read them back (the wrappers take (ptr, len) pairs).
    const memory = capturedInstance!.exports.memory as WebAssembly.Memory;
    const view = new Uint8Array(memory.buffer);
    const base = view.length - 8192;
    const write = (text: string, offset: number): [number, number] => {
      const bytes = new TextEncoder().encode(text);
      view.set(bytes, offset);
      return [offset, bytes.length];
    };

    // Unexpected body → the patch must throw (this is the CSP hardening).
    const [evilPtr, evilLen] = write("globalThis.pwned = true", base);
    expect(() => wbg![noArgsKey!]!(evilPtr, evilLen)).toThrow(
      /Blocked unexpected dynamic function/,
    );

    // Allowlisted body → returns a heap handle, no throw, and no evaluation
    // of arbitrary code (the closure is a static implementation).
    const [okPtr, okLen] = write("return 0", base + 256);
    expect(() => wbg![noArgsKey!]!(okPtr, okLen)).not.toThrow();

    // Two-arg variant: the only allowlisted (args, body) pair is
    // ('path', 'return path'); anything else must be blocked.
    const [argsPtr, argsLen] = write("path", base + 512);
    const [bodyPtr, bodyLen] = write("return path", base + 640);
    expect(() => wbg![withArgsKey!]!(argsPtr, argsLen, bodyPtr, bodyLen)).not.toThrow();

    const [evilBodyPtr, evilBodyLen] = write("return globalThis", base + 768);
    expect(() => wbg![withArgsKey!]!(argsPtr, argsLen, evilBodyPtr, evilBodyLen)).toThrow(
      /Blocked unexpected dynamic function/,
    );
  }, 30_000);

  it("compiles a minimal bundle to a valid PDF through the vendored glue and wasm", async () => {
    const fonts = PDF_RUNTIME_ASSETS.fonts.map(
      (font) => new Uint8Array(readFileSync(`${PDF_FONT_CACHE_DIR}/${font.fileName}`)),
    );
    const wasm = readFileSync(VENDORED_WASM);
    const compiler = new BrowserPdfCompiler({
      wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
      fonts,
    });
    const bundle: PdfSourceBundle = {
      main: "= Vendored glue smoke\n\nCompiled through vendor/.",
      template: ATLCLI_TYPST_TEMPLATE,
      assets: [],
      sourceMap: [],
      notes: [],
    };
    const result = await compiler.compile(bundle);
    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    // %PDF magic + structural validation.
    expect(new TextDecoder().decode(result.pdf!.slice(0, 5))).toBe("%PDF-");
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true });
  }, 30_000);
});
