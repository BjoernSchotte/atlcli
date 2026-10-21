/**
 * Cover and closing-page toggles against the real Typst compiler: the
 * per-export settings switch every template revision, and a Catalog-V4
 * (revision 6) template carries its own defaults.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { validateManifestV3 } from "@atlcli/template-pack";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  type ExportBlock,
  type PdfExportMetadata,
  type PdfTemplateSettings,
} from "@atlcli/pdf/browser";
import {
  BUILTIN_PDF_TEMPLATE_BASELINE_V2,
  PDF_TEMPLATE_CAPABILITIES_V4,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V4,
  serializePdfDocument,
  type PdfTemplateManifestV5,
} from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

const BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Release notes" }] },
  { type: "paragraph", content: [{ type: "text", text: "One page of body." }] },
];

const METADATA: PdfExportMetadata = {
  title: "Page toggles",
  space: "DOCSY",
  version: 1,
  author: "atlcli",
  exporter: "atlcli",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-10-21T00:00:00.000Z"),
};

let compiler: BrowserPdfCompiler;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer());
}

function revision6(toggles: { cover?: boolean; closingPage?: boolean }): PdfTemplateManifestV5 {
  const design = structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V2.design);
  if (toggles.cover !== undefined) design.compositions.cover.enabled = toggles.cover;
  if (toggles.closingPage !== undefined) design.compositions.closingPage.enabled = toggles.closingPage;
  return validateManifestV3({
    schemaVersion: 1,
    id: "fixture.page-toggles",
    name: "Page toggles",
    version: "1.0.0",
    engine: { kind: "typst", api: "wiki.pdf-template/v1", entry: "atlcli.typ", compilerRange: ">=0.15.1 <0.16" },
    canonicalSource: { api: "wiki.pdf-canonical-typst", revision: "6" },
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V4.id,
      version: PDF_TEMPLATE_CAPABILITIES_V4.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V4,
    },
    design,
    localization: structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V2.localization),
    requiredFonts: PDF_RUNTIME_ASSETS.fonts,
  });
}

/** Page texts of the compiled PDF, one string per page. */
async function pages(
  settings: PdfTemplateSettings,
  templateManifest?: PdfTemplateManifestV5,
): Promise<string[]> {
  const prepared = await preparePdfDocument(BLOCKS, {
    resolve: async () => {
      throw new Error("no external assets");
    },
  });
  const bundle = serializePdfDocument(prepared, {
    metadata: METADATA,
    settings,
    ...(templateManifest ? { templateManifest } : {}),
  });
  const result = await compiler.compile(bundle);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  const document = await getDocument({ data: new Uint8Array(result.pdf!) }).promise;
  const texts: string[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const content = await (await document.getPage(index)).getTextContent();
    texts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return texts;
}

// Letter tracking splits the eyebrows; the metadata labels stay whole.
const hasClosing = (texts: string[]) => /PAGES/u.test(texts.at(-1) ?? "");
const hasCover = (texts: string[]) => /EXPORTED BY/u.test(texts[0] ?? "");

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}, 120_000);

describe("cover and closing-page toggles (real compiler)", () => {
  it("drops the built-in closing page only on an explicit per-export switch", async () => {
    const full = await pages({ outline: false });
    expect(hasCover(full)).toBe(true);
    expect(hasClosing(full)).toBe(true);

    const bare = await pages({ outline: false, cover: false, closingPage: false });
    expect(bare).toHaveLength(full.length - 2);
    expect(hasCover(bare)).toBe(false);
    expect(hasClosing(bare)).toBe(false);
    expect(bare[0]).toContain("One page of body.");
  }, 120_000);

  it("honors revision-6 template defaults and lets the export override them", async () => {
    const withPages = await pages({ outline: false }, revision6({}));
    expect(hasCover(withPages)).toBe(true);
    expect(hasClosing(withPages)).toBe(true);
    // The template enables its contents page; `outline: false` still drops it.
    expect(withPages.some((page) => /Contents/u.test(page))).toBe(false);
    const withContents = await pages({}, revision6({}));
    expect(withContents).toHaveLength(withPages.length + 1);

    const templateOff = revision6({ cover: false, closingPage: false });
    const bare = await pages({ outline: false }, templateOff);
    expect(bare).toHaveLength(withPages.length - 2);
    expect(hasCover(bare)).toBe(false);
    expect(hasClosing(bare)).toBe(false);

    // The per-export switch wins over the template default in both directions.
    const forced = await pages({ outline: false, cover: true, closingPage: true }, templateOff);
    expect(hasCover(forced)).toBe(true);
    expect(hasClosing(forced)).toBe(true);
    const suppressed = await pages({ outline: false, cover: false, closingPage: false }, revision6({}));
    expect(suppressed).toHaveLength(bare.length);
  }, 120_000);
});
