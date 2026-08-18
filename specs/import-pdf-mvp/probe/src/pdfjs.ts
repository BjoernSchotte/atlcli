import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import type { PageFacts, PdfFacts, StructureNode } from "./types.ts";

const PDFJS_VERSION = "6.2.108";
const STANDARD_FONT_DATA_URL = fileURLToPath(new URL("../../standard_fonts/", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")));

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function structureNode(node: { role?: string; children?: unknown[] }): StructureNode {
  const children = (node.children ?? [])
    .filter((child): child is { role?: string; children?: unknown[] } => typeof child === "object" && child !== null && "role" in child)
    .map(structureNode);
  return {
    type: node.role ?? "",
    alt: "",
    title: "",
    mcids: [],
    childMcids: [],
    attributes: [],
    children,
  };
}

function classify(tagged: boolean, pages: PageFacts[]): PdfFacts["classification"] {
  if (tagged) return "tagged";
  const kinds = new Set(pages.map((page) => page.kind));
  if (kinds.size === 1 && kinds.has("image-only")) return "scan";
  if (kinds.size === 1 && kinds.has("blank")) return "blank";
  if (kinds.size === 1 && kinds.has("digital")) return "digital-untagged";
  return "mixed";
}

export async function analyzeWithPdfjs(bytes: Uint8Array, password = ""): Promise<PdfFacts> {
  const started = performance.now();
  const timingsMs: Record<string, number> = {};
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadStarted = performance.now();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    disableWorker: true,
    disableAutoFetch: true,
    disableFontFace: true,
    enableXfa: false,
    isEvalSupported: false,
    useSystemFonts: false,
    stopEventLoop: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    timingsMs.load = round(performance.now() - loadStarted);
    timingsMs.total = round(performance.now() - started);
    await task.destroy();
    return {
      engine: "pdfjs",
      engineVersion: PDFJS_VERSION,
      inputSha256: sha256(bytes),
      inputBytes: bytes.byteLength,
      pageCount: 0,
      tagged: false,
      encrypted: name === "PasswordException",
      classification: name === "PasswordException" ? "encrypted" : "rejected",
      pages: [],
      outlines: [],
      javascriptActionCount: 0,
      attachmentCount: 0,
      namedDestinationCount: 0,
      loadError: name === "PasswordException" ? 4 : 1,
      timingsMs,
      memory: null,
    };
  }
  timingsMs.load = round(performance.now() - loadStarted);
  try {
    const pages: PageFacts[] = [];
    const pageStarted = performance.now();
    for (let index = 0; index < document.numPages; index += 1) {
      const page = await document.getPage(index + 1);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
        const textItems = textContent.items.filter((item): item is Extract<(typeof textContent.items)[number], { str: string }> => "str" in item);
        const characters: PageFacts["characters"] = [];
        let charIndex = 0;
        for (const item of textItems) {
          const left = Number(item.transform[4] ?? 0);
          const bottom = Number(item.transform[5] ?? 0);
          for (const value of item.str) {
            characters.push({
              index: charIndex,
              unicode: value.codePointAt(0) ?? 0,
              value,
              box: { left: round(left), bottom: round(bottom), right: round(left + item.width), top: round(bottom + item.height) },
              fontSize: round(item.height),
              angle: round(Math.atan2(Number(item.transform[1] ?? 0), Number(item.transform[0] ?? 1))),
              mcid: -1,
            });
            charIndex += 1;
          }
          if (item.hasEOL) {
            characters.push({ index: charIndex, unicode: 10, value: "\n", box: null, fontSize: 0, angle: 0, mcid: -1 });
            charIndex += 1;
          }
        }
        const operatorList = await page.getOperatorList();
        const imageOperatorCount = operatorList.fnArray.filter((operation) =>
          operation === pdfjs.OPS.paintImageXObject || operation === pdfjs.OPS.paintImageXObjectRepeat || operation === pdfjs.OPS.paintInlineImageXObject
        ).length;
        const annotationData = await page.getAnnotations({ intent: "display" });
        const annotations = annotationData.map((annotation) => ({
          subtype: Number(annotation.annotationType ?? 0),
          rect: Array.isArray(annotation.rect) && annotation.rect.length === 4
            ? { left: round(annotation.rect[0]), bottom: round(annotation.rect[1]), right: round(annotation.rect[2]), top: round(annotation.rect[3]) }
            : null,
          actionType: annotation.url ? 3 : null,
          uri: annotation.url ?? null,
        }));
        const structTree = await page.getStructTree();
        const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context as never, viewport }).promise;
        const renderBytes = canvas.toBuffer("image/png");
        const text = characters.map((character) => character.value).join("");
        const hasText = text.trim().length > 0;
        const hasImages = imageOperatorCount > 0;
        const kind: PageFacts["kind"] = hasText && hasImages ? "mixed" : hasText ? "digital" : hasImages ? "image-only" : "blank";
        pages.push({
          index,
          width: round(viewport.width),
          height: round(viewport.height),
          rotation: page.rotate,
          text,
          characters,
          structures: structTree ? [structureNode(structTree)] : [],
          objectTypeCounts: { imageOperators: imageOperatorCount, totalOperators: operatorList.fnArray.length },
          images: Array.from({ length: imageOperatorCount }, () => ({ mcid: -1, bounds: null, width: 0, height: 0, decodedBytes: 0 })),
          annotations,
          render: { width: canvas.width, height: canvas.height, sha256: sha256(renderBytes), bytes: renderBytes.byteLength },
          kind,
        });
      } finally {
        page.cleanup();
      }
    }
    timingsMs.pages = round(performance.now() - pageStarted);
    const [outline, attachments, javaScriptActions, destinations, markInfo] = await Promise.all([
      document.getOutline(),
      document.getAttachments(),
      document.getJSActions(),
      document.getDestinations(),
      document.getMarkInfo(),
    ]);
    const outlines: PdfFacts["outlines"] = [];
    const visitOutline = async (items: NonNullable<typeof outline>): Promise<void> => {
      for (const item of items) {
        let pageIndex: number | null = null;
        let destination = item.dest;
        if (typeof destination === "string") destination = await document.getDestination(destination);
        if (Array.isArray(destination) && destination[0]) {
          try {
            pageIndex = await document.getPageIndex(destination[0]);
          } catch {
            pageIndex = null;
          }
        }
        outlines.push({ title: item.title, pageIndex });
        if (item.items.length > 0) await visitOutline(item.items);
      }
    };
    if (outline) await visitOutline(outline);
    const tagged = Boolean(markInfo?.Marked);
    timingsMs.total = round(performance.now() - started);
    return {
      engine: "pdfjs",
      engineVersion: PDFJS_VERSION,
      inputSha256: sha256(bytes),
      inputBytes: bytes.byteLength,
      pageCount: document.numPages,
      tagged,
      encrypted: false,
      classification: classify(tagged, pages),
      pages,
      outlines,
      javascriptActionCount: javaScriptActions ? Object.keys(javaScriptActions).length : 0,
      attachmentCount: attachments?.size ?? 0,
      namedDestinationCount: Object.keys(destinations).length,
      loadError: null,
      timingsMs,
      memory: null,
    };
  } finally {
    await task.destroy();
  }
}
