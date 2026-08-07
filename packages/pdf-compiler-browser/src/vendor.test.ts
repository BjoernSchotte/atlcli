import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import { ATLCLI_TYPST_TEMPLATE, validatePdfOutput } from "@atlcli/pdf/internal";
import { ensurePdfFonts, PDF_FONT_CACHE_DIR } from "../../pdf/scripts/ensure-fonts.js";
import { PDF_RUNTIME_ASSETS } from "../../pdf/src/runtime-assets.js";
import { createHash } from "node:crypto";
import {
  ensureVendoredTypst,
  normalizeVendorBytes,
  verifyVendoredTypst,
  TYPST_CORE_COMMIT,
  TYPST_CORE_VERSION,
  TYPST_VENDOR_PINS,
  VENDORED_MJS,
  VENDORED_WASM,
} from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./compiler.js";

/**
 * Vendored typst.ts regression tests (spec 009, Special cases) — no mocks.
 *
 * Loads the real vendored glue + WASM under Bun, validates its immutable fork
 * provenance, and exercises the static fail-closed access-model callbacks.
 */

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
});

describe("vendored typst.ts glue (spec 009)", () => {
  it("verifies exact files, provenance, sha256 pins, and CSP-safe glue", () => {
    expect(() => verifyVendoredTypst()).not.toThrow();
    const glue = readFileSync(VENDORED_MJS, "utf8");
    expect(glue).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(glue).not.toMatch(/(?:^|[=(:,;]\s*)Function\s*\(/m);
    expect(glue).not.toMatch(/(?:^|[^\w$.])eval\s*\(/m);
  });

  it("line-ending normalization makes the glue sha platform-independent (Windows CRLF regression)", () => {
    // Keep the original Windows regression covered now that the source is a
    // staged fork package rather than a Bun-patched npm package.
    const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    const lf = readFileSync(VENDORED_MJS);
    const crlf = Buffer.from(lf.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
    const pin = TYPST_VENDOR_PINS["typst_ts_web_compiler.mjs"]!;

    // Sanity: raw CRLF bytes do NOT match the pin (this is the Windows symptom).
    expect(sha(crlf)).not.toBe(pin);
    // Normalized CRLF and normalized LF both hash to the committed LF pin.
    expect(sha(normalizeVendorBytes("typst_ts_web_compiler.mjs", crlf))).toBe(pin);
    expect(sha(normalizeVendorBytes("typst_ts_web_compiler.mjs", lf))).toBe(pin);

    // Binary wasm must pass through byte-for-byte (normalization would corrupt it).
    const wasm = new Uint8Array(readFileSync(VENDORED_WASM));
    expect(normalizeVendorBytes("typst_ts_web_compiler_bg.wasm", wasm)).toEqual(wasm);
  });

  it("self-identifies as exact Typst 0.15.1 and its static dummy services fail closed", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const freshGluePath = join(mkdtempSync(join(tmpdir(), "atlcli-vendor-glue-")), "glue.mjs");
    writeFileSync(freshGluePath, readFileSync(VENDORED_MJS));
    const glue = (await import(freshGluePath)) as {
      default: (options: { module_or_path: ArrayBuffer }) => Promise<unknown>;
      embedded_typst_version: () => string;
      embedded_typst_commit: () => string | undefined;
      TypstCompilerBuilder: new () => {
        build(): Promise<{
          add_source(path: string, source: string): boolean;
          compile(path: string, inputs: unknown[], format: string, diagnostics: number): {
            hasError?: boolean;
            diagnostics?: Array<{ message?: string }>;
          };
          reset_shadow(): void;
          free(): void;
        }>;
      };
    };
    const wasmBytes = readFileSync(VENDORED_WASM);
    await glue.default({
      module_or_path: wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ) as ArrayBuffer,
    });
    expect(glue.embedded_typst_version()).toBe(TYPST_CORE_VERSION);
    expect(glue.embedded_typst_commit()).toBe(TYPST_CORE_COMMIT);

    const compiler = await new glue.TypstCompilerBuilder().build();
    try {
      const originalConsoleError = console.error;
      const accessErrors: string[] = [];
      console.error = (...args) => accessErrors.push(args.map(String).join(" "));
      let missingSource;
      try {
        missingSource = compiler.compile("/missing.typ", [], "pdf", 3);
      } finally {
        console.error = originalConsoleError;
      }
      expect(missingSource.hasError).toBe(true);
      expect(accessErrors.some((message) => message.includes("Dummy AccessModel"))).toBe(true);

      compiler.add_source("/registry.typ", '#import "@preview/cetz:0.3.4"');
      const missingPackage = compiler.compile("/registry.typ", [], "pdf", 3);
      expect(missingPackage.hasError).toBe(true);
      expect(
        missingPackage.diagnostics?.some((diagnostic) =>
          diagnostic.message?.includes("Dummy Registry, please initialize compiler")
        ),
      ).toBe(true);
    } finally {
      compiler.reset_shadow();
      compiler.free();
    }
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
