/**
 * Production-source compiler check for the T3 revision-4 cover renderer.
 *
 * This remains a component proof, not PDF acceptance evidence. T7/T8 must run
 * the public `pdf-template build` -> `wiki export --format pdf --template`
 * chain before the feature is accepted.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { PDF_RUNTIME_ASSETS, type PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  BUILTIN_PDF_DESIGN,
  createAtlcliTypstTemplateV4,
} from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

let compiler: BrowserPdfCompiler;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer()
  );
}

function productionTemplate(): string {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  design.compositions = {
    cover: {
      kind: "type-cut",
      logo: "hide",
      typeCut: { angle: 43, stop: 58 },
    },
    closingPage: {
      kind: "document-summary",
      logo: "hide",
      website: "hide",
      legalNotice: "hide",
      align: "left",
    },
  };
  design.tokens.colors.coverTitleInverse = "#FFFFFF";
  design.tokens.layout.coverTitleFrameHeight = "35mm";
  design.typography.roles.coverTitle = {
    font: "heading",
    size: "44pt",
    weight: "bold",
  };
  design.typography.roles.coverTitleCompact = {
    font: "heading",
    size: "34pt",
    weight: "bold",
  };
  design.typography.roles.coverTitleMinimum = {
    font: "heading",
    size: "24pt",
    weight: "bold",
  };
  return createAtlcliTypstTemplateV4(design, {
    coverEyebrow: "EXECUTIVE BRIEF",
  });
}

function bundle(template: string): PdfSourceBundle {
  return {
    main: `#import "atlcli.typ": atlcli-doc

#show: atlcli-doc.with(meta: (
  title: "Strategie für robuste digitale Plattformen",
  space: "DOCSY",
  version: "v1",
  author: "Example",
  exporter: "atlcli",
  language: "de",
  region: "DE",
  exported-at: datetime(year: 2026, month: 8, day: 7),
  exported-label: "07.08.2026",
), settings: (:))

= Inhalt

Komponentenbeleg für den Produktionsrenderer.
`,
    template,
    assets: [],
    sourceMap: [],
    notes: [],
  };
}

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
      packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)
    ),
  ]);
  compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}, 120_000);

afterAll(async () => {
  await compiler?.reset();
});

describe("canonical revision-4 production cover source", () => {
  it("compiles declared repeated hard stops and the fixed-frame fitting guard", async () => {
    const template = productionTemplate();
    expect(template).toContain('(rgb("#202A44"), 58%)');
    expect(template).toContain('(rgb("#FFFFFF"), 58%)');
    const result = await compiler.compile(bundle(template));
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.pdf?.byteLength).toBeGreaterThan(1_000);
  }, 120_000);
});
