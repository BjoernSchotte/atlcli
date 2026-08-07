/**
 * Production-source compiler check for the T3 revision-4 cover renderer.
 *
 * This remains a component proof, not PDF acceptance evidence. T7/T8 must run
 * the public `pdf-template build` -> `wiki export --format pdf --template`
 * chain before the feature is accepted.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      metadataPosition: "bottom",
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
  design.tokens.layout.coverMetaBottomInset = "24mm";
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

function brandLockupTemplate(enabled: boolean): string {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  design.features.closingPage.enabled = enabled;
  design.compositions = {
    cover: { kind: "standard", logo: "hide" },
    closingPage: {
      kind: "brand-lockup",
      logo: "hide",
      website: "show",
      legalNotice: "show",
      align: "left",
    },
  };
  Object.assign(design.branding, {
    websiteLabel: "systems.example",
    websiteUrl: "https://systems.example/brief",
    legalNotice: "Registereintrag Zürich · Qualität 🧪",
  });
  Object.assign(design.tokens.colors, {
    closingPageBackground: "#E75204",
    closingBrandText: "#FFFFFF",
  });
  Object.assign(design.tokens.layout, {
    closingBrandBottomInset: "24mm",
    closingBrandBlockWidth: "90mm",
    closingBrandTextGap: "4mm",
  });
  Object.assign(design.typography.roles, {
    closingWebsite: { font: "heading", size: "14pt", weight: "semibold" },
    closingLegal: { font: "heading", size: "9pt", weight: "regular" },
  });
  return createAtlcliTypstTemplateV4(design);
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

async function poppler(
  pdf: Uint8Array,
  command: "pdfinfo" | "pdftotext",
  args: string[]
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-v4-renderer-"));
  try {
    const path = join(directory, "proof.pdf");
    await Bun.write(path, pdf);
    const process = Bun.spawn([command, ...args, path, "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(process.stdout).text();
    const exit = await process.exited;
    if (exit !== 0) {
      throw new Error(`${command} failed: ${await new Response(process.stderr).text()}`);
    }
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function pdfInfo(pdf: Uint8Array, args: string[] = []): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-v4-pdfinfo-"));
  try {
    const path = join(directory, "proof.pdf");
    await Bun.write(path, pdf);
    const process = Bun.spawn(["pdfinfo", ...args, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(process.stdout).text();
    const exit = await process.exited;
    if (exit !== 0) {
      throw new Error(`pdfinfo failed: ${await new Response(process.stderr).text()}`);
    }
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

  it("emits an exact brand lockup link and removes one page when closing is disabled", async () => {
    const enabled = await compiler.compile(bundle(brandLockupTemplate(true)));
    const disabled = await compiler.compile(bundle(brandLockupTemplate(false)));
    expect(enabled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(disabled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);

    const enabledInfo = await pdfInfo(enabled.pdf!);
    const disabledInfo = await pdfInfo(disabled.pdf!);
    const pages = (value: string): number =>
      Number(/^Pages:\s+(\d+)$/mu.exec(value)?.[1]);
    expect(pages(enabledInfo) - pages(disabledInfo)).toBe(1);

    const links = await pdfInfo(enabled.pdf!, ["-url"]);
    expect(links).toContain("https://systems.example/brief");
    const text = await poppler(enabled.pdf!, "pdftotext", ["-layout"]);
    expect(text).toContain("systems.example");
    expect(text).toContain("Registereintrag Zürich · Qualität");
    expect(text).not.toContain("© Registereintrag");
  }, 120_000);
});
