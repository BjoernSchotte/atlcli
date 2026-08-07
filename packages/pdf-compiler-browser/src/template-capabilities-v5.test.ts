/** Real Typst-WASM proof for canonical revision 5 page and running regions. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type { ExportBlock } from "@atlcli/confluence";
import sharp from "sharp";
import {
  validateManifestV3,
  validatePdfTemplateDesignV3,
  type WikiPdfTemplateDesignV3,
} from "@atlcli/template-pack";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDF_RUNTIME_ASSETS, type PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  BUILTIN_PDF_TEMPLATE_BASELINE_V1,
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
  createAtlcliTypstTemplateV5,
  preparePdfDocument,
  serializePdfDocument,
  type PdfTemplateManifestV5,
  type PdfTemplateVisualsV1,
} from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

let compiler: BrowserPdfCompiler;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer(),
  );
}

function design() {
  return validatePdfTemplateDesignV3(
    structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1.design),
  );
}

function bundle(
  template: string,
  body = "= Body\n\nRevision 5 proof.",
  assets: PdfSourceBundle["assets"] = [],
): PdfSourceBundle {
  return {
    main: `#import "atlcli.typ": atlcli-doc

#show: atlcli-doc.with(meta: (
  title: "Revision 5 proof",
  space: "DOCSY",
  version: "v5",
  author: "atlcli",
  exporter: "atlcli",
  language: "en",
  region: "GB",
  exported-at: datetime(year: 2026, month: 8, day: 7),
  exported-label: "7 August 2026",
), settings: (:))

${body}
`,
    template,
    assets,
    sourceMap: [],
    notes: [],
  };
}

async function rasterPage(
  pdf: Uint8Array,
  page = 1,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-v5-raster-"));
  try {
    const path = join(directory, "proof.pdf");
    const prefix = join(directory, "page");
    await Bun.write(path, pdf);
    const process = Bun.spawn([
      "pdftoppm",
      "-f",
      String(page),
      "-singlefile",
      "-r",
      "72",
      "-png",
      path,
      prefix,
    ], { stdout: "pipe", stderr: "pipe" });
    if (await process.exited !== 0) {
      throw new Error(`pdftoppm failed: ${await new Response(process.stderr).text()}`);
    }
    const raster = await sharp(join(directory, "page.png"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(raster.data),
      width: raster.info.width,
      height: raster.info.height,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pixelAtMm(
  raster: { data: Uint8Array; width: number; height: number },
  xMm: number,
  yMm: number,
): readonly [number, number, number] {
  const x = Math.min(raster.width - 1, Math.max(0, Math.round(xMm * 72 / 25.4)));
  const y = Math.min(raster.height - 1, Math.max(0, Math.round(yMm * 72 / 25.4)));
  const offset = (y * raster.width + x) * 3;
  return [raster.data[offset]!, raster.data[offset + 1]!, raster.data[offset + 2]!];
}

function inspectablePdf(pdf: Uint8Array): string {
  const latin1 = new TextDecoder("latin1").decode(pdf);
  let text = latin1;
  const streams = /stream\r?\n/gu;
  let match: RegExpExecArray | null;
  while ((match = streams.exec(latin1))) {
    const start = match.index + match[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    while (stop > start && (pdf[stop - 1] === 0x0a || pdf[stop - 1] === 0x0d)) {
      stop -= 1;
    }
    try {
      text += `\n${inflateSync(pdf.subarray(start, stop)).toString("latin1")}`;
    } catch {
      // Font and image streams are not FlateDecode text streams.
    }
  }
  return text;
}

function manifest(
  mutate?: (value: WikiPdfTemplateDesignV3) => void,
): PdfTemplateManifestV5 {
  const value = design();
  mutate?.(value);
  return validateManifestV3({
    schemaVersion: 1,
    id: "fixture.compiler-catalog-v3",
    name: "Compiler Catalog V3 fixture",
    version: "1.0.0",
    engine: {
      kind: "typst",
      api: "wiki.pdf-template/v1",
      entry: "atlcli.typ",
      compilerRange: ">=0.15.1 <0.16",
    },
    canonicalSource: { api: "wiki.pdf-canonical-typst", revision: "5" },
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V3.id,
      version: PDF_TEMPLATE_CAPABILITIES_V3.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
    },
    design: value,
    requiredFonts: PDF_RUNTIME_ASSETS.fonts,
  });
}

async function serializedBundle(
  blocks: ExportBlock[],
  templateManifest: PdfTemplateManifestV5,
): Promise<PdfSourceBundle> {
  const prepared = await preparePdfDocument(blocks, {
    resolve: async () => {
      throw new Error("component proof does not use assets");
    },
  });
  return serializePdfDocument(prepared, {
    metadata: {
      title: "Revision 5 component proof",
      space: "DOCSY",
      author: "atlcli",
      exporter: "atlcli",
      language: "en",
      region: "GB",
      exportedAt: new Date("2026-08-07T00:00:00Z"),
    },
    templateManifest,
  });
}

async function pdfOutline(pdf: Uint8Array): Promise<unknown[]> {
  const loading = getDocument({
    data: Uint8Array.from(pdf),
  });
  const document = await loading.promise;
  try {
    return (await document.getOutline()) ?? [];
  } finally {
    await loading.destroy();
  }
}

function outlineTitles(nodes: readonly unknown[]): string[] {
  const titles: string[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    if (typeof record.title === "string") titles.push(record.title);
    if (Array.isArray(record.items)) titles.push(...outlineTitles(record.items));
  }
  return titles;
}

async function pdfPageLabels(pdf: Uint8Array): Promise<readonly string[]> {
  const loading = getDocument({
    data: Uint8Array.from(pdf),
  });
  const document = await loading.promise;
  try {
    return (await document.getPageLabels()) ?? [];
  } finally {
    await loading.destroy();
  }
}

async function poppler(
  pdf: Uint8Array,
  command: "pdfinfo" | "pdftotext",
  args: string[] = [],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-v5-page-"));
  try {
    const path = join(directory, "proof.pdf");
    await Bun.write(path, pdf);
    const commandArgs = command === "pdftotext"
      ? [command, ...args, path, "-"]
      : [command, ...args, path];
    const process = Bun.spawn(commandArgs, { stdout: "pipe", stderr: "pipe" });
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

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
      packageBytes(`@atlcli/pdf/fonts/${font.fileName}`),
    ),
  ]);
  compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}, 120_000);

afterAll(async () => {
  await compiler?.reset();
});

describe("canonical revision-5 page and running-region source", () => {
  it("compiles the neutral Catalog-V3 baseline with Typst 0.15.1", async () => {
    const result = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(design())),
    );
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.pdf?.byteLength).toBeGreaterThan(1_000);
  }, 120_000);

  it("emits custom landscape geometry, logical margins, binding, and PDF bleed boxes", async () => {
    const custom = design();
    custom.page = {
      format: { kind: "custom", width: "180mm", height: "240mm" },
      orientation: "landscape",
      binding: "right",
      margin: {
        mode: "logical",
        top: "18mm",
        bottom: "20mm",
        inside: "25mm",
        outside: "15mm",
      },
      bleed: {
        top: "3mm",
        bottom: "3mm",
        inside: "4mm",
        outside: "5mm",
      },
    };
    const result = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(custom)),
    );
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const info = await poppler(result.pdf!, "pdfinfo", ["-box"]);
    expect(info).toContain("Page size:");
    expect(info).toContain("TrimBox:");
    expect(info).toContain("BleedBox:");
    expect(info.match(/^TrimBox:\s+(.+)$/mu)?.[1]).not.toBe(
      info.match(/^MediaBox:\s+(.+)$/mu)?.[1],
    );
  }, 120_000);

  it("switches first, odd, and even running variants and renders current-of-total", async () => {
    const running = design();
    running.navigation = {
      ...running.navigation,
      contents: { ...running.navigation.contents, enabled: false },
    };
    running.compositions.running.header = {
      enabled: true,
      layout: "split",
      first: "hide",
      odd: {
        start: { field: "literal", value: "ODD-MARKER" },
        end: { field: "chapterTitle" },
      },
      even: {
        start: { field: "literal", value: "EVEN-MARKER" },
        end: { field: "documentTitle" },
      },
    };
    running.compositions.running.footer = {
      enabled: true,
      layout: "single",
      first: "hide",
      odd: { center: { field: "pageNumber", numbering: "current-of-total" } },
      even: { center: { field: "pageNumber", numbering: "current-of-total" } },
    };
    const body = [1, 2, 3, 4]
      .map((page) => `= Chapter ${page}\n\nBody ${page}.`)
      .join("\n\n#pagebreak()\n\n");
    const result = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(running), body),
    );
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const text = await poppler(result.pdf!, "pdftotext", ["-layout"]);
    expect(text).toContain("ODD-MARKER");
    expect(text).toContain("EVEN-MARKER");
    expect(text).toMatch(/\b2\s*\/\s*6\b/u);
    expect((text.match(/Revision 5 proof/gu) ?? []).length).toBeGreaterThan(1);
    const bbox = await poppler(result.pdf!, "pdftotext", ["-bbox"]);
    const pages = [...bbox.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/gu)]
      .map((match) => match[1] ?? "");
    expect(pages).toHaveLength(6);
    expect(pages[0]).not.toMatch(/(?:ODD|EVEN)-MARKER/u);
    expect(pages[1]).toContain("EVEN-MARKER");
    expect(pages[2]).toContain("ODD-MARKER");
    expect(pages[3]).toContain("EVEN-MARKER");
    expect(pages[4]).toContain("ODD-MARKER");
  }, 120_000);

  it("keeps visible contents, bookmark depth, heading numbers, and page-label phases independent", async () => {
    const navigation = design();
    navigation.navigation = {
      contents: { enabled: true, depth: 3, pageNumbers: "show", leader: "dots" },
      bookmarks: { enabled: true, depth: 2, includeHeadingNumbers: true },
      headingNumbers: { enabled: true, preset: "decimal-dot" },
      pageNumbers: {
        enabled: true,
        preset: "roman-lower",
        start: 1,
        body: { preset: "arabic", start: 1 },
      },
    };
    const body = "= First\n\n== Second\n\n=== Third\n\nNavigation proof.";
    const labels = { contents: "Contents" };
    const visible = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(navigation, labels), body),
    );
    expect(visible.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const visibleText = await poppler(visible.pdf!, "pdftotext", ["-layout"]);
    expect(visibleText).toContain("Contents");
    expect(visibleText).not.toContain("1. Contents");
    expect(visibleText).toContain("1. First");
    const titles = outlineTitles(await pdfOutline(visible.pdf!));
    expect(titles).toContain("1. First");
    expect(titles).toContain("1.1. Second");
    expect(titles.some((title) => title.includes("Third"))).toBe(false);
    const labelsBeforeBody = await pdfPageLabels(visible.pdf!);
    expect(labelsBeforeBody).toContain("i");
    expect(labelsBeforeBody).toContain("1");

    const hiddenContents = structuredClone(navigation);
    hiddenContents.navigation.contents.enabled = false;
    const hidden = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(hiddenContents, labels), body),
    );
    expect(hidden.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(await poppler(hidden.pdf!, "pdftotext", ["-layout"])).not.toContain(
      "Contents",
    );
    expect(outlineTitles(await pdfOutline(hidden.pdf!))).toContain("1. First");

    const plainBookmarks = structuredClone(hiddenContents);
    plainBookmarks.navigation.headingNumbers.enabled = false;
    plainBookmarks.navigation.bookmarks.includeHeadingNumbers = false;
    const plain = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(plainBookmarks, labels), body),
    );
    expect(plain.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(outlineTitles(await pdfOutline(plain.pdf!))).toContain("First");
    expect(outlineTitles(await pdfOutline(plain.pdf!))).not.toContain("1. First");
    expect(await poppler(plain.pdf!, "pdftotext", ["-layout"])).toContain("First");

    const noBookmarks = structuredClone(navigation);
    noBookmarks.navigation.bookmarks.enabled = false;
    const visibleOnly = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(noBookmarks, labels), body),
    );
    expect(visibleOnly.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(await poppler(visibleOnly.pdf!, "pdftotext", ["-layout"])).toContain(
      "Contents",
    );
    expect(await pdfOutline(visibleOnly.pdf!)).toEqual([]);
  }, 120_000);

  it("compiles every bounded Typst 0.15.1 marker-alignment value on nested lists", async () => {
    for (const alignment of ["start", "end", "horizon"] as const) {
      const value = design();
      value.navigation.contents.enabled = false;
      value.components.list.markerAlign = alignment;
      value.components.enumeration.markerAlign = alignment;
      const result = await compiler.compile(
        bundle(
          createAtlcliTypstTemplateV5(value),
          "- Outer\n  - Inner\n    - Deep\n\n+ First\n  + Nested",
        ),
      );
      expect(
        result.diagnostics.filter(({ severity }) => severity === "error"),
      ).toEqual([]);
      expect(await poppler(result.pdf!, "pdftotext", ["-layout"])).toContain(
        "Deep",
      );
    }
  }, 120_000);

  it("compiles solid and gradient paints into artifact-only flat shapes", async () => {
    const decorated = design();
    decorated.navigation.contents.enabled = false;
    decorated.paints = {
      solid: { kind: "solid", color: "accent" },
      linear: {
        kind: "linear",
        angle: 43,
        relativeTo: "parent",
        stops: [
          { at: 0, color: "coverTitleInk" },
          { at: 58, color: "coverTitleInk" },
          { at: 58, color: "paper" },
          { at: 100, color: "paper" },
        ],
      },
      radial: {
        kind: "radial",
        center: { x: 50, y: 50 },
        radius: 100,
        relativeTo: "self",
        stops: [
          { at: 0, color: "accent" },
          { at: 100, color: "paper" },
        ],
      },
      conic: {
        kind: "conic",
        angle: 0,
        center: { x: 50, y: 50 },
        relativeTo: "parent",
        stops: [
          { at: 0, color: "accent" },
          { at: 100, color: "coverTitleInk" },
        ],
      },
    };
    decorated.decorations = [
      {
        kind: "rect",
        scope: "first",
        layer: "page-background",
        box: { x: "0mm", y: "0mm", width: "210mm", height: "70mm" },
        fill: "linear",
      },
      {
        kind: "circle",
        scope: "all",
        layer: "page-background",
        center: { x: "180mm", y: "250mm" },
        radius: "12mm",
        fill: "radial",
        stroke: { paint: "conic", width: "1pt" },
      },
      {
        kind: "line",
        scope: "all",
        layer: "footer",
        from: { x: "0mm", y: "0mm" },
        to: { x: "120mm", y: "0mm" },
        stroke: { paint: "solid", width: "0.5pt" },
      },
    ];
    const template = createAtlcliTypstTemplateV5(decorated);
    expect(template).toContain("gradient.linear");
    expect(template).toContain("gradient.radial");
    expect(template).toContain("gradient.conic");
    expect(template.match(/pdf\.artifact\(kind: "other"/gu)).toHaveLength(3);
    const result = await compiler.compile(bundle(template));
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.pdf?.byteLength).toBeGreaterThan(1_000);
    const structure = inspectablePdf(result.pdf!);
    expect(structure).toContain("/Artifact");
    expect(structure).not.toMatch(/\/S\s*\/Figure\b/u);
  }, 120_000);

  it("executes normalized image crop and every bounded clip with shifted negative controls", async () => {
    const value = design();
    value.navigation.contents.enabled = false;
    const path = "template-assets/crop-proof.svg";
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path fill="#E00000" d="M0 0h50v100H0z"/><path fill="#0040E0" d="M50 0h50v100H50z"/></svg>',
    );
    const visuals = (
      clip: { kind: "rect" } | { kind: "rounded-rect"; radius: string } | { kind: "circle" } | undefined,
      cropped: boolean,
    ): PdfTemplateVisualsV1 => ({
      assets: {
        "asset.coverBackground": {
          vfsPath: path,
          reference: {
            descriptor: "descriptor.cropProof",
            writer: "typst.image-decoration",
            decorative: true,
          },
        },
      },
      decorations: [
        {
          kind: "image",
          id: "asset.coverBackground",
          writer: "typst.image-decoration",
          scope: "first",
          layer: "page-background",
          asset: "asset.coverBackground",
          placement: {
            relativeTo: "page",
            fit: "stretch",
            x: "20mm",
            y: "20mm",
            width: "40mm",
            height: "40mm",
            ...(cropped
              ? { crop: { left: 0.5, top: 0, right: 0, bottom: 0 } }
              : {}),
            ...(clip === undefined ? {} : { clip }),
          },
          decorative: true,
        },
      ],
    });
    const mounted = [{ path, bytes, mediaType: "image/svg+xml" as const }];
    for (const clip of [
      { kind: "rect" as const },
      { kind: "rounded-rect" as const, radius: "5mm" },
      { kind: "circle" as const },
    ]) {
      const result = await compiler.compile(
        bundle(createAtlcliTypstTemplateV5(value, {}, visuals(clip, true)), undefined, mounted),
      );
      expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    }

    const cropped = await compiler.compile(
      bundle(
        createAtlcliTypstTemplateV5(value, {}, visuals({ kind: "circle" }, true)),
        undefined,
        mounted,
      ),
    );
    const negative = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(value, {}, visuals(undefined, false)), undefined, mounted),
    );
    expect(cropped.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(negative.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const croppedRaster = await rasterPage(cropped.pdf!);
    const negativeRaster = await rasterPage(negative.pdf!);
    const croppedInterior = pixelAtMm(croppedRaster, 30, 40);
    const negativeInterior = pixelAtMm(negativeRaster, 30, 40);
    expect(croppedInterior[2]).toBeGreaterThan(croppedInterior[0] + 80);
    expect(negativeInterior[0]).toBeGreaterThan(negativeInterior[2] + 80);
    const clippedCorner = pixelAtMm(croppedRaster, 21, 21);
    const negativeCorner = pixelAtMm(negativeRaster, 21, 21);
    expect(Math.min(...clippedCorner)).toBeGreaterThan(220);
    expect(negativeCorner[0]).toBeGreaterThan(negativeCorner[2] + 80);
  }, 120_000);

  it("compiles semantic component policies with repeated table headers and tagged reading order", async () => {
    const tableRows: Extract<ExportBlock, { type: "table" }>["rows"] = [
      {
        cells: [
          {
            header: true,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "REPEATED-HEADER" }],
              },
            ],
          },
        ],
      },
      ...Array.from({ length: 90 }, (_, index) => ({
        cells: [
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph" as const,
                content: [{ type: "text" as const, text: `Row ${index + 1} semantic reading order` }],
              },
            ],
          },
        ],
      })),
    ];
    const componentManifest = manifest((value) => {
      value.navigation.contents.enabled = false;
      value.components = {
        paragraph: { align: "justify", hyphenation: "auto" },
        list: { bulletPreset: "compact", markerAlign: "horizon" },
        enumeration: {
          numberingPreset: "roman-lower",
          markerAlign: "start",
        },
        table: {
          repeatHeader: true,
          banding: "rows",
          borders: "horizontal",
          bandColor: "codeBackground",
          borderColor: "tableStroke",
        },
        outline: { leader: "line", pageNumbers: "hide" },
        callout: { preset: "filled", icon: "hide" },
        codeBlock: { wrap: "soft", lineNumbers: "show" },
      };
    });
    const source = await serializedBundle(
      [
        { type: "heading", level: 1, content: [{ type: "text", text: "Components" }] },
        {
          type: "list",
          ordered: false,
          items: [
            { content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet" }] }] },
          ],
        },
        {
          type: "list",
          ordered: true,
          items: [
            { content: [{ type: "paragraph", content: [{ type: "text", text: "Enumerated" }] }] },
          ],
        },
        {
          type: "callout",
          kind: "info",
          title: "Callout label",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Callout body" }] }],
        },
        { type: "table", rows: tableRows },
        {
          type: "codeBlock",
          language: "text",
          code: "averylongunbreakableidentifierthatneedsemergencywrapping",
          firstLineNumber: 707,
        },
      ],
      componentManifest,
    );
    const fontReasons = source.fontRequirements?.assets.flatMap(
      ({ reasons }) => reasons,
    ) ?? [];
    expect(fontReasons.some(({ detail }) => detail.endsWith(":list-markers"))).toBe(true);
    expect(
      fontReasons.some(({ detail }) => detail.endsWith(":enumeration-markers")),
    ).toBe(true);
    expect(fontReasons.some(({ detail }) => detail.endsWith(":code-line-numbers"))).toBe(true);
    expect(fontReasons.some(({ detail }) => detail.endsWith(":callout-icon"))).toBe(false);
    const result = await compiler.compile(source);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const text = await poppler(result.pdf!, "pdftotext", ["-layout"]);
    expect((text.match(/REPEATED-HEADER/gu) ?? []).length).toBeGreaterThan(1);
    expect(text).toContain("707");
    expect(text).toContain(
      "averylongunbreakableidentifierthatneedsemergencywrapping",
    );
    expect(text).not.toContain("ℹ");
    const structure = await poppler(result.pdf!, "pdfinfo", ["-struct-text"]);
    expect(structure).toContain("Table");
    expect(structure.match(/REPEATED-HEADER/gu)).toHaveLength(1);
    expect(structure.indexOf("REPEATED-HEADER")).toBeLessThan(
      structure.indexOf("Row 1 semantic reading order"),
    );
  }, 120_000);
});
