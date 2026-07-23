#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runExport } from "@atlcli/docx";
import { nodeDocxEnv } from "../packages/export-node/src/docx-env.js";
import { nodePdfEnv } from "../packages/export-node/src/pdf-env.js";
import {
  ADF_CONFORMANCE_DETAILS,
  ADF_CONFORMANCE_METADATA,
  ADF_CONFORMANCE_SOURCE,
  ADF_INLINE_MEDIA_BYTES,
  ADF_INLINE_MEDIA_FILENAME,
  STORAGE_CODE_COMPATIBILITY_SOURCE,
  adfConformanceBlocks,
  storageCodeCompatibilityBlocks,
} from "@atlcli/export-fixtures";
import { runPdfExport } from "@atlcli/pdf";
import sharp from "sharp";
import { ensurePdfFonts } from "../packages/pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../packages/pdf-compiler-browser/scripts/vendor-typst.js";

const repositoryRoot = resolve(import.meta.dir, "..");
export const ADF_RENDERED_GOLDEN_DIR = resolve(
  repositoryRoot,
  "packages/export-fixtures/test-fixtures/adf-rendered-golden",
);
export const ADF_RENDERED_GOLDEN_MANIFEST = resolve(ADF_RENDERED_GOLDEN_DIR, "manifest.json");

const REQUIRED_TEXT = Object.freeze([
  "INLINE_TOKEN",
  "⚠",
  ":custom_party:",
  "Local card title",
  "Centered paragraph",
  "Indented paragraph",
  "ADF panel body",
  "ADF success panel",
  "ADF error panel",
  "★",
  "ADF custom panel",
  "@Example Person",
  "Third item",
  "Eighth nested item",
  "Bullet parent",
  "Bullet child",
  "Open task",
  "Completed block task",
  "Nested task",
  "Ship the release",
  "Header",
  "Cell",
  "Layout sidebar",
  "Layout main",
  "Expanded title",
  "Expanded body",
  "Extension body",
  "Extension: multi-frame-extension",
  "Frame 1",
  "Multi frame first body",
  "Frame 2",
  "Multi frame second body",
  "Visible media fallback",
  "Media caption",
  "Synced content snapshot",
  "Synced snapshot body",
  "Synced content is unavailable in this static export.",
  "Unsupported ADF block: unsupportedBlock",
  "Unsupported wrapper keeps ",
  "rich inline content",
  "Extension: static-extension",
  "Legacy Storage code title",
  "const legacyStorage = true;",
]);
const FORBIDDEN_TEXT = Object.freeze([
  "editor-only-secret",
  "1709510400000",
  "annotation-inline-code",
  "comment-resource-1",
  "comment-reply-1",
  "unsupported-block-private-provenance",
  "unsupported-inline-private-provenance",
  "static-extension-private-local-id",
  "static-extension-private-parameter",
  "multi-frame-local",
  "multi-frame-fragment",
  "multi-frame-consumer",
]);

const MAX_MEAN_PIXEL_DIFFERENCE = 0.08;
const MIN_CONTENT_BOUNDS_IOU = 0.8;

interface GoldenPage {
  file: string;
  sha256: string;
}

interface GoldenFormat {
  pages: GoldenPage[];
  requiredText: string[];
  forbiddenText: string[];
}

export interface AdfRenderedGoldenManifest {
  schemaVersion: 1;
  sourceSha256: string;
  features: string[];
  formats: {
    docx: GoldenFormat;
    pdf: GoldenFormat;
  };
}

export interface AdfRenderedGoldenResult {
  updated: boolean;
  docxPages: number;
  pdfPages: number;
  docxCodeFontEmbedded: boolean;
  maxMeanPixelDifference: number;
  minContentBoundsIou: number;
}

interface Bounds {
  populated: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function which(command: string): string | undefined {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function adfRenderedGoldenTools(): {
  soffice?: string;
  pdftoppm?: string;
  pdftotext?: string;
  pdffonts?: string;
} {
  return {
    soffice: which("soffice") ?? which("libreoffice"),
    pdftoppm: which("pdftoppm"),
    pdftotext: which("pdftotext"),
    pdffonts: which("pdffonts"),
  };
}

function runTool(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed with status ${String(result.status)}.`);
  }
  return result.stdout;
}

function sourceHash(): string {
  const word = adfConformanceBlocks("word");
  const pdf = adfConformanceBlocks("pdf");
  const storage = storageCodeCompatibilityBlocks();
  return sha256(JSON.stringify({
    source: ADF_CONFORMANCE_SOURCE,
    storageSource: STORAGE_CODE_COMPATIBILITY_SOURCE,
    word,
    pdf,
    storage,
  }));
}

async function renderCurrent(tempDir: string): Promise<{
  docxPages: string[];
  pdfPages: string[];
  docxText: string;
  pdfText: string;
}> {
  const tools = adfRenderedGoldenTools();
  if (!tools.soffice || !tools.pdftoppm || !tools.pdftotext || !tools.pdffonts) {
    throw new Error(
      "ADF rendered-golden verification requires soffice, pdftoppm, pdftotext, and pdffonts.",
    );
  }
  await Promise.all([
    ensurePdfFonts({ logger: () => {} }),
    ensureVendoredTypst(),
  ]);
  const word = adfConformanceBlocks("word");
  const pdf = adfConformanceBlocks("pdf");
  const storage = storageCodeCompatibilityBlocks();
  const docxPath = join(tempDir, "adf-rendered-docx.docx");
  const pdfName = "adf-rendered-pdf.pdf";
  const pdfPath = join(tempDir, pdfName);
  const profile: Parameters<typeof nodePdfEnv>[0] = {
    name: "adf-rendered-golden",
    baseUrl: "https://example.invalid",
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "fixture@example.invalid", token: "unused" },
  };
  await runExport(
    {
      details: ADF_CONFORMANCE_DETAILS,
      blocks: [...word.blocks, ...storage.blocks],
      sourceNotes: [...word.notes, ...storage.notes],
      template: { name: "adf-rendered.docx", modificationDate: new Date("2026-07-22T08:00:00.000Z") },
      exportDate: new Date("2026-07-22T08:00:00.000Z"),
    },
    nodeDocxEnv({
      outPath: docxPath,
      extras: {
        assets: {
          async fetch(ref) {
            if (ref.filename !== ADF_INLINE_MEDIA_FILENAME) {
              throw new Error("Rendered golden received an unknown asset.");
            }
            return ADF_INLINE_MEDIA_BYTES.slice();
          },
        },
      },
    }),
  );
  await runPdfExport(
    {
      blocks: [...pdf.blocks, ...storage.blocks],
      metadata: ADF_CONFORMANCE_METADATA,
      profile: "tagged",
      filename: pdfName,
      sourceNotes: [...pdf.notes, ...storage.notes],
    },
    nodePdfEnv(profile, {
      outDir: tempDir,
      assets: {
        async resolve(ref) {
          if (ref.kind !== "attachment" || ref.filename !== ADF_INLINE_MEDIA_FILENAME) {
            throw new Error("Rendered golden received an unknown asset.");
          }
          return {
            bytes: ADF_INLINE_MEDIA_BYTES.slice(),
            mediaType: "image/png",
            filename: ADF_INLINE_MEDIA_FILENAME,
          };
        },
      },
    }),
  );

  const libreOfficeProfile = join(tempDir, "libreoffice-profile");
  await mkdir(libreOfficeProfile);
  runTool(tools.soffice, [
    `-env:UserInstallation=${pathToFileURL(libreOfficeProfile).href}`,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    tempDir,
    docxPath,
  ], tempDir);
  const docxPdfPath = join(tempDir, "adf-rendered-docx.pdf");
  const docxFonts = runTool(tools.pdffonts, [docxPdfPath], tempDir);
  const embeddedCodeFont = docxFonts
    .split(/\r?\n/gu)
    .some((line) => /JetBrainsMono/iu.test(line) && /\byes\b/iu.test(line));
  if (!embeddedCodeFont) {
    throw new Error(
      "DOCX rendered golden did not carry its embedded JetBrains Mono face into the converted PDF.",
    );
  }
  runTool(tools.pdftoppm, ["-png", "-r", "96", docxPdfPath, join(tempDir, "current-docx")], tempDir);
  runTool(tools.pdftoppm, ["-png", "-r", "96", pdfPath, join(tempDir, "current-pdf")], tempDir);
  const files = (await readdir(tempDir)).sort();
  const docxPages = files.filter((file) => /^current-docx-\d+\.png$/.test(file)).map((file) => join(tempDir, file));
  const pdfPages = files.filter((file) => /^current-pdf-\d+\.png$/.test(file)).map((file) => join(tempDir, file));
  if (docxPages.length === 0 || pdfPages.length === 0) {
    throw new Error("ADF rendered-golden rasterization produced no pages.");
  }
  return {
    docxPages,
    pdfPages,
    docxText: runTool(tools.pdftotext, ["-layout", docxPdfPath, "-"], tempDir),
    pdfText: runTool(tools.pdftotext, ["-layout", pdfPath, "-"], tempDir),
  };
}

async function normalizedPixels(path: string): Promise<{ rgba: Uint8Array; bounds: Bounds }> {
  const { data, info } = await sharp(path)
    .flatten({ background: "#ffffff" })
    .resize(96, 128, { fit: "contain", background: "#ffffff" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8Array(data);
  const bounds: Bounds = {
    populated: false,
    minX: info.width,
    minY: info.height,
    maxX: -1,
    maxY: -1,
  };
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const luminance = 0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!;
      if (luminance >= 245) continue;
      bounds.populated = true;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  return { rgba, bounds };
}

function boundsIou(left: Bounds, right: Bounds): number {
  if (!left.populated || !right.populated) return 0;
  const width = Math.max(0, Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX) + 1);
  const height = Math.max(0, Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY) + 1);
  const intersection = width * height;
  const leftArea = (left.maxX - left.minX + 1) * (left.maxY - left.minY + 1);
  const rightArea = (right.maxX - right.minX + 1) * (right.maxY - right.minY + 1);
  return intersection / (leftArea + rightArea - intersection);
}

async function comparePage(current: string, reference: string): Promise<{ difference: number; iou: number }> {
  const [left, right] = await Promise.all([normalizedPixels(current), normalizedPixels(reference)]);
  if (!left.bounds.populated || !right.bounds.populated) throw new Error("Rendered golden contains a blank page.");
  let difference = 0;
  for (let index = 0; index < left.rgba.length; index += 1) {
    difference += Math.abs(left.rgba[index]! - right.rgba[index]!);
  }
  difference /= left.rgba.length * 255;
  return { difference, iou: boundsIou(left.bounds, right.bounds) };
}

async function manifestFor(
  docxPages: string[],
  pdfPages: string[],
): Promise<AdfRenderedGoldenManifest> {
  const copyPages = async (format: "docx" | "pdf", pages: string[]): Promise<GoldenPage[]> => {
    const result: GoldenPage[] = [];
    for (let index = 0; index < pages.length; index += 1) {
      const file = `${format}-page-${index + 1}.png`;
      const target = resolve(ADF_RENDERED_GOLDEN_DIR, file);
      await copyFile(pages[index]!, target);
      result.push({ file, sha256: sha256(new Uint8Array(await readFile(target))) });
    }
    return result;
  };
  return {
    schemaVersion: 1,
    sourceSha256: sourceHash(),
    features: [
      "inline-code",
      "annotation-native-docx-static-pdf",
      "docx-embedded-code-font",
      "unicode-emoji",
      "custom-emoji-fallback",
      "localized-date-chip",
      "semantic-status-colors-and-casing",
      "hidden-template-placeholder",
      "mention-semantics-and-private-fallback",
      "block-alignment",
      "block-indentation",
      "paragraph-font-size",
      "semantic-success-error-panels",
      "custom-panel-color-icon",
      "ordered-list-start",
      "nested-ordered-list-restart",
      "nested-bullet-list",
      "nested-task-list",
      "decision-list",
      "table",
      "table-numbered-column",
      "table-width-alignment",
      "table-cell-vertical-alignment",
      "layout-column-proportions",
      "layout-column-vertical-alignment",
      "layout-breakout-page-bound",
      "root-code-expand-breakout-page-bound",
      "smart-link",
      "media-fallback",
      "media-single-layout-width-caption-border",
      "media-group",
      "media-inline-image-and-fallback-chip",
      "media-data-consumer-provenance-nonvisual",
      "fragment-provenance-nonvisual",
      "unsupported-adf-typed-fallback",
      "media-wrap-source-order",
      "synced-content-snapshot-and-reference",
      "extension-static-fallback",
      "stage0-multi-bodied-extension-frames",
      "storage-code-title-and-static-collapse",
    ],
    formats: {
      docx: {
        pages: await copyPages("docx", docxPages),
        requiredText: [...REQUIRED_TEXT, "Mar 4, 2024", "READY", "Keep Case"],
        forbiddenText: [...FORBIDDEN_TEXT],
      },
      pdf: {
        pages: await copyPages("pdf", pdfPages),
        requiredText: [
          ...REQUIRED_TEXT,
          "4 Mar 2024",
          "READY",
          "Keep Case",
          "Review the inline token",
          "Reviewed",
        ],
        forbiddenText: [...FORBIDDEN_TEXT],
      },
    },
  };
}

function assertRequiredText(format: string, actual: string, required: string[]): void {
  const normalized = actual.replace(/\s+/gu, " ");
  for (const text of required) {
    if (!normalized.includes(text.replace(/\s+/gu, " "))) {
      throw new Error(`${format} rendered golden is missing required text: ${JSON.stringify(text)}.`);
    }
  }
}

function assertForbiddenText(format: string, actual: string, forbidden: string[]): void {
  const normalized = actual.replace(/\s+/gu, " ");
  for (const text of forbidden) {
    if (normalized.includes(text.replace(/\s+/gu, " "))) {
      throw new Error(`${format} rendered golden contains forbidden text: ${JSON.stringify(text)}.`);
    }
  }
}

function assertOrderedListMarkers(format: string, actual: string): void {
  for (const [ordinal, text] of [
    [3, "Third item"],
    [8, "Eighth nested item"],
  ] as const) {
    const markerAndText = new RegExp(`(?:^|\\n)\\s*${ordinal}\\.\\s+${text}(?:\\s|$)`);
    if (!markerAndText.test(actual)) {
      throw new Error(`${format} rendered golden is missing ordered-list marker ${ordinal}.`);
    }
  }
}

function assertStorageCodeTitleOrder(format: string, actual: string): void {
  const title = actual.indexOf("Legacy Storage code title");
  const body = actual.indexOf("const legacyStorage = true;");
  if (title < 0 || body < 0 || title >= body) {
    throw new Error(`${format} rendered golden did not keep the legacy code title above its body.`);
  }
}

export async function checkAdfRenderedGoldens(options: { update?: boolean } = {}): Promise<AdfRenderedGoldenResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "atlcli-adf-rendered-golden-"));
  try {
    const rendered = await renderCurrent(tempDir);
    assertOrderedListMarkers("DOCX", rendered.docxText);
    assertOrderedListMarkers("PDF", rendered.pdfText);
    assertStorageCodeTitleOrder("DOCX", rendered.docxText);
    assertStorageCodeTitleOrder("PDF", rendered.pdfText);
    await mkdir(ADF_RENDERED_GOLDEN_DIR, { recursive: true });
    if (options.update) {
      const manifest = await manifestFor(rendered.docxPages, rendered.pdfPages);
      await writeFile(ADF_RENDERED_GOLDEN_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return {
        updated: true,
        docxPages: rendered.docxPages.length,
        pdfPages: rendered.pdfPages.length,
        docxCodeFontEmbedded: true,
        maxMeanPixelDifference: 0,
        minContentBoundsIou: 1,
      };
    }

    const manifest = JSON.parse(await readFile(ADF_RENDERED_GOLDEN_MANIFEST, "utf8")) as AdfRenderedGoldenManifest;
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported ADF rendered-golden manifest version.");
    if (manifest.sourceSha256 !== sourceHash()) {
      throw new Error("ADF rendered-golden source changed; review and regenerate the visual baseline explicitly.");
    }
    if (manifest.formats.docx.pages.length !== rendered.docxPages.length) {
      throw new Error("DOCX rendered-golden page count changed.");
    }
    if (manifest.formats.pdf.pages.length !== rendered.pdfPages.length) {
      throw new Error("PDF rendered-golden page count changed.");
    }
    assertRequiredText("DOCX", rendered.docxText, manifest.formats.docx.requiredText);
    assertRequiredText("PDF", rendered.pdfText, manifest.formats.pdf.requiredText);
    assertForbiddenText("DOCX", rendered.docxText, manifest.formats.docx.forbiddenText);
    assertForbiddenText("PDF", rendered.pdfText, manifest.formats.pdf.forbiddenText);

    let maxDifference = 0;
    let minIou = 1;
    for (const [format, currentPages] of [
      ["docx", rendered.docxPages],
      ["pdf", rendered.pdfPages],
    ] as const) {
      const golden = manifest.formats[format];
      for (let index = 0; index < currentPages.length; index += 1) {
        const reference = resolve(ADF_RENDERED_GOLDEN_DIR, golden.pages[index]!.file);
        const referenceBytes = new Uint8Array(await readFile(reference));
        if (sha256(referenceBytes) !== golden.pages[index]!.sha256) {
          throw new Error(`${format.toUpperCase()} rendered-golden reference hash mismatch.`);
        }
        const comparison = await comparePage(currentPages[index]!, reference);
        maxDifference = Math.max(maxDifference, comparison.difference);
        minIou = Math.min(minIou, comparison.iou);
        if (comparison.difference > MAX_MEAN_PIXEL_DIFFERENCE) {
          throw new Error(`${format.toUpperCase()} rendered golden exceeded the perceptual-difference budget.`);
        }
        if (comparison.iou < MIN_CONTENT_BOUNDS_IOU) {
          throw new Error(`${format.toUpperCase()} rendered golden changed its content bounds.`);
        }
      }
    }
    return {
      updated: false,
      docxPages: rendered.docxPages.length,
      pdfPages: rendered.pdfPages.length,
      docxCodeFontEmbedded: true,
      maxMeanPixelDifference: maxDifference,
      minContentBoundsIou: minIou,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const update = process.argv.slice(2).includes("--update");
  const result = await checkAdfRenderedGoldens({ update });
  console.log(JSON.stringify(result, null, 2));
}
