/**
 * Spec 012 T6.5 — the second curated template ("Manuscript") proves the
 * abstraction: it renders through the IDENTICAL engine code path as the
 * built-in ("Editorial Indigo"), with zero new `template.ts` branches — only a
 * different, validated manifest. Verified against the REAL Typst compiler.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  type ExportBlock,
  type PdfExportMetadata,
} from "@atlcli/pdf/browser";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
  BUILTIN_PDF_TEMPLATES,
  serializePdfDocument,
} from "@atlcli/pdf/internal";
import { packTemplate, unpackTemplate, validateManifest } from "@atlcli/template-pack";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

const BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Manuscript" }] },
  { type: "paragraph", content: [{ type: "text", text: "Body copy in the second template." }] },
  { type: "heading", level: 2, content: [{ type: "text", text: "Section" }] },
  { type: "callout", kind: "info", title: "Info", content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }] },
  {
    type: "table",
    rows: [
      { cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "K" }] }] }] },
      { cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "v" }] }] }] },
    ],
  },
];

const META: PdfExportMetadata = {
  title: "Second Template",
  space: "DOCSY",
  version: 2,
  author: "Ada",
  exporter: "atlcli",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-19T00:00:00.000Z"),
};

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer());
}

async function createCompiler(): Promise<BrowserPdfCompiler> {
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  return new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}

async function compileWith(
  compiler: BrowserPdfCompiler,
  templateManifest?: typeof MANUSCRIPT_PDF_TEMPLATE_MANIFEST
): Promise<{ pdf: Uint8Array; diagnostics: unknown[] }> {
  const prepared = await preparePdfDocument(BLOCKS, {
    resolve: async () => {
      throw new Error("no external assets");
    },
  });
  const bundle = serializePdfDocument(prepared, {
    metadata: META,
    ...(templateManifest ? { templateManifest } : {}),
  });
  const result = await compiler.compile(bundle);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`compile errors: ${JSON.stringify(errors)}`);
  return { pdf: result.pdf!, diagnostics: result.diagnostics };
}

describe("spec 012 second curated template (real compiler)", () => {
  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    await ensureVendoredTypst();
  });

  it("differs meaningfully from the built-in (fonts, accent, page master, typography)", () => {
    const a = BUILTIN_PDF_TEMPLATE_MANIFEST.design!;
    const b = MANUSCRIPT_PDF_TEMPLATE_MANIFEST.design!;
    // Not a color-only swap: font pairing, accent, margins, and heading scale all differ.
    expect(b.typography.fonts.body).not.toBe(a.typography.fonts.body);
    expect(b.typography.fonts.heading).not.toBe(a.typography.fonts.heading);
    expect(b.branding.accent).not.toBe(a.branding.accent);
    expect(b.page.margin.top).not.toBe(a.page.margin.top);
    expect(b.typography.roles.h1!.size).not.toBe(a.typography.roles.h1!.size);
    expect(b.tokens.layout.coverRuleLength).not.toBe(a.tokens.layout.coverRuleLength);
  });

  it("both curated templates are registered and share the same engine api", () => {
    expect(Object.keys(BUILTIN_PDF_TEMPLATES)).toEqual([
      "builtin.editorial-indigo",
      "builtin.manuscript",
    ]);
    for (const manifest of Object.values(BUILTIN_PDF_TEMPLATES)) {
      expect(manifest.engine.api).toBe("wiki.pdf-template/v1");
      expect(manifest.engine.entry).toBe("atlcli.typ");
    }
  });

  it("compiles cleanly through the identical engine path and produces distinct bytes", async () => {
    const compiler = await createCompiler();
    const builtin = await compileWith(compiler);
    const manuscript = await compileWith(compiler, MANUSCRIPT_PDF_TEMPLATE_MANIFEST);
    expect(manuscript.diagnostics.filter((d) => (d as { severity: string }).severity === "error")).toEqual([]);
    // The different design produces a genuinely different rendering.
    const digest = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    expect(digest(manuscript.pdf)).not.toBe(digest(builtin.pdf));
  }, 120_000);

  it("packs into the .wiki-pdf-template container and round-trips the design", async () => {
    const files = { "atlcli.typ": new TextEncoder().encode("// engine-native built-in template\n") };
    const archive = await packTemplate({ manifest: MANUSCRIPT_PDF_TEMPLATE_MANIFEST, files });
    const unpacked = unpackTemplate(archive);
    const revalidated = validateManifest(unpacked.manifest);
    expect(revalidated.id).toBe("builtin.manuscript");
    expect(revalidated.design?.typography.fonts.heading).toBe("Source Serif 4");
    expect(revalidated.design?.branding.accent).toBe("#0B6E4F");
  }, 30_000);
});
