import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PageFacts, PdfFacts, Rect, StructureAttribute, StructureNode } from "./types.ts";

const PDFIUM_VERSION = "2.15.0";
const PACKED_WASM_URL = new URL("./pdfium.wasm", import.meta.url);
const PAGE_OBJECT_IMAGE = 3;

interface PdfiumMemory {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  wasmMemory?: WebAssembly.Memory;
}

function memory(module: WrappedPdfiumModule): PdfiumMemory {
  return module.pdfium as unknown as PdfiumMemory;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function allocate(module: WrappedPdfiumModule, bytes: number): number {
  const pointer = module.pdfium.wasmExports.malloc(Math.max(bytes, 1));
  if (!pointer) throw new Error(`PDFium allocation failed for ${bytes} bytes`);
  return pointer;
}

function withPointer<T>(module: WrappedPdfiumModule, bytes: number, callback: (pointer: number) => T): T {
  const pointer = allocate(module, bytes);
  try {
    return callback(pointer);
  } finally {
    module.pdfium.wasmExports.free(pointer);
  }
}

function readUtf16(
  module: WrappedPdfiumModule,
  getter: (pointer: number, bytes: number) => number,
): string {
  const byteLength = getter(0, 0);
  if (byteLength <= 2) return "";
  return withPointer(module, byteLength, (pointer) => {
    const written = getter(pointer, byteLength);
    if (written <= 2) return "";
    const codeUnits = memory(module).HEAPU16.slice(pointer >>> 1, (pointer + written - 2) >>> 1);
    return String.fromCharCode(...codeUnits);
  });
}

function readUtf8(
  module: WrappedPdfiumModule,
  getter: (pointer: number, bytes: number, outLengthPointer: number) => boolean,
): string {
  return withPointer(module, 4, (outLengthPointer) => {
    if (!getter(0, 0, outLengthPointer)) return "";
    const byteLength = memory(module).HEAP32[outLengthPointer >>> 2] ?? 0;
    if (byteLength <= 1) return "";
    return withPointer(module, byteLength, (pointer) => {
      if (!getter(pointer, byteLength, outLengthPointer)) return "";
      const bytes = memory(module).HEAPU8.slice(pointer, pointer + byteLength - 1);
      return new TextDecoder().decode(bytes);
    });
  });
}

function outFloat(module: WrappedPdfiumModule, callback: (pointer: number) => boolean): number | null {
  return withPointer(module, 4, (pointer) => (callback(pointer) ? round(memory(module).HEAPF32[pointer >>> 2] ?? 0) : null));
}

function rect(module: WrappedPdfiumModule, callback: (pointer: number) => boolean): Rect | null {
  return withPointer(module, 16, (pointer) => {
    if (!callback(pointer)) return null;
    const index = pointer >>> 2;
    const heap = memory(module).HEAPF32;
    return {
      left: round(heap[index] ?? 0),
      bottom: round(heap[index + 1] ?? 0),
      right: round(heap[index + 2] ?? 0),
      top: round(heap[index + 3] ?? 0),
    };
  });
}

function readAttributeValue(module: WrappedPdfiumModule, valueHandle: number): StructureAttribute["value"] {
  const type = module.FPDF_StructElement_Attr_GetType(valueHandle);
  if (type === 1) {
    return withPointer(module, 4, (pointer) => {
      if (!module.FPDF_StructElement_Attr_GetBooleanValue(valueHandle, pointer)) return null;
      return (memory(module).HEAP32[pointer >>> 2] ?? 0) !== 0;
    });
  }
  if (type === 2) {
    return outFloat(module, (pointer) => module.FPDF_StructElement_Attr_GetNumberValue(valueHandle, pointer));
  }
  if (type === 3 || type === 4) {
    return withPointer(module, 4, (outLengthPointer) => {
      if (!module.FPDF_StructElement_Attr_GetStringValue(valueHandle, 0, 0, outLengthPointer)) return null;
      const byteLength = memory(module).HEAP32[outLengthPointer >>> 2] ?? 0;
      if (byteLength <= 2) return "";
      return withPointer(module, byteLength, (pointer) => {
        if (!module.FPDF_StructElement_Attr_GetStringValue(valueHandle, pointer, byteLength, outLengthPointer)) return null;
        const units = memory(module).HEAPU16.slice(pointer >>> 1, (pointer + byteLength - 2) >>> 1);
        return String.fromCharCode(...units);
      });
    });
  }
  if (type === 5 || type === 6) {
    const count = module.FPDF_StructElement_Attr_CountChildren(valueHandle);
    if (count < 0) return null;
    return Array.from({ length: count }, (_, index) => {
      const child = module.FPDF_StructElement_Attr_GetChildAtIndex(valueHandle, index);
      return { name: String(index), type: module.FPDF_StructElement_Attr_GetType(child), value: readAttributeValue(module, child) };
    });
  }
  return null;
}

function structureAttributes(module: WrappedPdfiumModule, element: number): StructureAttribute[] {
  const maps = module.FPDF_StructElement_GetAttributeCount(element);
  const results: StructureAttribute[] = [];
  for (let mapIndex = 0; mapIndex < maps; mapIndex += 1) {
    const map = module.FPDF_StructElement_GetAttributeAtIndex(element, mapIndex);
    const count = module.FPDF_StructElement_Attr_GetCount(map);
    for (let index = 0; index < count; index += 1) {
      const name = readUtf8(module, (pointer, bytes, out) => module.FPDF_StructElement_Attr_GetName(map, index, pointer, bytes, out));
      const valueHandle = module.FPDF_StructElement_Attr_GetValue(map, name);
      const type = module.FPDF_StructElement_Attr_GetType(valueHandle);
      results.push({ name, type, value: readAttributeValue(module, valueHandle) });
    }
  }
  return results;
}

function structureNode(module: WrappedPdfiumModule, element: number, depth = 0): StructureNode {
  if (depth > 64) throw new Error("PDFium structure depth exceeded probe limit");
  const mcids: number[] = [];
  const markedCount = module.FPDF_StructElement_GetMarkedContentIdCount(element);
  for (let index = 0; index < markedCount; index += 1) {
    const mcid = module.FPDF_StructElement_GetMarkedContentIdAtIndex(element, index);
    if (mcid >= 0) mcids.push(mcid);
  }
  if (mcids.length === 0) {
    const mcid = module.FPDF_StructElement_GetMarkedContentID(element);
    if (mcid >= 0) mcids.push(mcid);
  }
  const children: StructureNode[] = [];
  const childMcids: number[] = [];
  const childCount = module.FPDF_StructElement_CountChildren(element);
  for (let index = 0; index < childCount; index += 1) {
    const child = module.FPDF_StructElement_GetChildAtIndex(element, index);
    if (child) children.push(structureNode(module, child, depth + 1));
    else {
      const mcid = module.FPDF_StructElement_GetChildMarkedContentID(element, index);
      if (mcid >= 0) childMcids.push(mcid);
    }
  }
  return {
    type: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetType(element, pointer, bytes)),
    alt: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetAltText(element, pointer, bytes)),
    title: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetTitle(element, pointer, bytes)),
    mcids,
    childMcids,
    attributes: structureAttributes(module, element),
    children,
  };
}

function extractStructures(
  module: WrappedPdfiumModule,
  page: number,
  options: PdfiumAnalyzeOptions,
): StructureNode[] {
  const tree = module.FPDF_StructTree_GetForPage(page);
  if (!tree) return [];
  try {
    checkControl(options, "after-structure-tree");
    const count = module.FPDF_StructTree_CountChildren(tree);
    return Array.from({ length: Math.max(count, 0) }, (_, index) => {
      const child = module.FPDF_StructTree_GetChildAtIndex(tree, index);
      return structureNode(module, child);
    });
  } finally {
    module.FPDF_StructTree_Close(tree);
  }
}

function extractText(
  module: WrappedPdfiumModule,
  page: number,
  options: PdfiumAnalyzeOptions,
): Pick<PageFacts, "text" | "characters"> {
  const textPage = module.FPDFText_LoadPage(page);
  if (!textPage) return { text: "", characters: [] };
  try {
    checkControl(options, "after-text-page");
    const count = module.FPDFText_CountChars(textPage);
    const characters = Array.from({ length: Math.max(count, 0) }, (_, index) => {
      const unicode = module.FPDFText_GetUnicode(textPage, index);
      const textObject = module.FPDFText_GetTextObject(textPage, index);
      return {
        index,
        unicode,
        value: unicode > 0 ? String.fromCodePoint(unicode) : "",
        box: rect(module, (pointer) => module.FPDFText_GetCharBox(textPage, index, pointer, pointer + 4, pointer + 8, pointer + 12)),
        fontSize: round(module.FPDFText_GetFontSize(textPage, index)),
        angle: round(module.FPDFText_GetCharAngle(textPage, index)),
        mcid: textObject ? module.FPDFPageObj_GetMarkedContentID(textObject) : -1,
      };
    });
    return { text: characters.map((character) => character.value).join(""), characters };
  } finally {
    module.FPDFText_ClosePage(textPage);
  }
}

function extractAnnotations(
  module: WrappedPdfiumModule,
  document: number,
  page: number,
  options: PdfiumAnalyzeOptions,
): PageFacts["annotations"] {
  const count = module.FPDFPage_GetAnnotCount(page);
  const annotations: PageFacts["annotations"] = [];
  for (let index = 0; index < count; index += 1) {
    const annotation = module.FPDFPage_GetAnnot(page, index);
    if (!annotation) continue;
    try {
      checkControl(options, "after-annotation");
      const link = module.FPDFAnnot_GetLink(annotation);
      const action = link ? module.FPDFLink_GetAction(link) : 0;
      const actionType = action ? module.FPDFAction_GetType(action) : null;
      let uri: string | null = null;
      if (action && actionType === 3) {
        uri = readUtf8(module, (pointer, bytes, out) => {
          const required = module.FPDFAction_GetURIPath(document, action, pointer, bytes);
          memory(module).HEAP32[out >>> 2] = required;
          return required > 0;
        });
      }
      annotations.push({
        subtype: module.FPDFAnnot_GetSubtype(annotation),
        rect: rect(module, (pointer) => module.FPDFAnnot_GetRect(annotation, pointer)),
        actionType,
        uri,
      });
    } finally {
      module.FPDFPage_CloseAnnot(annotation);
    }
  }
  return annotations;
}

function extractObjects(module: WrappedPdfiumModule, page: number): Pick<PageFacts, "objectTypeCounts" | "images"> {
  const objectTypeCounts: Record<string, number> = {};
  const images: PageFacts["images"] = [];
  const count = module.FPDFPage_CountObjects(page);
  for (let index = 0; index < count; index += 1) {
    const object = module.FPDFPage_GetObject(page, index);
    if (!object) continue;
    const type = module.FPDFPageObj_GetType(object);
    objectTypeCounts[String(type)] = (objectTypeCounts[String(type)] ?? 0) + 1;
    if (type === PAGE_OBJECT_IMAGE) {
      const dimensions = withPointer(module, 8, (pointer) => {
        const ok = module.FPDFImageObj_GetImagePixelSize(object, pointer, pointer + 4);
        return ok
          ? { width: memory(module).HEAP32[pointer >>> 2] ?? 0, height: memory(module).HEAP32[(pointer >>> 2) + 1] ?? 0 }
          : { width: 0, height: 0 };
      });
      images.push({
        mcid: module.FPDFPageObj_GetMarkedContentID(object),
        bounds: rect(module, (pointer) => module.FPDFPageObj_GetBounds(object, pointer, pointer + 4, pointer + 8, pointer + 12)),
        ...dimensions,
        decodedBytes: module.FPDFImageObj_GetImageDataDecoded(object, 0, 0),
      });
    }
  }
  return { objectTypeCounts, images };
}

function renderPage(
  module: WrappedPdfiumModule,
  page: number,
  width: number,
  height: number,
  options: PdfiumAnalyzeOptions,
): PageFacts["render"] {
  const targetWidth = Math.max(1, Math.min(1024, Math.round(width)));
  const targetHeight = Math.max(1, Math.min(1448, Math.round((height / width) * targetWidth)));
  const bitmap = module.FPDFBitmap_Create(targetWidth, targetHeight, 1);
  if (!bitmap) throw new Error("PDFium bitmap allocation failed");
  try {
    checkControl(options, "after-bitmap");
    module.FPDFBitmap_FillRect(bitmap, 0, 0, targetWidth, targetHeight, 0xffffffff);
    module.FPDF_RenderPageBitmap(bitmap, page, 0, 0, targetWidth, targetHeight, 0, 0x01 | 0x02);
    const pointer = module.FPDFBitmap_GetBuffer(bitmap);
    const byteLength = module.FPDFBitmap_GetStride(bitmap) * targetHeight;
    const bytes = memory(module).HEAPU8.slice(pointer, pointer + byteLength);
    return { width: targetWidth, height: targetHeight, sha256: sha256(bytes), bytes: byteLength };
  } finally {
    module.FPDFBitmap_Destroy(bitmap);
  }
}

function extractOutlines(module: WrappedPdfiumModule, document: number): PdfFacts["outlines"] {
  const outlines: PdfFacts["outlines"] = [];
  const visit = (bookmark: number, depth: number): void => {
    if (!bookmark || depth > 64) return;
    const title = readUtf16(module, (pointer, bytes) => module.FPDFBookmark_GetTitle(bookmark, pointer, bytes));
    const destination = module.FPDFBookmark_GetDest(document, bookmark);
    outlines.push({ title, pageIndex: destination ? module.FPDFDest_GetDestPageIndex(document, destination) : null });
    visit(module.FPDFBookmark_GetFirstChild(document, bookmark), depth + 1);
    visit(module.FPDFBookmark_GetNextSibling(document, bookmark), depth);
  };
  visit(module.FPDFBookmark_GetFirstChild(document, 0), 0);
  return outlines;
}

function documentClassification(tagged: boolean, pages: PageFacts[]): PdfFacts["classification"] {
  if (tagged) return "tagged";
  const kinds = new Set(pages.map((page) => page.kind));
  if (kinds.size === 1 && kinds.has("image-only")) return "scan";
  if (kinds.size === 1 && kinds.has("blank")) return "blank";
  if (kinds.size === 1 && kinds.has("digital")) return "digital-untagged";
  return "mixed";
}

function wasmBytes(module: WrappedPdfiumModule): number {
  return memory(module).HEAPU8.buffer.byteLength;
}

export type PdfiumFailureStage =
  | "after-init"
  | "after-input"
  | "after-load"
  | "after-page-load"
  | "after-text-page"
  | "after-structure-tree"
  | "after-annotation"
  | "after-bitmap"
  | "before-finalize";

export interface PdfiumAnalyzeOptions {
  signal?: AbortSignal;
  failAt?: PdfiumFailureStage;
}

function checkControl(options: PdfiumAnalyzeOptions, stage: PdfiumFailureStage): void {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("PDFium analysis aborted");
  if (options.failAt === stage) throw new Error(`injected PDFium failure at ${stage}`);
}

export async function analyzeWithPdfium(bytes: Uint8Array, password = "", options: PdfiumAnalyzeOptions = {}): Promise<PdfFacts> {
  const timingsMs: Record<string, number> = {};
  const started = performance.now();
  let wasmBinary: Uint8Array;
  try {
    wasmBinary = await readFile(PACKED_WASM_URL);
  } catch {
    wasmBinary = await readFile(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")));
  }
  const initStarted = performance.now();
  const module = await init({ wasmBinary });
  module.PDFiumExt_Init();
  timingsMs.init = round(performance.now() - initStarted);
  const initialMemory = wasmBytes(module);
  let peakMemory = initialMemory;
  let inputPointer = 0;
  let document = 0;
  let result: PdfFacts | undefined;
  try {
    checkControl(options, "after-init");
    inputPointer = allocate(module, bytes.byteLength);
    memory(module).HEAPU8.set(bytes, inputPointer);
    checkControl(options, "after-input");
    const loadStarted = performance.now();
    document = module.FPDF_LoadMemDocument64(inputPointer, bytes.byteLength, password);
    timingsMs.load = round(performance.now() - loadStarted);
    if (!document) {
      const loadError = module.FPDF_GetLastError();
      timingsMs.total = round(performance.now() - started);
      result = {
        engine: "pdfium",
        engineVersion: PDFIUM_VERSION,
        inputSha256: sha256(bytes),
        inputBytes: bytes.byteLength,
        pageCount: 0,
        tagged: false,
        encrypted: loadError === 4,
        classification: loadError === 4 ? "encrypted" : "rejected",
        pages: [],
        outlines: [],
        javascriptActionCount: 0,
        attachmentCount: 0,
        namedDestinationCount: 0,
        loadError,
        timingsMs,
        memory: { wasmInitialBytes: initialMemory, wasmPeakBytes: initialMemory, wasmFinalBytes: initialMemory },
      };
      return result;
    }
    checkControl(options, "after-load");
    const pageCount = module.FPDF_GetPageCount(document);
    const tagged = module.FPDFCatalog_IsTagged(document);
    const pages: PageFacts[] = [];
    const pagesStarted = performance.now();
    for (let index = 0; index < pageCount; index += 1) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("PDFium analysis aborted");
      const page = module.FPDF_LoadPage(document, index);
      if (!page) throw new Error(`PDFium could not load page ${index}`);
      try {
        checkControl(options, "after-page-load");
        const width = round(module.FPDF_GetPageWidthF(page));
        const height = round(module.FPDF_GetPageHeightF(page));
        const text = extractText(module, page, options);
        const structures = extractStructures(module, page, options);
        const objects = extractObjects(module, page);
        const annotations = extractAnnotations(module, document, page, options);
        const hasText = text.text.trim().length > 0;
        const hasImages = objects.images.length > 0;
        const kind: PageFacts["kind"] = hasText && hasImages ? "mixed" : hasText ? "digital" : hasImages ? "image-only" : "blank";
        pages.push({
          index,
          width,
          height,
          rotation: module.FPDFPage_GetRotation(page),
          ...text,
          structures,
          ...objects,
          annotations,
          render: renderPage(module, page, width, height, options),
          kind,
        });
        peakMemory = Math.max(peakMemory, wasmBytes(module));
      } finally {
        module.FPDF_ClosePage(page);
      }
    }
    timingsMs.pages = round(performance.now() - pagesStarted);
    result = {
      engine: "pdfium",
      engineVersion: PDFIUM_VERSION,
      inputSha256: sha256(bytes),
      inputBytes: bytes.byteLength,
      pageCount,
      tagged,
      encrypted: false,
      classification: documentClassification(tagged, pages),
      pages,
      outlines: extractOutlines(module, document),
      javascriptActionCount: module.FPDFDoc_GetJavaScriptActionCount(document),
      attachmentCount: module.FPDFDoc_GetAttachmentCount(document),
      namedDestinationCount: module.FPDF_CountNamedDests(document),
      loadError: null,
      timingsMs,
      memory: { wasmInitialBytes: initialMemory, wasmPeakBytes: peakMemory, wasmFinalBytes: 0 },
    };
    timingsMs.total = round(performance.now() - started);
    checkControl(options, "before-finalize");
    return result;
  } finally {
    if (document) module.FPDF_CloseDocument(document);
    if (inputPointer) module.pdfium.wasmExports.free(inputPointer);
    module.FPDF_DestroyLibrary();
    if (result?.memory) result.memory.wasmFinalBytes = wasmBytes(module);
  }
}
