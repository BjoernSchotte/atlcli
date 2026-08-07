/** Real Typst-WASM proof for canonical revision 5 page and running regions. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportBlock } from "@atlcli/confluence";
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

function bundle(template: string, body = "= Body\n\nRevision 5 proof."): PdfSourceBundle {
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
    assets: [],
    sourceMap: [],
    notes: [],
  };
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
