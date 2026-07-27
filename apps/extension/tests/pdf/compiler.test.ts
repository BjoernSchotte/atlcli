import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  composeChapters,
  storageToBlocks,
  type ExportBlock,
  type ExportNode,
} from "@atlcli/confluence/browser";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import { formatPdfCompilerDiagnostics } from "@atlcli/pdf/browser";
import {
  ATLCLI_TYPST_TEMPLATE,
  preparePdfDocument,
  serializePdfDocument,
  validatePdfOutput,
} from "@atlcli/pdf/internal";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../../../../packages/pdf-compiler-browser/scripts/vendor-typst.js";
import { ChromeWorkerCompilerHost } from "../../utils/pdf/compiler-host.js";

let canonicalCompiler: BrowserPdfCompiler | undefined;

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  canonicalCompiler = await createCompiler();
});

afterAll(async () => {
  await canonicalCompiler?.reset();
});

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await Bun.file(fileURLToPath(resolved)).arrayBuffer());
}

async function createCompiler(): Promise<BrowserPdfCompiler> {
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-Regular.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-It.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-Semibold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-Bold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-Regular.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-It.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-Semibold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-Bold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceCodePro-Regular.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceCodePro-Bold.ttf"),
    packageBytes("@atlcli/pdf/fonts/NotoSansSymbols2-Regular.ttf"),
    packageBytes("@atlcli/pdf/fonts/NotoEmoji-wght.ttf"),
  ]);
  return new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}

function sharedCompiler(): BrowserPdfCompiler {
  if (!canonicalCompiler) {
    throw new Error("Canonical BrowserPdfCompiler is not initialized");
  }
  return canonicalCompiler;
}

function sourceBundle(main: string): PdfSourceBundle {
  return { main, template: ATLCLI_TYPST_TEMPLATE, assets: [], sourceMap: [], notes: [] };
}

function chapterNodes(count: number): ExportNode[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "page" as const,
    pageId: `chapter-${index + 1}`,
    title: `Chapter ${index + 1}`,
    depth: 0,
    effectiveDepth: 0,
    parentId: null,
    position: index,
    blocks: [
      {
        type: "heading" as const,
        level: 2 as const,
        content: [{ type: "text" as const, text: `Topic ${index + 1}` }],
      },
      {
        type: "paragraph" as const,
        content: [
          {
            type: "text" as const,
            text: `This is deterministic source content for chapter ${index + 1}. `.repeat(8),
          },
        ],
      },
    ],
    notes: [],
    meta: { labels: [], spaceKey: "TEST" },
  }));
}

async function chapterBundle(count: number, title: string): Promise<PdfSourceBundle> {
  const composed = composeChapters(chapterNodes(count));
  const prepared = await preparePdfDocument(composed.blocks, {
    resolve: async () => {
      throw new Error("no assets in fixture");
    },
  });
  return serializePdfDocument(prepared, {
    metadata: {
      title,
      language: "en",
      exporter: "atlcli",
      exportedAt: new Date("2026-07-22T00:00:00Z"),
    },
  });
}

function anonymousText(length: number, special: Record<number, string> = {}): string {
  const characters = Array<string>(length).fill("x");
  for (const [offset, value] of Object.entries(special)) characters[Number(offset)] = value;
  return characters.join("");
}

function pdfOperatorColorHex(value: unknown): string | null {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof candidate === "string") {
    const match = candidate.match(/^#([0-9a-f]{6})$/i);
    return match ? `#${match[1]!.toUpperCase()}` : null;
  }
  if (!Array.isArray(candidate) && !ArrayBuffer.isView(candidate)) return null;
  const channels = Array.from(candidate as ArrayLike<number>);
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  const multiplier = channels.every((channel) => channel >= 0 && channel <= 1) ? 255 : 1;
  return `#${channels
    .map((channel) => Math.round(channel * multiplier).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

const DENSE_TABLE_LINK =
  "https://docs.example.com/platform/integration/deployment-guide?environment=staging&source=pdf-test";
const CUSTOM_LABEL_LINK = "https://docs.example.com/platform/overview";

function denseTableFixture(): ExportBlock {
  const cell = (text: string, header = false) => ({
    header,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
  });
  return {
    type: "table",
    columnWidths: Array<number>(14).fill(1),
    rows: [
      {
        cells: [
          "Updated",
          "Component",
          "Stage",
          "Priority",
          "Description",
          "Reference",
          "Owner",
          "Release",
          "Branch",
          "Review",
          "Fallback",
          "Notes",
          "Guide",
          "Result",
        ].map((text) => cell(text, true)),
      },
      {
        cells: [
          cell("2031-12-31 23:59"),
          cell("Integration gateway"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "SYNCHRONIZED", color: "#DE350B" }] }],
          },
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "READY FOR RELEASE", color: "#00875A" }] }],
          },
          cell("Normal prose keeps natural word wrapping in narrow columns without turning every token into an atom."),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "link",
                    target: { kind: "external", href: DENSE_TABLE_LINK },
                    content: [{ type: "text", text: DENSE_TABLE_LINK }],
                  },
                ],
              },
            ],
          },
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "mention", accountId: "synthetic:account-123456789", displayName: "Alexanderson Exampleton" }] }],
          },
          cell("1.13.1"),
          cell("development"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "WAITING FOR REVIEW", color: "#FF991F" }] }],
          },
          cell("AlphabeticOverflowGuard"),
          cell("-"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "link",
                    target: { kind: "external", href: CUSTOM_LABEL_LINK },
                    content: [{ type: "text", text: "Deployment guide" }],
                  },
                ],
              },
            ],
          },
          cell("Synthetic fixture"),
        ],
      },
      {
        cells: [
          cell("21 May 2026 09:30"),
          cell("Event processor"),
          cell("ON"),
          cell("LOW"),
          cell("Ordinary descriptive sentences continue to wrap at meaningful word boundaries in dense mode."),
          cell("Reference"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "mention", accountId: "synthetic:user-1234567890-abcdef" }] }],
          },
          cell("1.13.2"),
          cell("release-candidate"),
          cell("OK"),
          cell("Available"),
          cell("REF-1234567890, TASK-9876543210 alphaomegaworkflow-beta"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{
              type: "paragraph",
              content: [{
                type: "link",
                target: { kind: "external", href: CUSTOM_LABEL_LINK },
                content: [{ type: "text", text: "portal.example.invalid" }],
              }],
            }],
          },
          cell("Verified"),
        ],
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        cells: [
          cell(`D${index + 1}`),
          cell(`S${index + 1}`),
          cell("ON"),
          cell("LOW"),
          cell("Text"),
          cell("Ref"),
          cell("Team"),
          cell(`1.14.${index}`),
          cell("main"),
          cell("OK"),
          cell("Ja"),
          cell("Test"),
          cell("Guide"),
          cell("OK"),
        ],
      })),
    ],
  };
}

function narrowTrackFixture(): ExportBlock {
  const cell = (text: string, header = false) => ({
    header,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
  });
  return {
    type: "table",
    columnWidths: [1, 1, 0.75, 2, 2, 2, 2],
    rows: [
      {
        cells: ["Level", "Type", "Impact", "Description", "Operations", "Timing", "Decision"]
          .map((text) => cell(text, true)),
      },
      {
        cells: [
          cell("3"),
          cell("Scheduled review"),
          cell("Moderate / Severe"),
          cell("Cross-team dependency coordination"),
          cell("Architecture and platform alignment"),
          cell("Verification before rollout"),
          cell("Approval required"),
        ],
      },
    ],
  };
}

function narrowStatusFixture(): ExportBlock {
  const textCell = (text: string, header = false) => ({
    header,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
  });
  return {
    type: "table",
    columnWidths: [1.2, 0.45, 2.1, 3.5, 1.2, 0.7],
    rows: [
      {
        cells: ["Recorded", "State", "Summary", "Notes", "Owner", "Length"]
          .map((text) => textCell(text, true)),
      },
      {
        cells: [
          textCell("2032-02-29"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "PASS", color: "green" }] }],
          },
          textCell("Synthetic review"),
          textCell("Width-aware badge regression"),
          textCell("Team"),
          textCell("4 min"),
        ],
      },
    ],
  };
}

function extractPdfText(pdf: Uint8Array): string | null {
  const pdftotext = Bun.which("pdftotext");
  if (!pdftotext) return null;
  const result = spawnSync(pdftotext, ["-raw", "-", "-"], {
    input: pdf,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pdftotext failed: ${result.stderr.trim()}`);
  return result.stdout;
}

describe("BrowserPdfCompiler", () => {
  it("maps a Typst source range back to its nested content path", () => {
    expect(
      formatPdfCompilerDiagnostics(
        [{ path: "/main.typ", severity: "error", startLine: 27, startColumn: 5, endLine: 27, endColumn: 6, blockPath: "blocks[2].content[0]", message: "bad content" }]
      )
    ).toBe("blocks[2].content[0]: error: bad content");
  });

  it("registers every pinned PDF font with the compiler", async () => {
    const compiler = sharedCompiler();
    const result = await compiler.compile(
      sourceBundle(
        `#set text(font: "Source Serif 4")\n#text(weight: "semibold")[Semibold] #text(weight: "bold")[Bold] #emph[Italic]\n#text(font: "Source Sans 3")[Sans #text(weight: "bold")[Bold] #emph[Italic]]\n#text(font: "Source Code Pro")[Code #text(weight: "bold")[Bold]]`
      )
    );
    expect(result.diagnostics).toEqual([]);
    const fonts = await compiler.getLoadedFonts();
    expect(fonts.length).toBeGreaterThanOrEqual(3);
    expect(fonts.join("\n")).toContain("Source Serif 4");
    expect(fonts.join("\n")).toContain("Source Sans 3");
    expect(fonts.join("\n")).toContain("Source Code Pro");
  }, 30_000);

  it("compiles a real PDF with the bundled template and fonts", async () => {
    const compiler = sharedCompiler();
    const result = await compiler.compile(
      sourceBundle(String.raw`#import "atlcli.typ": atlcli-doc, callout, status-badge
#show: atlcli-doc.with(meta: (
  title: "Compiler smoke",
  space: "DOCSY",
  version: "v1",
  author: "atlcli",
  exporter: "atlcli",
  exported-at: datetime(year: 2026, month: 7, day: 16),
  exported-label: "2026-07-16",
))
= Hello
This is a real PDF.
`)
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(new TextDecoder().decode(result.pdf?.slice(0, 8))).toStartWith("%PDF-");
    expect(result.pdf?.byteLength).toBeGreaterThan(1_000);
    expect(new TextDecoder().decode(result.pdf)).toContain("https://atlcli.sh/");
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true, hasOutline: true });
  }, 30_000);

  it("emits table-of-contents links that resolve to the rendered heading pages", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 1, content: [{ type: "text", text: "Chapter One" }] },
      { type: "paragraph", content: [{ type: "text", text: "First chapter body." }] },
      { type: "pageBreak" },
      { type: "heading", level: 1, content: [{ type: "text", text: "Chapter Two" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second chapter body." }] },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("no assets in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Clickable contents",
        language: "en",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-21T00:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);
    expect(result.diagnostics).toEqual([]);

    // Parse the actual compiled bytes. A source assertion on `outline(...)`
    // cannot prove that the PDF contains link annotations or that their named
    // destinations resolve to real pages.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(result.pdf!),
    });
    const document = await task.promise;
    try {
      const internal: Array<{ sourcePage: number; destination: string }> = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        for (const annotation of await page.getAnnotations({ intent: "display" })) {
          if (annotation.subtype === "Link" && typeof annotation.dest === "string") {
            internal.push({ sourcePage: pageNumber, destination: annotation.dest });
          }
        }
      }

      expect(internal.map((link) => link.destination)).toEqual(
        expect.arrayContaining(["chapter-one", "chapter-two"])
      );
      const targets = await Promise.all(
        internal
          .filter((link) => link.destination.startsWith("chapter-"))
          .map(async (link) => {
            const destination = await document.getDestination(link.destination);
            expect(destination).not.toBeNull();
            const ref = destination![0];
            const pageIndex = Number.isInteger(ref) ? (ref as number) : await document.getPageIndex(ref);
            return { sourcePage: link.sourcePage, targetPage: pageIndex + 1 };
          })
      );
      expect(targets).toHaveLength(2);
      expect(new Set(targets.map((target) => target.targetPage)).size).toBe(2);
      expect(targets.every((target) => target.targetPage > target.sourcePage)).toBe(true);
    } finally {
      await task.destroy();
    }
  }, 60_000);

  it("compiles Confluence ri:url links in table prose into external PDF annotations", async () => {
    const visibleUrl =
      "https://obi.atlassian.net/wiki/x/ImKFFg/a/long/path/that/wraps/in/a/narrow/table/cell";
    const labelledUrl = "https://obi.atlassian.net/wiki/x/CACFFg";
    const storage =
      '<table><tbody><tr><td><p>Integration Platform Team: ' +
      `<ac:link><ri:url ri:value="${visibleUrl}"/>` +
      `<ac:plain-text-link-body><![CDATA[${visibleUrl}]]></ac:plain-text-link-body></ac:link></p>` +
      '<p>Documentation: <ac:link>' +
      `<ri:url ri:value="${labelledUrl}"/>` +
      '<ac:link-body>Platform <strong>documentation</strong></ac:link-body></ac:link></p>' +
      "</td></tr></tbody></table>";
    const walked = storageToBlocks(storage, { exporter: "pdf" });
    expect(walked.notes).toEqual([]);

    const prepared = await preparePdfDocument(walked.blocks, {
      resolve: async () => {
        throw new Error("no assets in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Inline link regression",
        language: "en",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-22T00:00:00Z"),
      },
    });
    expect(bundle.main).toMatch(
      /#text\(fill: rgb\("#[0-9A-F]{6}"\)\)\[#underline\[#dense-link\(/
    );
    expect(bundle.main).toContain(`[#underline[#link("${labelledUrl}")`);
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);
    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();

    // Verify actual compiled bytes rather than only checking for Typst
    // `#link(...)` source: PDF.js must expose both URI annotations.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(result.pdf!) });
    const document = await task.promise;
    try {
      const external: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        for (const annotation of await page.getAnnotations({ intent: "display" })) {
          if (annotation.subtype === "Link" && typeof annotation.url === "string") {
            external.push(annotation.url);
          }
        }
      }
      expect(external).toEqual(expect.arrayContaining([visibleUrl, labelledUrl]));
    } finally {
      await task.destroy();
    }
  }, 60_000);

  it("compiles Confluence inline background colors into painted PDF highlights", async () => {
    const storage =
      '<p><span style="background-color: #12AB34;">Green highlight</span> ' +
      '<span style="color: #403294; background-color: #FEDCBA"><strong>Warm highlight</strong></span></p>';
    const walked = storageToBlocks(storage, { exporter: "pdf" });
    expect(walked.notes).toEqual([]);

    const prepared = await preparePdfDocument(walked.blocks, {
      resolve: async () => {
        throw new Error("no assets in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Inline background regression",
        language: "en",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-22T00:00:00Z"),
      },
    });
    expect(bundle.main).toContain('#highlight(fill: rgb("#12AB34"))');
    expect(bundle.main).toContain('#highlight(fill: rgb("#FEDCBA"))');

    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);
    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();

    // Inspect the actual page-paint operators. This catches a serializer that
    // merely emits accepted Typst syntax but loses the requested fills before
    // they reach the compiled PDF bytes.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(result.pdf!) });
    const document = await task.promise;
    try {
      const colors = new Set<string>();
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const operators = await page.getOperatorList();
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          if (operators.fnArray[index] !== pdfjs.OPS.setFillRGBColor) continue;
          const color = pdfOperatorColorHex(operators.argsArray[index]);
          if (color) colors.add(color);
        }
      }
      expect(colors).toContain("#12AB34");
      expect(colors).toContain("#FEDCBA");
    } finally {
      await task.destroy();
    }
  }, 60_000);

  it("keeps highlighted heading colors out of the PDF table of contents", async () => {
    const highlight = "#12AB34";
    const title = "Highlighted navigation title";
    const blocks: ExportBlock[] = [
      {
        type: "heading",
        level: 1,
        content: [{ type: "text", text: title, color: "#403294", backgroundColor: highlight }],
      },
      { type: "paragraph", content: [{ type: "text", text: "Body text." }] },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("no assets in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Clean contents regression",
        language: "en",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-22T00:00:00Z"),
      },
    });
    expect(bundle.main).toContain(
      '#atlcli-outline-title.update("Highlighted navigation title")#heading(level: 1, outlined: true)[#highlight(fill: rgb("#12AB34"))'
    );

    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);
    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(result.pdf!) });
    const document = await task.promise;
    try {
      const occurrences: Array<{ pageNumber: number; colors: Set<string> }> = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        if (!text.includes(title)) continue;

        const colors = new Set<string>();
        const operators = await page.getOperatorList();
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          if (operators.fnArray[index] !== pdfjs.OPS.setFillRGBColor) continue;
          const color = pdfOperatorColorHex(operators.argsArray[index]);
          if (color) colors.add(color);
        }
        occurrences.push({ pageNumber, colors });
      }

      expect(occurrences).toHaveLength(2);
      const [contentsPage, documentPage] = occurrences;
      expect(contentsPage!.pageNumber).toBeLessThan(documentPage!.pageNumber);
      expect(contentsPage!.colors).not.toContain(highlight);
      expect(contentsPage!.colors).not.toContain("#403294");
      expect(documentPage!.colors).toContain(highlight);
      expect(documentPage!.colors).toContain("#403294");
    } finally {
      await task.destroy();
    }
  }, 60_000);

  it("returns structured diagnostics for invalid Typst", async () => {
    const compiler = await createCompiler();
    try {
      const result = await compiler.compile(sourceBundle("#this-function-does-not-exist()"));
      expect(result.pdf).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0]?.path).toContain("main.typ");
    } finally {
      await compiler.reset();
    }
  }, 30_000);

  it("compiles the generated semantic block source", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "Overview" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "A bold statement", marks: ["bold"] },
          { type: "lineBreak" },
          { type: "status", text: "DONE", color: "#00875A" },
        ],
      },
      {
        type: "callout",
        kind: "info",
        title: "Context",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Read me" }] }],
      },
      {
        type: "list",
        ordered: false,
        items: [
          { checked: true, content: [{ type: "paragraph", content: [{ type: "text", text: "Task" }] }] },
        ],
      },
      {
        type: "list",
        ordered: false,
        items: [
          {
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Editorial marker" }] },
              {
                type: "list",
                ordered: false,
                items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "Nested marker" }] }] }],
              },
            ],
          },
        ],
      },
      {
        type: "list",
        ordered: true,
        items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "Numbered item" }] }] }],
      },
      {
        type: "table",
        rows: [
          { cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Key" }] }] }] },
          { cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] }] },
        ],
      },
      { type: "codeBlock", language: "javascript", code: "const answer = 42;" },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("no image in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Generated PDF",
        space: "DOCSY",
        version: 1,
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(new TextDecoder().decode(result.pdf?.slice(0, 8))).toStartWith("%PDF-");
  }, 30_000);

  it("compiles narrow German table cells with explicit hyphenation", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        columnWidths: [1, 1, 1, 1],
        rows: [
          {
            cells: [
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Aktivität" }] }] },
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Team" }] }] },
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }] },
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "State" }] }] },
            ],
          },
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Capability-/Reifegradbewertung (1)" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Table wrapping regression",
        language: "de",
        region: "DE",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);
    const repeat = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(repeat.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(repeat.pdf).toEqual(result.pdf);
  }, 30_000);

  it("compiles a dense table without losing prose, status labels, or the full link target", async () => {
    const prepared = await preparePdfDocument([denseTableFixture()], {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Dense table regression",
        language: "en",
        region: "US",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    const inspection = validatePdfOutput(result.pdf!);
    expect(inspection.tagged).toBe(true);
    expect(inspection.pageCount).toBeGreaterThan(4);
    expect(inspection.embeddedFontFiles).toBeGreaterThanOrEqual(3);

    const pdfSource = new TextDecoder("latin1").decode(result.pdf);
    expect(pdfSource).toContain(`/URI (${DENSE_TABLE_LINK})`);
    expect(pdfSource).toContain(`/URI (${CUSTOM_LABEL_LINK})`);
    expect(pdfSource).toMatch(/SourceCodePro-Bold/);

    expect(bundle.main).toContain('[#text("Normal")], [#text("Norm\u200Bal")]');
    expect(bundle.main).toContain('"SYNCHRONIZED", "SY\u200BNC\u200BHR\u200BON\u200BIZ\u200BED"');
    expect(bundle.main).toContain('[#text("Alexanderson")], [#text("Alex\u200Bande\u200Brson")]');
    expect(bundle.main).toContain('[#text("Exampleton")], [#text("Exam\u200Bplet\u200Bon")]');
    const extracted = extractPdfText(result.pdf!);
    if (extracted !== null) {
      const extractedCompact = extracted
        .replaceAll("\u00ad", "")
        .replaceAll("\u200b", "")
        .replace(/\s+/g, "");
      expect(extractedCompact).toContain("prosekeeps");
      expect(extractedCompact).toContain("naturalwordwrapping");
      expect(extractedCompact).toContain("SYNCHRONIZED");
      expect(extractedCompact).toContain("2031-12-3123:59");
      expect(extractedCompact).toContain("portal.example.invalid");
      expect(extractedCompact).toContain("REF-1234567890,TASK-9876543210");
      expect(extractedCompact).toContain("alphaomegaworkflow-beta");
      expect(extractedCompact).toContain("AlphabeticOverflowGuard");
      expect(extractedCompact).toContain("@Unknownuser");
      expect(extractedCompact).not.toContain("synthetic:user-1234567890-abcdef");
      expect(extractedCompact).toContain("READYFORRELEASE");
      expect(extractedCompact).toContain("WAITINGFORREVIEW");
      expect(extractedCompact).toContain("AlexandersonExampleton");
      expect(extractedCompact).toContain("docs.example.com");
      expect(extractedCompact).toContain("Deploymentguide");
      expect(extractedCompact.match(/Updated/g)?.length ?? 0).toBeGreaterThan(1);
    }

    const repeat = await compiler.compile(bundle);
    expect(repeat.diagnostics).toEqual([]);
    expect(repeat.pdf).toEqual(result.pdf);
  }, 30_000);

  it("compiles a seven-column table with one narrow track without losing its phrase", async () => {
    const prepared = await preparePdfDocument([narrowTrackFixture()], {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Narrow track regression",
        language: "en",
        region: "US",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(bundle.main).toContain("columns: (0.093023fr, 0.093023fr, 0.069767fr");
    expect(bundle.main).toContain('[#text("Moderate")], [#text("Mode\u200Brate")]');
    const extracted = extractPdfText(result.pdf!);
    if (extracted !== null) {
      const compact = extracted
        .replaceAll("\u00ad", "")
        .replaceAll("\u200b", "")
        .replace(/\s+/g, "");
      expect(compact).toContain("Moderate/Severe");
      expect(compact).toContain("Cross-teamdependencycoordination");
    }
  }, 30_000);

  it("compiles a semantic-color badge inside an extremely narrow status track", async () => {
    const prepared = await preparePdfDocument([narrowStatusFixture()], {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Narrow status regression",
        language: "en",
        region: "US",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(bundle.main).toContain('#dense-status-badge(available-width, "PASS", "PA\u200BSS", color: "#00875A")');
    const extracted = extractPdfText(result.pdf!);
    if (extracted !== null) {
      expect(extracted.replaceAll("\u200b", "").replace(/\s+/g, "")).toContain("PASS");
    }
  }, 30_000);

  it("accounts for active rowspans when a following colspan determines the table width", async () => {
    const paragraph = (text: string) => [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }];
    const blocks: ExportBlock[] = [{
      type: "table",
      rows: [
        {
          cells: [
            { header: false, colspan: 1, rowspan: 2, content: paragraph("Vertical") },
            { header: false, colspan: 2, rowspan: 1, content: paragraph("Upper span") },
          ],
        },
        {
          cells: [
            { header: false, colspan: 3, rowspan: 1, content: paragraph("Lower span") },
          ],
        },
      ],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Spanned grid regression",
        language: "en",
        region: "US",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);

    expect(bundle.main).toContain("columns: (1fr, 1fr, 1fr, 1fr,)");
    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
  }, 30_000);

  it("keeps a full-width section row in the table body instead of promoting it to a repeated header", async () => {
    const paragraph = (text: string) => [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }];
    const cell = (text: string, header = false, colspan = 1) => ({
      header,
      colspan,
      rowspan: 1,
      content: paragraph(text),
    });
    const blocks: ExportBlock[] = [{
      type: "table",
      columnWidths: [1, 2, 2, 1],
      rows: [
        { cells: [cell("Key", true), cell("Scope", true), cell("Cadence", true), cell("Owner", true)] },
        { cells: [cell("A"), cell("Shared"), cell("Monthly"), cell("Team")] },
        {
          cells: [{
            ...cell("Synthetic section", true, 4),
            backgroundColor: "#8994A9",
            content: [{
              type: "paragraph",
              content: [{
                type: "text",
                text: "Synthetic section",
                marks: ["bold"],
                color: "#172B4D",
              }],
            }],
          }],
        },
        { cells: [cell("B"), cell("Local"), cell("Weekly"), cell("Team")] },
      ],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Section row regression",
        language: "en",
        region: "US",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);

    expect(bundle.main.match(/table\.header\(/g)).toHaveLength(1);
    expect(bundle.main).toContain('fill: rgb("#8994A9")');
    expect(bundle.main).toContain('#set text(fill: rgb("#FCFBF8"))');
    expect(bundle.main).toContain('#text(fill: rgb("#FCFBF8"))[#strong[');
    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
  }, 30_000);

  it("compiles literal office-style text safely inside lists and tables", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "list",
        ordered: false,
        items: [
          {
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", marks: ["bold"], text: anonymousText(38, { 16: "&", 24: "-", 37: ":" }) },
                  { type: "text", text: anonymousText(23, { 0: "\u00a0", 22: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(27, { 9: "-", 14: "-" }) },
                  { type: "text", text: anonymousText(52, { 0: "\u00a0", 1: "—", 51: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(15, { 5: "-" }) },
                  { type: "text", text: anonymousText(71, { 0: ".", 64: ":", 70: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(20) },
                  { type: "text", text: anonymousText(43, { 0: "(", 8: "/", 37: ")", 42: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(23, { 8: "-" }) },
                  { type: "text", text: anonymousText(113, { 0: ".", 48: "—", 65: ",", 112: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(17, { 5: "-" }) },
                  {
                    type: "text",
                    text: anonymousText(162, {
                      0: "\u00a0",
                      27: ".",
                      121: "-",
                      130: "-",
                      131: "/",
                      136: "-",
                      144: "-",
                      152: "-",
                      161: ".",
                    }),
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "table",
        rows: [
          {
            cells: [
              {
                header: false,
                colspan: 1,
                rowspan: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: anonymousText(32, { 10: "-", 11: "/", 19: "-", 30: "+", 31: "\u00a0" }),
                      },
                      { type: "text", marks: ["bold"], text: anonymousText(13, { 3: "-" }) },
                      { type: "text", text: anonymousText(25, { 0: "(", 3: "/", 6: ",", 24: ")" }) },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("no assets in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Literal text regression",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
  }, 30_000);

  it("initializes and compiles when dynamic Function construction is blocked", async () => {
    const original = globalThis.Function;
    const blocked = new Proxy(original, {
      construct() {
        throw new Error("dynamic Function construction is forbidden by MV3 CSP");
      },
      apply() {
        throw new Error("dynamic Function construction is forbidden by MV3 CSP");
      },
    });
    Object.defineProperty(globalThis, "Function", { configurable: true, value: blocked });
    let compiler: BrowserPdfCompiler | undefined;
    try {
      compiler = await createCompiler();
      const result = await compiler.compile(sourceBundle("= CSP-safe\n\nNo unsafe eval."));
      expect(result.diagnostics).toEqual([]);
      expect(new TextDecoder().decode(result.pdf?.slice(0, 8))).toStartWith("%PDF-");
    } finally {
      Object.defineProperty(globalThis, "Function", { configurable: true, value: original });
      await compiler?.reset();
    }
  }, 30_000);

  it("produces byte-identical output on a warm repeat compile", async () => {
    const compiler = sharedCompiler();
    const bundle = sourceBundle("= Deterministic\n\nSame source, same PDF.");
    const first = await compiler.compile(bundle);
    const second = await compiler.compile(bundle);
    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(second.pdf).toEqual(first.pdf);
  }, 30_000);

  it("compiles a preview and the full export with one real warm compiler instance", async () => {
    const compiler = sharedCompiler();
    const previewBundle = await chapterBundle(1, "Warm preview");
    const exportBundle = await chapterBundle(6, "Warm full export");

    const preview = await compiler.compile(previewBundle);
    const exported = await compiler.compile(exportBundle);

    expect(preview.diagnostics).toEqual([]);
    expect(exported.diagnostics).toEqual([]);
    expect(preview.pdf).toBeDefined();
    expect(exported.pdf).toBeDefined();

    const previewInspection = validatePdfOutput(preview.pdf!);
    const exportInspection = validatePdfOutput(exported.pdf!);
    expect(previewInspection.tagged).toBe(true);
    expect(exportInspection.tagged).toBe(true);
    expect(exportInspection.pageCount).toBeGreaterThan(previewInspection.pageCount);
  }, 60_000);

  it("compiles a real multi-chapter bundle within the production scaled timeout", async () => {
    const chapterCount = 12;
    const compiler = sharedCompiler();
    const bundle = await chapterBundle(chapterCount, "Scaled multi-chapter export");
    const timeoutContract = new ChromeWorkerCompilerHost({
      createWorker: () => {
        throw new Error("timeout calculation must not create a worker");
      },
    });
    const budgetMs = timeoutContract.timeoutForPages(chapterCount);

    const startedAt = performance.now();
    const result = await compiler.compile(bundle);
    const elapsedMs = performance.now() - startedAt;

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(elapsedMs).toBeLessThan(budgetMs);
    const inspection = validatePdfOutput(result.pdf!);
    expect(inspection).toMatchObject({
      tagged: true,
      hasOutline: true,
    });
    expect(inspection.pageCount).toBeGreaterThanOrEqual(chapterCount);
  }, 90_000);
});
