/**
 * T6 render proof for DOCX-derived template assets.
 *
 * The test uses the pinned Typst-WASM compiler, then rasterizes every page
 * through Poppler. Color probes prove first/odd/even/all scopes from rendered
 * pixels rather than from generated source inspection.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
  PDF_RUNTIME_ASSETS,
  PdfTemplatePreviewCompiler as BrowserTemplatePreviewCompiler,
  buildUniformPdfPageBorderV1,
  loadPdfTemplatePack,
  preparePdfDocument,
  validatePdfOutput,
  type ExportBlock,
} from "@atlcli/pdf/browser";
import {
  PdfTemplatePreviewCompiler as NodeTemplatePreviewCompiler,
} from "@atlcli/pdf";
import {
  BUILTIN_PDF_DESIGN,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_TEMPLATE_WRITERS_V1,
  serializePdfDocument,
} from "@atlcli/pdf/internal";
import {
  packTemplate,
  validateManifest,
  type WikiPdfTemplateImageDecorationV1,
} from "@atlcli/template-pack";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

const encoder = new TextEncoder();
let compiler: BrowserPdfCompiler;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer()
  );
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer
  );
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function colorSvg(color: string, width: number, height: number): Uint8Array {
  return encoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`
  );
}

async function fixturePack(): Promise<Uint8Array> {
  const sources = {
    logo: colorSvg("#AA00AA", 120, 40),
    page: colorSvg("#FF0000", 80, 80),
    cover: colorSvg("#00FF00", 80, 80),
    header: colorSvg("#0000FF", 80, 24),
    footer: colorSvg("#FFFF00", 80, 24),
  } as const;
  const slots = {
    "asset.logo": { descriptor: "logo", decorative: false, alt: "Example mark" },
    "asset.pageBackground": { descriptor: "page", decorative: true },
    "asset.coverBackground": { descriptor: "cover", decorative: true },
    "asset.headerDecoration": { descriptor: "header", decorative: true },
    "asset.footerDecoration": { descriptor: "footer", decorative: true },
  } as const;
  const assetDescriptors: Record<string, unknown> = {};
  const files: Record<string, Uint8Array> = {
    "atlcli.typ": encoder.encode("// canonical source is regenerated in T7"),
  };
  for (const [id, bytes] of Object.entries(sources)) {
    const width = id === "logo" ? 120 : 80;
    const height = id === "logo" ? 40 : id === "page" || id === "cover" ? 80 : 24;
    const path = `assets/${id}.svg`;
    files[path] = bytes;
    assetDescriptors[id] = {
      path,
      sha256: await digest(bytes),
      mediaType: "image/svg+xml",
      byteLength: bytes.byteLength,
      dimensions: { width, height, unit: "pixel" },
    };
  }
  const decoration = (
    id: keyof typeof slots,
    scope: WikiPdfTemplateImageDecorationV1["scope"],
    layer: WikiPdfTemplateImageDecorationV1["layer"],
    x: string,
    y: string,
    width: string,
    height: string
  ): WikiPdfTemplateImageDecorationV1 => ({
    kind: "image",
    id,
    writer: PDF_TEMPLATE_WRITERS_V1.imageDecoration,
    scope,
    layer,
    asset: id,
    placement: {
      relativeTo: layer === "page-background" ? "page" : "margin",
      fit: "stretch",
      x,
      y,
      width,
      height,
    },
    decorative: true,
  });
  const border = buildUniformPdfPageBorderV1([
    {
      section: 0,
      offsetFrom: "page",
      sides: (["top", "right", "bottom", "left"] as const).map((side) => ({
        side,
        style: "single",
        color: "00FFFF",
        widthEighthPoints: 12,
      })),
    },
  ])!;
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  design.page = {
    size: "letter",
    orientation: "landscape",
    margin: { top: "15mm", right: "16mm", bottom: "15mm", left: "16mm" },
  };
  design.branding.accent = "#006644";
  design.typography.fonts.body = "Source Sans 3";
  design.typography.fonts.heading = "Source Serif 4";
  const manifest = validateManifest({
    schemaVersion: 1,
    id: "fixture.visual-scopes",
    name: "Visual scope proof",
    version: "1.0.0",
    engine: {
      kind: "typst",
      api: "wiki.pdf-template/v1",
      entry: "atlcli.typ",
      compilerRange: ">=0.14 <0.15",
    },
    requiredFonts: PDF_RUNTIME_ASSETS.fonts,
    design,
    bindings: BUILTIN_PDF_TEMPLATE_MANIFEST.bindings,
    localization: BUILTIN_PDF_TEMPLATE_MANIFEST.localization,
    canonicalSource: {
      api: "wiki.pdf-canonical-typst",
      revision: "1",
    },
    assetDescriptors,
    assets: Object.fromEntries(
      Object.entries(slots).map(([slot, reference]) => [
        slot,
        {
          ...reference,
          writer:
            slot === "asset.logo"
              ? PDF_TEMPLATE_WRITERS_V1.logo
              : PDF_TEMPLATE_WRITERS_V1.imageDecoration,
        },
      ])
    ),
    decorations: [
      decoration(
        "asset.pageBackground",
        "odd",
        "page-background",
        "42mm",
        "4mm",
        "18mm",
        "18mm"
      ),
      decoration(
        "asset.coverBackground",
        "first",
        "page-background",
        "68mm",
        "4mm",
        "18mm",
        "18mm"
      ),
      decoration(
        "asset.headerDecoration",
        "even",
        "header",
        "0mm",
        "0mm",
        "24mm",
        "6mm"
      ),
      decoration(
        "asset.footerDecoration",
        "all",
        "footer",
        "0mm",
        "0mm",
        "24mm",
        "6mm"
      ),
      border,
    ],
  });
  return packTemplate({ manifest, files });
}

const blocks: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Page one" }] },
  { type: "paragraph", content: [{ type: "text", text: "Scope proof." }] },
  { type: "pageBreak" },
  { type: "heading", level: 1, content: [{ type: "text", text: "Page two" }] },
  { type: "pageBreak" },
  { type: "heading", level: 1, content: [{ type: "text", text: "Page three" }] },
  { type: "pageBreak" },
  { type: "heading", level: 1, content: [{ type: "text", text: "Page four" }] },
];

interface Ppm {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function parsePpm(bytes: Uint8Array): Ppm {
  let offset = 0;
  const token = (): string => {
    while (bytes[offset] === 0x20 || bytes[offset] === 0x0a || bytes[offset] === 0x0d) {
      offset += 1;
    }
    const start = offset;
    while (
      offset < bytes.length &&
      bytes[offset] !== 0x20 &&
      bytes[offset] !== 0x0a &&
      bytes[offset] !== 0x0d
    ) {
      offset += 1;
    }
    return new TextDecoder().decode(bytes.subarray(start, offset));
  };
  expect(token()).toBe("P6");
  const width = Number(token());
  const height = Number(token());
  expect(token()).toBe("255");
  while (bytes[offset] === 0x20 || bytes[offset] === 0x0a || bytes[offset] === 0x0d) {
    offset += 1;
  }
  return { width, height, pixels: bytes.subarray(offset) };
}

function colorPixels(
  page: Ppm,
  [red, green, blue]: readonly [number, number, number]
): number {
  let count = 0;
  for (let index = 0; index + 2 < page.pixels.length; index += 3) {
    if (
      Math.abs(page.pixels[index]! - red) <= 8 &&
      Math.abs(page.pixels[index + 1]! - green) <= 8 &&
      Math.abs(page.pixels[index + 2]! - blue) <= 8
    ) {
      count += 1;
    }
  }
  return count;
}

function inflatedPdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder("latin1").decode(bytes);
  const parts = [raw];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    while (
      stop > start &&
      (bytes[stop - 1] === 0x0a || bytes[stop - 1] === 0x0d)
    ) {
      stop -= 1;
    }
    try {
      parts.push(inflateSync(bytes.subarray(start, stop)).toString("latin1"));
    } catch {
      // Font/image/non-Flate stream.
    }
  }
  return parts.join("\n");
}

async function rasterPages(pdf: Uint8Array): Promise<Ppm[]> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-t6-raster-"));
  try {
    const input = join(directory, "proof.pdf");
    const prefix = join(directory, "page");
    await Bun.write(input, pdf);
    const process = Bun.spawn(
      ["pdftoppm", "-r", "36", input, prefix],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exit = await process.exited;
    if (exit !== 0) {
      throw new Error(
        `pdftoppm failed: ${await new Response(process.stderr).text()}`
      );
    }
    const files = (await readdir(directory))
      .filter((name) => /^page-\d+\.ppm$/u.test(name))
      .sort((left, right) =>
        Number(/\d+/u.exec(left)![0]) - Number(/\d+/u.exec(right)![0])
      );
    return Promise.all(
      files.map(async (name) =>
        parsePpm(new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()))
      )
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function extractedText(pdf: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-t6-text-"));
  try {
    const input = join(directory, "preview.pdf");
    await Bun.write(input, pdf);
    const process = Bun.spawn(["pdftotext", "-layout", input, "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(process.stdout).text();
    const exit = await process.exited;
    if (exit !== 0) {
      throw new Error(
        `pdftotext failed: ${await new Response(process.stderr).text()}`
      );
    }
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function resultBytes(
  result: Awaited<ReturnType<InstanceType<typeof BrowserTemplatePreviewCompiler>["render"]>>
): Uint8Array {
  if (result.output.kind !== "bytes") {
    throw new Error("test preview unexpectedly returned an asset handle");
  }
  return result.output.bytes;
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
});

afterAll(async () => {
  await compiler?.reset();
});

describe("DOCX template visual assets through real Typst-WASM", () => {
  it("compiles every V1 slot and the uniform border as decorative PDF content", async () => {
    const pack = await loadPdfTemplatePack(await fixturePack());
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("feature zoo has no document assets");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Template asset proof",
        space: "DEMO",
        version: 1,
        author: "Example",
        language: "en",
        exportedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
      settings: { cover: true, outline: false },
      templatePack: pack,
    });
    expect(bundle.assets.map(({ path }) => path).sort()).toEqual([
      "template-assets/cover.svg",
      "template-assets/footer.svg",
      "template-assets/header.svg",
      "template-assets/logo.svg",
      "template-assets/page.svg",
    ]);
    const result = await compiler.compile(bundle);
    const errors = result.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length > 0) {
      const line = errors[0]?.startLine ?? 1;
      const source = bundle.template.split("\n");
      throw new Error(
        `${JSON.stringify(errors)}\n${source
          .slice(Math.max(0, line - 4), line + 3)
          .map((value, index) => `${Math.max(1, line - 3) + index}: ${value}`)
          .join("\n")}`
      );
    }
    const pdf = result.pdf!;
    const inspection = validatePdfOutput(pdf);
    expect(inspection).toMatchObject({
      tagged: true,
      hasOutline: true,
    });
    const raw = inflatedPdfText(pdf);
    expect(bundle.template).toContain('pdf.artifact(kind: "other"');
    // Decorative ornaments are artifacts; only the meaning-bearing logo may
    // create a Figure structure element.
    expect([...raw.matchAll(/\/S\s*\/Figure\b/g)]).toHaveLength(1);

    const pages = await rasterPages(pdf);
    expect(pages.length).toBeGreaterThanOrEqual(6);
    const red = pages.map((page) => colorPixels(page, [255, 0, 0]) > 20);
    const green = pages.map((page) => colorPixels(page, [0, 255, 0]) > 20);
    const blue = pages.map((page) => colorPixels(page, [0, 0, 255]) > 20);
    const yellow = pages.map((page) => colorPixels(page, [255, 255, 0]) > 20);
    const purple = pages.map((page) => colorPixels(page, [170, 0, 170]) > 20);
    expect(green).toEqual(pages.map((_, index) => index === 0));
    expect(red).toEqual(pages.map((_, index) => index % 2 === 0));
    expect(blue).toEqual(pages.map((_, index) => index % 2 === 1));
    expect(yellow).toEqual(pages.map(() => true));
    expect(purple).toEqual(pages.map((_, index) => index === 0));
    // Cyan border pixels must be visible on every rasterized page.
    expect(
      pages.map((page) => colorPixels(page, [0, 255, 255]) > 20)
    ).toEqual(pages.map(() => true));
  }, 120_000);

  it("renders design review, compatibility proof, and contact sheet through the host-neutral adapter", async () => {
    const pack = await loadPdfTemplatePack(await fixturePack());
    const request = {
      generation: "generation-t6",
      snapshotDigest: "a".repeat(64),
      purpose: "design-review" as const,
      summary: {
        readyToApply: 12,
        needsReview: 4,
        cannotTransfer: 3,
        blockers: 1,
        unanswered: 4,
      },
    };
    const resolveModel = async () => ({
      baseline: BUILTIN_PDF_TEMPLATE_MANIFEST,
      current: pack.manifest,
      currentPack: pack,
    });
    const browserAdapter = new BrowserTemplatePreviewCompiler({
      compiler,
      resolveModel,
    });
    const review = await browserAdapter.render(request);
    expect(review.pageCount).toBe(2);
    expect(review.regions).toEqual([
      { page: 1, region: "summary" },
      { page: 2, region: "baseline" },
      { page: 2, region: "current" },
    ]);
    const reviewBytes = resultBytes(review);
    const text = await extractedText(reviewBytes);
    expect(text).toContain("Ready to apply");
    expect(text).toContain("12");
    expect(text).toContain("Needs review");
    expect(text).toContain("4");
    expect(text).toContain("Cannot transfer");
    expect(text).toContain("3");
    expect(text).toContain("Blockers");
    expect(text).toContain("1");
    expect(text).toContain("Unanswered");
    expect(text).toContain("a4 / portrait");
    expect(text).toContain("letter / landscape");
    const inspectable = inflatedPdfText(reviewBytes);
    expect(inspectable).toContain("SourceSerif4");
    expect(inspectable).toContain("SourceSans3");
    const reviewPages = await rasterPages(reviewBytes);
    expect(
      reviewPages.some((page) => colorPixels(page, [75, 87, 163]) > 20)
    ).toBe(true);
    expect(
      reviewPages.some((page) => colorPixels(page, [0, 102, 68]) > 20)
    ).toBe(true);
    expect(
      reviewPages.some((page) => colorPixels(page, [255, 0, 0]) > 20)
    ).toBe(true);

    const compatibility = await browserAdapter.render({
      ...request,
      purpose: "compatibility-proof",
    });
    expect(resultBytes(compatibility).subarray(0, 5)).toEqual(
      encoder.encode("%PDF-")
    );
    expect(compatibility.regions).toEqual([
      { page: 1, region: "feature-zoo" },
    ]);

    const contact = await browserAdapter.render({
      ...request,
      purpose: "asset-contact-sheet",
    });
    const contactText = await extractedText(resultBytes(contact));
    expect(contactText).toContain("Asset contact sheet");
    expect(contactText).toContain("Role: asset.logo");
    expect(contactText).not.toContain("assets/");
    expect(contact.regions).toEqual([{ page: 1, region: "asset-grid" }]);
  }, 120_000);

  it("returns byte-identical previews through the Node and browser PDF entries", async () => {
    const pack = await loadPdfTemplatePack(await fixturePack());
    const request = {
      generation: "generation-parity",
      snapshotDigest: "b".repeat(64),
      purpose: "design-review" as const,
      summary: {
        readyToApply: 2,
        needsReview: 1,
        cannotTransfer: 1,
        blockers: 0,
        unanswered: 1,
      },
    };
    const resolveModel = async () => ({
      baseline: BUILTIN_PDF_TEMPLATE_MANIFEST,
      current: pack.manifest,
      currentPack: pack,
    });
    const nodeResult = await new NodeTemplatePreviewCompiler({
      compiler,
      resolveModel,
    }).render(request);
    const browserResult = await new BrowserTemplatePreviewCompiler({
      compiler,
      resolveModel,
    }).render(request);
    expect({
      digest: nodeResult.digest,
      mediaType: nodeResult.mediaType,
      byteLength: nodeResult.byteLength,
      pageCount: nodeResult.pageCount,
      regions: nodeResult.regions,
    }).toEqual({
      digest: browserResult.digest,
      mediaType: browserResult.mediaType,
      byteLength: browserResult.byteLength,
      pageCount: browserResult.pageCount,
      regions: browserResult.regions,
    });
    expect(resultBytes(nodeResult)).toEqual(resultBytes(browserResult));
  }, 120_000);
});
