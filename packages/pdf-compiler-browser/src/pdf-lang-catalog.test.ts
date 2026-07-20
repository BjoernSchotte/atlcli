/**
 * Spec 011 (PDF/UA) — the document-language claim, proven against real bytes.
 *
 * `packages/pdf/src/validate.ts` reports `hasLang`, and the accessibility
 * reference page (`src/content/docs/reference/pdf-accessibility.md`) tells
 * readers the exported PDF carries a document language. Neither claim may rest
 * on reading `set text(lang: …)` in the Typst template: what matters is whether
 * a `/Lang` entry actually lands in the **document catalog** of the compiled
 * file, which only the real compiler can answer.
 *
 * So this compiles real PDFs with the pinned `BrowserPdfCompiler` (same wasm,
 * same bundled fonts the CLI and browser hosts use) and inspects the produced
 * bytes: the catalog object is located, its `/Lang` read back, and the value
 * compared against the metadata that went in. Nothing is mocked.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  validatePdfOutput,
  type ExportBlock,
  type PdfExportMetadata,
} from "@atlcli/pdf/browser";
import { serializePdfDocument } from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

const BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Language" }] },
  { type: "paragraph", content: [{ type: "text", text: "One paragraph is enough." }] },
];

function metadata(extra: Partial<PdfExportMetadata>): PdfExportMetadata {
  return {
    title: "Lang probe",
    space: "DOCSY",
    exportedAt: new Date("2026-07-19T00:00:00.000Z"),
    ...extra,
  };
}

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer());
}

let compiler: BrowserPdfCompiler;

async function compile(meta: PdfExportMetadata): Promise<Uint8Array> {
  const prepared = await preparePdfDocument(BLOCKS, {
    resolve: async () => {
      throw new Error("this fixture has no assets");
    },
  });
  const bundle = serializePdfDocument(prepared, { metadata: meta, settings: {} });
  const result = await compiler.compile(bundle);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`fixture failed to compile: ${JSON.stringify(errors)}`);
  return result.pdf!;
}

/**
 * Read `/Lang` out of the catalog object of a real PDF. Deliberately a
 * different implementation from `validatePdfOutput`'s predicate — a test that
 * reused the production matcher could only prove the matcher is
 * self-consistent, not that the byte pattern it looks for is really there.
 */
function catalogLang(pdf: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(pdf);
  const catalog = text.indexOf("/Type /Catalog");
  if (catalog < 0) return null;
  const end = text.indexOf("endobj", catalog);
  const dict = text.slice(catalog, end < 0 ? text.length : end);
  return dict.match(/\/Lang\s*\(([^)]*)\)/)?.[1] ?? null;
}

describe("compiled PDF document language (spec 011, PDF/UA 7.2)", () => {
  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    await ensureVendoredTypst();
    const [wasm, ...fonts] = await Promise.all([
      packageBytes("@atlcli/pdf-compiler-browser/wasm"),
      ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
    ]);
    compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
  }, 120_000);

  it("writes the requested language into the document catalog", async () => {
    expect(catalogLang(await compile(metadata({ language: "de" })))).toBe("de");
  }, 120_000);

  it("folds the region into a BCP-47 tag", async () => {
    expect(catalogLang(await compile(metadata({ language: "en", region: "GB" })))).toBe("en-GB");
  }, 120_000);

  it("still declares a language when the caller supplies none — which is why the audit warns", async () => {
    // The template defaults to "en", so an export with no language claims
    // ENGLISH rather than claiming nothing. A wrong declaration is worse for a
    // screen reader than a missing one, and this is exactly the case
    // `auditPdfLanguage` reports as `pdf-language-missing`.
    expect(catalogLang(await compile(metadata({})))).toBe("en");
  }, 120_000);

  it("makes validatePdfOutput report hasLang on real compiler output", async () => {
    // Closes the loop: the structural gate the export pipeline actually runs
    // agrees with the independent byte inspection above.
    const inspection = validatePdfOutput(await compile(metadata({ language: "fr" })));
    expect(inspection.hasLang).toBe(true);
    expect(inspection.tagged).toBe(true);
  }, 120_000);
});
