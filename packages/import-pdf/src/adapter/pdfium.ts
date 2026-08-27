import { sha256Hex } from "@atlcli/core";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import {
  PDF_FACTS_ADAPTER_REVISION,
  PDF_FACTS_ADAPTER_REVISION_V2,
  PDF_FACTS_SCHEMA_V1,
  PDF_FACTS_SCHEMA_V2,
  PDF_ASSET_MATERIALIZER_REVISION,
  PDFIUM_ENGINE_VERSION,
  PDFIUM_WASM_SHA256,
  PDF_ANALYSIS_POLICY_REVISION,
  PDF_ANALYSIS_POLICY_REVISION_V2,
  type PdfAnalysisOptions,
  type PdfAnalysisProgress,
  type PdfAnalysisResultV1,
  type PdfAnalysisResultV2,
  type PdfAnalysisTelemetry,
  type PdfAssetMaterializationOptions,
  type PdfAssetMaterializationRequestV1,
  type PdfAnnotationFact,
  type PdfEngineCapabilitiesV1,
  type PdfEngineCapabilitiesV2,
  type PdfFactsIssue,
  type PdfFactsV1,
  type PdfFactsV2,
  type PdfImageObjectFact,
  type PdfMaterializedAssetV1,
  type PdfNormalizedRect,
  type PdfPathObjectFact,
  type PdfPageFactsV1,
  type PdfPageFactsV2,
  type PdfStructureAttributeFact,
  type PdfStructureNodeFact,
  type PdfStructureKidFactV2,
  type PdfStructureNodeFactV2,
  type PdfTextCharacterFact,
  type PdfTextCharacterFactV2,
} from "../contracts.js";
import { resolvePdfAnalysisBudgets, type PdfAnalysisBudgets } from "../budgets.js";
import { digestPdfCanonical, digestPdfFacts, digestPdfFactsV2 } from "../canonical.js";
import { classifyPdfDocument, classifyPdfPage } from "../classify.js";
import { PdfImportError, isPdfImportError } from "../issues.js";
import { encodeRgbaPng } from "../fallbacks.js";
import type {
  PdfiumAdapterConfig,
  PdfiumAdapterTestConfig,
  PdfiumFailureStage,
  PdfiumFactsAdapter,
  PdfiumFactsAdapterV2,
} from "./contracts.js";

const PAGE_OBJECT_IMAGE = 3;
const PAGE_OBJECT_PATH = 2;
const PAGE_OBJECT_FORM = 5;
const ACTION_URI = 3;
const PDFIUM_LOAD_ERROR_PASSWORD = 4;

const CAPABILITIES: PdfEngineCapabilitiesV1 = Object.freeze({
  textCharacters: true,
  normalizedCharacterGeometry: true,
  structureTree: true,
  structureAttributes: true,
  pageLabels: true,
  outline: true,
  annotations: true,
  pageObjects: true,
  pathGeometry: true,
  imageMetadata: true,
  operatorList: false,
  nativeTableExtraction: false,
  ocr: false,
  activeContentExecution: false,
});
const CAPABILITIES_V2: PdfEngineCapabilitiesV2 = CAPABILITIES;

interface PdfiumMemory {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
}

interface Counters {
  textItems: number;
  pageObjects: number;
  structureNodes: number;
  assets: number;
  decodedPixels: number;
  decodedBytes: number;
  evidenceEntries: number;
  renderedPixels: number;
  renderedBytes: number;
}

interface Control {
  options: { signal?: AbortSignal };
  budgets: PdfAnalysisBudgets;
  started: number;
  failAt?: PdfiumFailureStage;
  stage: string;
  counters: Counters;
}

function memory(module: WrappedPdfiumModule): PdfiumMemory {
  return module.pdfium as unknown as PdfiumMemory;
}

function now(): number {
  return performance.now();
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function emit(options: PdfAnalysisOptions, event: PdfAnalysisProgress): void {
  options.progress?.(event);
}

function check(control: Control, stage: PdfiumFailureStage | string): void {
  control.stage = stage;
  if (control.options.signal?.aborted) {
    throw new PdfImportError("pdf/cancelled", "PDF analysis was cancelled.");
  }
  if (now() - control.started > control.budgets.maxTotalMs) {
    throw new PdfImportError("pdf/deadline-exceeded", "PDF analysis exceeded the total deadline.", {
      limitMs: control.budgets.maxTotalMs,
    });
  }
  if (control.failAt === stage) throw new Error(`injected PDFium failure at ${stage}`);
}

function budget(
  condition: boolean,
  name: string,
  actual: number,
  limit: number,
  pageIndex?: number,
): void {
  if (condition) return;
  throw new PdfImportError("pdf/budget-exceeded", `PDF ${name} budget exceeded.`, {
    budget: name,
    actual,
    limit,
    ...(pageIndex === undefined ? {} : { pageIndex }),
  });
}

function allocate(module: WrappedPdfiumModule, bytes: number): number {
  const pointer = module.pdfium.wasmExports.malloc(Math.max(bytes, 1));
  if (!pointer) {
    throw new PdfImportError("pdf/engine-failure", "PDFium could not allocate a bounded buffer.", {
      bytes,
    });
  }
  return pointer;
}

function withPointer<T>(
  module: WrappedPdfiumModule,
  bytes: number,
  callback: (pointer: number) => T,
): T {
  const pointer = allocate(module, bytes);
  try {
    return callback(pointer);
  } finally {
    module.pdfium.wasmExports.free(pointer);
  }
}

function utf16FromHeap(module: WrappedPdfiumModule, pointer: number, byteLength: number): string {
  const bytes = memory(module).HEAPU8.slice(pointer, pointer + Math.max(0, byteLength - 2));
  return new TextDecoder("utf-16le").decode(bytes);
}

function readUtf16(
  module: WrappedPdfiumModule,
  getter: (pointer: number, bytes: number) => number,
): string {
  const byteLength = getter(0, 0);
  if (byteLength <= 2) return "";
  return withPointer(module, byteLength, (pointer) => {
    const written = getter(pointer, byteLength);
    return written > 2 ? utf16FromHeap(module, pointer, written) : "";
  });
}

function readUtf8WithOutLength(
  module: WrappedPdfiumModule,
  getter: (pointer: number, bytes: number, outLengthPointer: number) => boolean,
): string {
  return withPointer(module, 4, (outLengthPointer) => {
    if (!getter(0, 0, outLengthPointer)) return "";
    const byteLength = memory(module).HEAP32[outLengthPointer >>> 2] ?? 0;
    if (byteLength <= 1) return "";
    return withPointer(module, byteLength, (pointer) => {
      if (!getter(pointer, byteLength, outLengthPointer)) return "";
      return new TextDecoder().decode(memory(module).HEAPU8.slice(pointer, pointer + byteLength - 1));
    });
  });
}

function readActionUri(module: WrappedPdfiumModule, document: number, action: number): string {
  const length = module.FPDFAction_GetURIPath(document, action, 0, 0);
  if (length <= 1) return "";
  return withPointer(module, length, (pointer) => {
    const written = module.FPDFAction_GetURIPath(document, action, pointer, length);
    return written > 1
      ? new TextDecoder().decode(memory(module).HEAPU8.slice(pointer, pointer + written - 1))
      : "";
  });
}

function readOutFloat(module: WrappedPdfiumModule, getter: (pointer: number) => boolean): number | null {
  return withPointer(module, 4, (pointer) =>
    getter(pointer) ? round(memory(module).HEAPF32[pointer >>> 2] ?? 0) : null,
  );
}

function rawRect(
  module: WrappedPdfiumModule,
  getter: (pointer: number) => boolean,
): { left: number; bottom: number; right: number; top: number } | null {
  return withPointer(module, 16, (pointer) => {
    if (!getter(pointer)) return null;
    const heap = memory(module).HEAPF32;
    const index = pointer >>> 2;
    return {
      left: heap[index] ?? 0,
      bottom: heap[index + 1] ?? 0,
      right: heap[index + 2] ?? 0,
      top: heap[index + 3] ?? 0,
    };
  });
}

/** PDFium `FS_RECTF` memory layout is left, top, right, bottom. */
function rawFsRect(
  module: WrappedPdfiumModule,
  getter: (pointer: number) => boolean,
): { left: number; bottom: number; right: number; top: number } | null {
  return withPointer(module, 16, (pointer) => {
    if (!getter(pointer)) return null;
    const heap = memory(module).HEAPF32;
    const index = pointer >>> 2;
    return {
      left: heap[index] ?? 0,
      top: heap[index + 1] ?? 0,
      right: heap[index + 2] ?? 0,
      bottom: heap[index + 3] ?? 0,
    };
  });
}

/** `FPDFText_GetCharBox` writes four doubles: left, right, bottom, top. */
function rawCharacterRect(
  module: WrappedPdfiumModule,
  textPage: number,
  characterIndex: number,
): { left: number; bottom: number; right: number; top: number } | null {
  return withPointer(module, 32, (pointer) => {
    if (!module.FPDFText_GetCharBox(
      textPage,
      characterIndex,
      pointer,
      pointer + 8,
      pointer + 16,
      pointer + 24,
    )) return null;
    const heap = memory(module).HEAPF64;
    const index = pointer >>> 3;
    return {
      left: heap[index] ?? 0,
      right: heap[index + 1] ?? 0,
      bottom: heap[index + 2] ?? 0,
      top: heap[index + 3] ?? 0,
    };
  });
}

function normalizeRect(
  source: { left: number; bottom: number; right: number; top: number } | null,
  pageWidth: number,
  pageHeight: number,
): PdfNormalizedRect | null {
  if (!source || pageWidth <= 0 || pageHeight <= 0) return null;
  const left = Math.min(source.left, source.right);
  const right = Math.max(source.left, source.right);
  const bottom = Math.min(source.bottom, source.top);
  const top = Math.max(source.bottom, source.top);
  const values = [left, right, bottom, top, pageWidth, pageHeight];
  if (values.some((value) => !Number.isFinite(value))) return null;
  const clamp = (value: number): number => Math.max(0, Math.min(1, round(value, 6)));
  return {
    x: clamp(left / pageWidth),
    y: clamp((pageHeight - top) / pageHeight),
    width: clamp((right - left) / pageWidth),
    height: clamp((top - bottom) / pageHeight),
  };
}

function safeExternalTarget(raw: string): string | null {
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function countEvidence(control: Control, amount = 1): void {
  control.counters.evidenceEntries += amount;
  budget(
    control.counters.evidenceEntries <= control.budgets.maxEvidenceEntries,
    "evidence entries",
    control.counters.evidenceEntries,
    control.budgets.maxEvidenceEntries,
  );
}

function readAttributeValue(
  module: WrappedPdfiumModule,
  valueHandle: number,
  control: Control,
  depth: number,
): PdfStructureAttributeFact["value"] {
  budget(
    depth <= control.budgets.maxStructureDepth,
    "structure depth",
    depth,
    control.budgets.maxStructureDepth,
  );
  const type = module.FPDF_StructElement_Attr_GetType(valueHandle);
  if (type === 1) {
    return withPointer(module, 4, (pointer) => {
      if (!module.FPDF_StructElement_Attr_GetBooleanValue(valueHandle, pointer)) return null;
      return (memory(module).HEAP32[pointer >>> 2] ?? 0) !== 0;
    });
  }
  if (type === 2) {
    return readOutFloat(module, (pointer) =>
      module.FPDF_StructElement_Attr_GetNumberValue(valueHandle, pointer),
    );
  }
  if (type === 3 || type === 4) {
    return withPointer(module, 4, (outLengthPointer) => {
      if (!module.FPDF_StructElement_Attr_GetStringValue(valueHandle, 0, 0, outLengthPointer)) {
        return null;
      }
      const length = memory(module).HEAP32[outLengthPointer >>> 2] ?? 0;
      if (length <= 2) return "";
      return withPointer(module, length, (pointer) =>
        module.FPDF_StructElement_Attr_GetStringValue(valueHandle, pointer, length, outLengthPointer)
          ? utf16FromHeap(module, pointer, length)
          : null,
      );
    });
  }
  if (type === 5 || type === 6) {
    const childCount = module.FPDF_StructElement_Attr_CountChildren(valueHandle);
    if (childCount < 0) return null;
    countEvidence(control, childCount);
    return Array.from({ length: childCount }, (_, index) => {
      const child = module.FPDF_StructElement_Attr_GetChildAtIndex(valueHandle, index);
      return {
        name: String(index),
        type: module.FPDF_StructElement_Attr_GetType(child),
        value: readAttributeValue(module, child, control, depth + 1),
      };
    });
  }
  return null;
}

function structureAttributes(
  module: WrappedPdfiumModule,
  element: number,
  control: Control,
): PdfStructureAttributeFact[] {
  const mapCount = Math.max(0, module.FPDF_StructElement_GetAttributeCount(element));
  const result: PdfStructureAttributeFact[] = [];
  for (let mapIndex = 0; mapIndex < mapCount; mapIndex += 1) {
    const map = module.FPDF_StructElement_GetAttributeAtIndex(element, mapIndex);
    const count = Math.max(0, module.FPDF_StructElement_Attr_GetCount(map));
    countEvidence(control, count);
    for (let index = 0; index < count; index += 1) {
      const name = readUtf8WithOutLength(module, (pointer, bytes, outLength) =>
        module.FPDF_StructElement_Attr_GetName(map, index, pointer, bytes, outLength),
      );
      const valueHandle = module.FPDF_StructElement_Attr_GetValue(map, name);
      result.push({
        name,
        type: module.FPDF_StructElement_Attr_GetType(valueHandle),
        value: readAttributeValue(module, valueHandle, control, 0),
      });
    }
  }
  return result;
}

function structureNodeV2(
  module: WrappedPdfiumModule,
  element: number,
  pageIndex: number,
  path: number[],
  control: Control,
  pageCounter: { value: number },
): PdfStructureNodeFactV2 {
  const depth = path.length;
  budget(
    depth <= control.budgets.maxStructureDepth,
    "structure depth",
    depth,
    control.budgets.maxStructureDepth,
    pageIndex,
  );
  pageCounter.value += 1;
  control.counters.structureNodes += 1;
  budget(
    pageCounter.value <= control.budgets.maxStructureNodesPerPage,
    "structure nodes per page",
    pageCounter.value,
    control.budgets.maxStructureNodesPerPage,
    pageIndex,
  );
  budget(
    control.counters.structureNodes <= control.budgets.maxStructureNodesTotal,
    "structure nodes total",
    control.counters.structureNodes,
    control.budgets.maxStructureNodesTotal,
  );
  countEvidence(control);

  const directMcids: number[] = [];
  const markedCount = Math.max(0, module.FPDF_StructElement_GetMarkedContentIdCount(element));
  for (let index = 0; index < markedCount; index += 1) {
    const mcid = module.FPDF_StructElement_GetMarkedContentIdAtIndex(element, index);
    if (mcid >= 0) directMcids.push(mcid);
  }
  if (directMcids.length === 0) {
    const mcid = module.FPDF_StructElement_GetMarkedContentID(element);
    if (mcid >= 0) directMcids.push(mcid);
  }

  const kids: PdfStructureKidFactV2[] = [];
  const childCount = Math.max(0, module.FPDF_StructElement_CountChildren(element));
  for (let index = 0; index < childCount; index += 1) {
    check(control, "structure-child");
    const child = module.FPDF_StructElement_GetChildAtIndex(element, index);
    if (child) {
      kids.push({
        kind: "element",
        index,
        node: structureNodeV2(module, child, pageIndex, [...path, index], control, pageCounter),
      });
      continue;
    }
    const mcid = module.FPDF_StructElement_GetChildMarkedContentID(element, index);
    kids.push(mcid >= 0
      ? { kind: "mcid", index, mcid }
      : { kind: "unresolved", index, reason: "child-handle-and-mcid-unavailable" });
  }
  return {
    id: `pdf:p${pageIndex}:struct:${path.join(".")}`,
    type: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetType(element, pointer, bytes)),
    title: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetTitle(element, pointer, bytes)),
    alt: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetAltText(element, pointer, bytes)),
    actualText: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetActualText(element, pointer, bytes)),
    language: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetLang(element, pointer, bytes)),
    elementId: readUtf16(module, (pointer, bytes) => module.FPDF_StructElement_GetID(element, pointer, bytes)),
    directMcids,
    kids,
    attributes: structureAttributes(module, element, control),
  };
}

function extractStructuresV2(
  module: WrappedPdfiumModule,
  page: number,
  pageIndex: number,
  control: Control,
): PdfStructureNodeFactV2[] {
  const tree = module.FPDF_StructTree_GetForPage(page);
  if (!tree) return [];
  try {
    check(control, "after-structure-tree");
    const count = Math.max(0, module.FPDF_StructTree_CountChildren(tree));
    const pageCounter = { value: 0 };
    return Array.from({ length: count }, (_, index) => {
      const child = module.FPDF_StructTree_GetChildAtIndex(tree, index);
      if (!child) {
        throw new PdfImportError("pdf/engine-failure", "PDFium returned an empty structure child.", {
          pageIndex,
          index,
        });
      }
      return structureNodeV2(module, child, pageIndex, [index], control, pageCounter);
    });
  } finally {
    module.FPDF_StructTree_Close(tree);
  }
}

function extractTextV2(
  module: WrappedPdfiumModule,
  page: number,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  control: Control,
): { text: string; characters: PdfTextCharacterFactV2[] } {
  const textPage = module.FPDFText_LoadPage(page);
  if (!textPage) return { text: "", characters: [] };
  try {
    check(control, "after-text-page");
    const count = Math.max(0, module.FPDFText_CountChars(textPage));
    budget(
      count <= control.budgets.maxTextItemsPerPage,
      "text items per page",
      count,
      control.budgets.maxTextItemsPerPage,
      pageIndex,
    );
    control.counters.textItems += count;
    budget(
      control.counters.textItems <= control.budgets.maxTextItemsTotal,
      "text items total",
      control.counters.textItems,
      control.budgets.maxTextItemsTotal,
    );
    countEvidence(control, count);
    const characters: PdfTextCharacterFactV2[] = [];
    const textRunIds = new Map<number, string>();
    let nextTextRunOrdinal = 0;
    for (let index = 0; index < count; index += 1) {
      if ((index & 1023) === 0) check(control, "text-characters");
      const unicode = module.FPDFText_GetUnicode(textPage, index);
      const textObject = module.FPDFText_GetTextObject(textPage, index);
      const raw = rawCharacterRect(module, textPage, index);
      const mcid = textObject ? module.FPDFPageObj_GetMarkedContentID(textObject) : -1;
      let textRunId: string | null = null;
      if (textObject) {
        textRunId = textRunIds.get(textObject) ?? null;
        if (textRunId === null) {
          textRunId = `pdf:p${pageIndex}:text-run:${nextTextRunOrdinal}`;
          nextTextRunOrdinal += 1;
          textRunIds.set(textObject, textRunId);
        }
      }
      characters.push({
        index,
        unicode,
        value: unicode > 0 && unicode <= 0x10ffff ? String.fromCodePoint(unicode) : "",
        bbox: normalizeRect(raw, pageWidth, pageHeight),
        fontSizePoints: round(module.FPDFText_GetFontSize(textPage, index)),
        fontWeight: Math.max(0, module.FPDFText_GetFontWeight(textPage, index)),
        angleRadians: round(module.FPDFText_GetCharAngle(textPage, index), 6),
        mcid: mcid >= 0 ? mcid : null,
        textRunId,
        generated: module.FPDFText_IsGenerated(textPage, index) > 0,
        hyphen: module.FPDFText_IsHyphen(textPage, index) > 0,
        unicodeMapError: module.FPDFText_HasUnicodeMapError(textPage, index) > 0,
      });
    }
    return { text: characters.map((character) => character.value).join(""), characters };
  } finally {
    module.FPDFText_ClosePage(textPage);
  }
}

function extractAnnotations(
  module: WrappedPdfiumModule,
  document: number,
  page: number,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  control: Control,
  issues: PdfFactsIssue[],
): PdfAnnotationFact[] {
  const count = Math.max(0, module.FPDFPage_GetAnnotCount(page));
  countEvidence(control, count);
  const result: PdfAnnotationFact[] = [];
  for (let index = 0; index < count; index += 1) {
    const annotation = module.FPDFPage_GetAnnot(page, index);
    if (!annotation) continue;
    try {
      check(control, "after-annotation");
      const link = module.FPDFAnnot_GetLink(annotation);
      const action = link ? module.FPDFLink_GetAction(link) : 0;
      const actionType = action ? module.FPDFAction_GetType(action) : null;
      const rawTarget = action && actionType === ACTION_URI
        ? readActionUri(module, document, action)
        : "";
      const safeTarget = safeExternalTarget(rawTarget);
      const unsafeTargetReported = rawTarget.length > 0 && safeTarget === null;
      if (unsafeTargetReported) {
        issues.push({
          code: "pdf-import/unsafe-link-reported",
          severity: "warning",
          outcome: "reported",
          message: "An annotation target was not allowlisted and remains inert.",
          pageIndex,
          sourceRefs: [`pdf:p${pageIndex}:annotation:${index}`],
        });
      }
      if (actionType !== null && actionType !== ACTION_URI) {
        issues.push({
          code: "pdf-import/annotation-action-inert",
          severity: "info",
          outcome: "reported",
          message: "A non-URI annotation action was inventoried and remains inert.",
          pageIndex,
          sourceRefs: [`pdf:p${pageIndex}:annotation:${index}`],
          context: { actionType },
        });
      }
      result.push({
        id: `pdf:p${pageIndex}:annotation:${index}`,
        subtype: module.FPDFAnnot_GetSubtype(annotation),
        bbox: normalizeRect(
          rawFsRect(module, (pointer) => module.FPDFAnnot_GetRect(annotation, pointer)),
          pageWidth,
          pageHeight,
        ),
        actionType,
        safeExternalTarget: safeTarget,
        unsafeTargetReported,
      });
    } finally {
      module.FPDFPage_CloseAnnot(annotation);
    }
  }
  return result;
}

function extractObjects(
  module: WrappedPdfiumModule,
  page: number,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  control: Control,
): Pick<PdfPageFactsV1, "objectTypeCounts" | "operatorSummary" | "images" | "paths"> {
  const objectTypeCounts: Record<string, number> = {};
  const images: PdfImageObjectFact[] = [];
  const paths: PdfPathObjectFact[] = [];
  let pageObjectCount = 0;

  const visit = (
    object: number,
    path: number[],
    ancestors: ReadonlySet<number>,
  ): void => {
    if (!object) return;
    budget(
      path.length <= control.budgets.maxPageObjectDepth,
      "page object depth",
      path.length,
      control.budgets.maxPageObjectDepth,
      pageIndex,
    );
    if (ancestors.has(object)) {
      throw new PdfImportError("pdf/engine-failure", "PDF page-object graph contains a cycle.", {
        pageIndex,
      });
    }
    pageObjectCount += 1;
    control.counters.pageObjects += 1;
    budget(
      pageObjectCount <= control.budgets.maxPageObjectsPerPage,
      "page objects per page",
      pageObjectCount,
      control.budgets.maxPageObjectsPerPage,
      pageIndex,
    );
    budget(
      control.counters.pageObjects <= control.budgets.maxPageObjectsTotal,
      "page objects total",
      control.counters.pageObjects,
      control.budgets.maxPageObjectsTotal,
    );
    countEvidence(control);
    if ((pageObjectCount & 1023) === 1) check(control, "page-objects");
    const type = module.FPDFPageObj_GetType(object);
    objectTypeCounts[String(type)] = (objectTypeCounts[String(type)] ?? 0) + 1;
    if (type === PAGE_OBJECT_FORM) {
      const childCount = Math.max(0, module.FPDFFormObj_CountObjects(object));
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(object);
      for (let index = 0; index < childCount; index += 1) {
        visit(module.FPDFFormObj_GetObject(object, index), [...path, index], nextAncestors);
      }
      return;
    }
    if (type === PAGE_OBJECT_PATH) {
      const drawMode = withPointer(module, 8, (pointer) => {
        const ok = module.FPDFPath_GetDrawMode(object, pointer, pointer + 4);
        return ok
          ? {
              fillMode: memory(module).HEAP32[pointer >>> 2] ?? 0,
              stroke: (memory(module).HEAP32[(pointer >>> 2) + 1] ?? 0) !== 0,
            }
          : { fillMode: 0, stroke: false };
      });
      paths.push({
        id: `pdf:p${pageIndex}:path:${path.join(".")}`,
        mcid: (() => {
          const mcid = module.FPDFPageObj_GetMarkedContentID(object);
          return mcid >= 0 ? mcid : null;
        })(),
        bbox: normalizeRect(
          rawRect(module, (pointer) =>
            module.FPDFPageObj_GetBounds(object, pointer, pointer + 4, pointer + 8, pointer + 12),
          ),
          pageWidth,
          pageHeight,
        ),
        segmentCount: Math.max(0, module.FPDFPath_CountSegments(object)),
        ...drawMode,
      });
      return;
    }
    if (type !== PAGE_OBJECT_IMAGE) return;
    const dimensions = withPointer(module, 8, (pointer) => {
      const ok = module.FPDFImageObj_GetImagePixelSize(object, pointer, pointer + 4);
      return ok
        ? {
            width: memory(module).HEAP32[pointer >>> 2] ?? 0,
            height: memory(module).HEAP32[(pointer >>> 2) + 1] ?? 0,
          }
        : { width: 0, height: 0 };
    });
    const pixels = dimensions.width * dimensions.height;
    budget(
      Number.isSafeInteger(pixels) && pixels >= 0 && pixels <= control.budgets.maxDecodedPixelsPerAsset,
      "decoded pixels per asset",
      Number.isFinite(pixels) ? pixels : Number.MAX_SAFE_INTEGER,
      control.budgets.maxDecodedPixelsPerAsset,
      pageIndex,
    );
    control.counters.decodedPixels += pixels;
    budget(
      control.counters.decodedPixels <= control.budgets.maxDecodedPixelsTotal,
      "decoded pixels total",
      control.counters.decodedPixels,
      control.budgets.maxDecodedPixelsTotal,
    );
    const decodedBytes = Math.max(0, module.FPDFImageObj_GetImageDataDecoded(object, 0, 0));
    budget(
      decodedBytes <= control.budgets.maxDecodedBytesPerAsset,
      "decoded bytes per asset",
      decodedBytes,
      control.budgets.maxDecodedBytesPerAsset,
      pageIndex,
    );
    control.counters.decodedBytes += decodedBytes;
    budget(
      control.counters.decodedBytes <= control.budgets.maxDecodedBytesTotal,
      "decoded bytes total",
      control.counters.decodedBytes,
      control.budgets.maxDecodedBytesTotal,
    );
    images.push({
      id: `pdf:p${pageIndex}:image:${path.join(".")}`,
      mcid: (() => {
        const mcid = module.FPDFPageObj_GetMarkedContentID(object);
        return mcid >= 0 ? mcid : null;
      })(),
      bbox: normalizeRect(
        rawRect(module, (pointer) =>
          module.FPDFPageObj_GetBounds(object, pointer, pointer + 4, pointer + 8, pointer + 12),
        ),
        pageWidth,
        pageHeight,
      ),
      pixelWidth: dimensions.width,
      pixelHeight: dimensions.height,
      decodedBytes,
    });
  };

  const count = Math.max(0, module.FPDFPage_CountObjects(page));
  for (let index = 0; index < count; index += 1) {
    visit(module.FPDFPage_GetObject(page, index), [index], new Set());
  }
  budget(
    images.length <= control.budgets.maxAssetsPerPage,
    "assets per page",
    images.length,
    control.budgets.maxAssetsPerPage,
    pageIndex,
  );
  control.counters.assets += images.length;
  budget(
    control.counters.assets <= control.budgets.maxAssetsTotal,
    "assets total",
    control.counters.assets,
    control.budgets.maxAssetsTotal,
  );
  check(control, "after-page-objects");
  return {
    objectTypeCounts,
    operatorSummary: { capability: "unavailable", count: null },
    images,
    paths,
  };
}

function extractOutline(
  module: WrappedPdfiumModule,
  document: number,
  control: Control,
): PdfFactsV1["outline"] {
  const outline: PdfFactsV1["outline"] = [];
  const visit = (bookmark: number, depth: number): void => {
    if (!bookmark) return;
    budget(
      depth <= control.budgets.maxOutlineDepth,
      "outline depth",
      depth,
      control.budgets.maxOutlineDepth,
    );
    check(control, "outline");
    countEvidence(control);
    const destination = module.FPDFBookmark_GetDest(document, bookmark);
    outline.push({
      title: readUtf16(module, (pointer, bytes) => module.FPDFBookmark_GetTitle(bookmark, pointer, bytes)),
      pageIndex: destination ? module.FPDFDest_GetDestPageIndex(document, destination) : null,
      depth,
    });
    visit(module.FPDFBookmark_GetFirstChild(document, bookmark), depth + 1);
    visit(module.FPDFBookmark_GetNextSibling(document, bookmark), depth);
  };
  visit(module.FPDFBookmark_GetFirstChild(document, 0), 0);
  return outline;
}

function validateInput(data: Uint8Array, budgets: PdfAnalysisBudgets): void {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new PdfImportError("pdf/input-empty", "PDF input must be a non-empty Uint8Array.");
  }
  if (data.byteLength > budgets.maxInputBytes) {
    throw new PdfImportError("pdf/input-too-large", "PDF input exceeds the byte budget.", {
      actual: data.byteLength,
      limit: budgets.maxInputBytes,
    });
  }
  if (
    data.byteLength < 5 ||
    data[0] !== 0x25 ||
    data[1] !== 0x50 ||
    data[2] !== 0x44 ||
    data[3] !== 0x46 ||
    data[4] !== 0x2d
  ) {
    throw new PdfImportError("pdf/signature-invalid", "Input does not start with the PDF signature.");
  }
}

function wasmBytes(module: WrappedPdfiumModule): number {
  return memory(module).HEAPU8.buffer.byteLength;
}

function sanitizedEngineError(error: unknown, stage: string): PdfImportError {
  if (isPdfImportError(error)) return error;
  return new PdfImportError("pdf/engine-failure", "PDFium analysis failed.", { stage });
}

async function analyzePdfiumV2(
  data: Uint8Array,
  wasmBinary: Uint8Array,
  options: PdfAnalysisOptions,
  failAt?: PdfiumFailureStage,
  factsDigestMaxBytes?: number,
): Promise<PdfAnalysisResultV2> {
  const budgets = resolvePdfAnalysisBudgets(options.budgets);
  validateInput(data, budgets);
  const actualWasmDigest = await sha256Hex(wasmBinary);
  if (actualWasmDigest !== PDFIUM_WASM_SHA256) {
    throw new PdfImportError("pdf/wasm-digest-mismatch", "PDFium WASM digest does not match the reviewed artifact.");
  }
  const optionsDigest = await digestPdfCanonical({
    budgetRevision: "atlcli.pdf-analysis-budgets/1",
    budgets,
    policyRevision: PDF_ANALYSIS_POLICY_REVISION_V2,
  });
  const started = now();
  const telemetry: PdfAnalysisTelemetry = {
    initMs: 0,
    loadMs: 0,
    pagesMs: 0,
    totalMs: 0,
    wasmInitialBytes: 0,
    wasmPeakBytes: 0,
    wasmFinalBytes: 0,
  };
  const control: Control = {
    options,
    budgets,
    started,
    failAt,
    stage: "start",
    counters: {
      textItems: 0,
      pageObjects: 0,
      structureNodes: 0,
      assets: 0,
      decodedPixels: 0,
      decodedBytes: 0,
      evidenceEntries: 0,
      renderedPixels: 0,
      renderedBytes: 0,
    },
  };
  let module: WrappedPdfiumModule | undefined;
  let initialized = false;
  let inputPointer = 0;
  let document = 0;
  let completedPages = 0;
  let totalPages: number | null = null;
  emit(options, { phase: "start", completedPages: 0, totalPages: null });
  try {
    const initStarted = now();
    module = await init({ wasmBinary: new Uint8Array(wasmBinary).buffer });
    module.PDFiumExt_Init();
    initialized = true;
    telemetry.initMs = round(now() - initStarted);
    telemetry.wasmInitialBytes = wasmBytes(module);
    telemetry.wasmPeakBytes = telemetry.wasmInitialBytes;
    check(control, "after-init");

    inputPointer = allocate(module, data.byteLength);
    memory(module).HEAPU8.set(data, inputPointer);
    check(control, "after-input");
    const loadStarted = now();
    document = module.FPDF_LoadMemDocument64(inputPointer, data.byteLength, "");
    telemetry.loadMs = round(now() - loadStarted);
    const inputSha256 = await sha256Hex(data);
    const provenance = {
      engine: "pdfium" as const,
      engineVersion: PDFIUM_ENGINE_VERSION,
      wasmSha256: PDFIUM_WASM_SHA256,
      adapterRevision: PDF_FACTS_ADAPTER_REVISION_V2,
      policyRevision: PDF_ANALYSIS_POLICY_REVISION_V2,
      optionsDigest,
      capabilities: CAPABILITIES_V2,
    };
    if (!document) {
      const loadError = module.FPDF_GetLastError();
      const encrypted = loadError === PDFIUM_LOAD_ERROR_PASSWORD;
      const facts: PdfFactsV2 = {
        schema: PDF_FACTS_SCHEMA_V2,
        provenance,
        inputSha256,
        inputBytes: data.byteLength,
        pageCount: 0,
        tagged: false,
        encrypted,
        classification: encrypted ? "encrypted" : "rejected",
        completeness: { expectedPages: 0, analyzedPages: 0, pageIndexes: [], complete: false },
        pages: [],
        outline: [],
        inertFeatures: {
          javascriptActionCount: 0,
          attachmentCount: 0,
          namedDestinationCount: 0,
          formType: 0,
        },
        loadError,
        issues: [{
          code: encrypted ? "pdf-import/encrypted-rejected" : "pdf-import/load-rejected",
          severity: "error",
          outcome: "rejected",
          message: encrypted
            ? "Encrypted PDFs are rejected by the digital MVP."
            : "PDFium rejected the document before page analysis.",
          context: { loadError },
        }],
      };
      const factsDigest = await digestPdfFactsV2(
        facts,
        factsDigestMaxBytes ?? budgets.maxCanonicalBytes,
      );
      return { facts, factsDigest, telemetry };
    }
    check(control, "after-load");
    totalPages = module.FPDF_GetPageCount(document);
    if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > budgets.maxPages) {
      throw new PdfImportError("pdf/page-count-invalid", "PDF page count is outside the supported budget.", {
        actual: totalPages,
        limit: budgets.maxPages,
      });
    }
    emit(options, { phase: "document-loaded", completedPages: 0, totalPages });
    const tagged = module.FPDFCatalog_IsTagged(document);
    const issues: PdfFactsIssue[] = [{
      code: "pdf-import/operator-list-unavailable",
      severity: "info",
      outcome: "reported",
      message: "The selected public PDFium contract exposes page-object summaries, not an operator list.",
    }];
    const pages: PdfPageFactsV2[] = [];
    const pagesStarted = now();
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      check(control, "page-loop");
      const pageStarted = now();
      emit(options, { phase: "page-start", completedPages, totalPages, pageIndex });
      const page = module.FPDF_LoadPage(document, pageIndex);
      if (!page) {
        throw new PdfImportError("pdf/engine-failure", "PDFium could not load a source page.", {
          pageIndex,
        });
      }
      try {
        check(control, "after-page-load");
        const widthPoints = round(module.FPDF_GetPageWidthF(page));
        const heightPoints = round(module.FPDF_GetPageHeightF(page));
        if (widthPoints <= 0 || heightPoints <= 0) {
          throw new PdfImportError("pdf/engine-failure", "PDFium returned invalid page dimensions.", {
            pageIndex,
          });
        }
        const pageBox = (
          getter: (pointer: number) => boolean,
        ): PdfNormalizedRect | null => normalizeRect(rawRect(module!, getter), widthPoints, heightPoints);
        const boxes = {
          bounding: normalizeRect(
            rawFsRect(module, (pointer) => module!.FPDF_GetPageBoundingBox(page, pointer)),
            widthPoints,
            heightPoints,
          ),
          media: pageBox((pointer) =>
            module!.FPDFPage_GetMediaBox(page, pointer, pointer + 4, pointer + 8, pointer + 12),
          ),
          crop: pageBox((pointer) =>
            module!.FPDFPage_GetCropBox(page, pointer, pointer + 4, pointer + 8, pointer + 12),
          ),
          bleed: pageBox((pointer) =>
            module!.FPDFPage_GetBleedBox(page, pointer, pointer + 4, pointer + 8, pointer + 12),
          ),
          trim: pageBox((pointer) =>
            module!.FPDFPage_GetTrimBox(page, pointer, pointer + 4, pointer + 8, pointer + 12),
          ),
          art: pageBox((pointer) =>
            module!.FPDFPage_GetArtBox(page, pointer, pointer + 4, pointer + 8, pointer + 12),
          ),
        };
        const text = extractTextV2(module, page, pageIndex, widthPoints, heightPoints, control);
        const structures = extractStructuresV2(module, page, pageIndex, control);
        const objects = extractObjects(module, page, pageIndex, widthPoints, heightPoints, control);
        const annotations = extractAnnotations(
          module,
          document,
          page,
          pageIndex,
          widthPoints,
          heightPoints,
          control,
          issues,
        );
        const label = readUtf16(module, (pointer, bytes) =>
          module!.FPDF_GetPageLabel(document, pageIndex, pointer, bytes),
        );
        const kind = classifyPdfPage(text.text, objects.images.length);
        if (kind === "image-only" || kind === "blank") {
          issues.push({
            code: kind === "image-only" ? "pdf-import/image-only-page" : "pdf-import/blank-page",
            severity: "warning",
            outcome: "reported",
            message: kind === "image-only"
              ? "An image-only page has no trustworthy native text and requires an explicit scan policy."
              : "A blank page was accounted for explicitly.",
            pageIndex,
            sourceRefs: [`pdf:p${pageIndex}`],
          });
        }
        pages.push({
          index: pageIndex,
          ...(label ? { label } : {}),
          widthPoints,
          heightPoints,
          boxes,
          rotation: module.FPDFPage_GetRotation(page),
          kind,
          ...text,
          structures,
          ...objects,
          annotations,
        });
        telemetry.wasmPeakBytes = Math.max(telemetry.wasmPeakBytes, wasmBytes(module));
        const pageMs = now() - pageStarted;
        if (pageMs > budgets.maxPageMs) {
          throw new PdfImportError("pdf/deadline-exceeded", "PDF page analysis exceeded its deadline.", {
            pageIndex,
            actualMs: round(pageMs),
            limitMs: budgets.maxPageMs,
          });
        }
        completedPages += 1;
        emit(options, { phase: "page-complete", completedPages, totalPages, pageIndex });
      } finally {
        module.FPDF_ClosePage(page);
      }
    }
    telemetry.pagesMs = round(now() - pagesStarted);
    check(control, "before-finalize");
    const pageIndexes = pages.map((page) => page.index);
    const completeness = {
      expectedPages: totalPages,
      analyzedPages: pages.length,
      pageIndexes,
      complete:
        pages.length === totalPages &&
        pageIndexes.every((pageIndex, index) => pageIndex === index),
    };
    if (!completeness.complete) {
      throw new PdfImportError("pdf/incomplete", "PDF page accounting is incomplete.");
    }
    const javascriptActionCount = Math.max(0, module.FPDFDoc_GetJavaScriptActionCount(document));
    const attachmentCount = Math.max(0, module.FPDFDoc_GetAttachmentCount(document));
    if (javascriptActionCount > 0) {
      issues.push({
        code: "pdf-import/javascript-inert",
        severity: "warning",
        outcome: "reported",
        message: "JavaScript actions were inventoried and never executed.",
        context: { count: javascriptActionCount },
      });
    }
    if (attachmentCount > 0) {
      issues.push({
        code: "pdf-import/embedded-files-inert",
        severity: "warning",
        outcome: "reported",
        message: "Embedded files were inventoried and never extracted.",
        context: { count: attachmentCount },
      });
    }
    budget(
      issues.length <= budgets.maxEvidenceEntries,
      "issues",
      issues.length,
      budgets.maxEvidenceEntries,
    );
    countEvidence(control, issues.length);
    const facts: PdfFactsV2 = {
      schema: PDF_FACTS_SCHEMA_V2,
      provenance,
      inputSha256,
      inputBytes: data.byteLength,
      pageCount: totalPages,
      tagged,
      encrypted: false,
      classification: classifyPdfDocument(tagged, pages),
      completeness,
      pages,
      outline: extractOutline(module, document, control),
      inertFeatures: {
        javascriptActionCount,
        attachmentCount,
        namedDestinationCount: Math.max(0, module.FPDF_CountNamedDests(document)),
        formType: module.FPDF_GetFormType(document),
      },
      loadError: null,
      issues,
    };
    const factsDigest = await digestPdfFactsV2(
      facts,
      factsDigestMaxBytes ?? budgets.maxCanonicalBytes,
    );
    check(control, "facts-digest");
    emit(options, { phase: "complete", completedPages, totalPages });
    return { facts, factsDigest, telemetry };
  } catch (error) {
    throw sanitizedEngineError(error, control.stage);
  } finally {
    if (module && document) module.FPDF_CloseDocument(document);
    if (module && inputPointer) module.pdfium.wasmExports.free(inputPointer);
    if (module && initialized) module.FPDF_DestroyLibrary();
    if (module) telemetry.wasmFinalBytes = wasmBytes(module);
    telemetry.totalMs = round(now() - started);
    emit(options, { phase: "cleanup", completedPages, totalPages });
  }
}

function projectTextCharacterV1(character: PdfTextCharacterFactV2): PdfTextCharacterFact {
  return {
    index: character.index,
    unicode: character.unicode,
    value: character.value,
    bbox: character.bbox,
    fontSizePoints: character.fontSizePoints,
    fontWeight: character.fontWeight,
    angleRadians: character.angleRadians,
    mcid: character.mcid,
    generated: character.generated,
    hyphen: character.hyphen,
    unicodeMapError: character.unicodeMapError,
  };
}

function projectStructureNodeV1(node: PdfStructureNodeFactV2): PdfStructureNodeFact {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    alt: node.alt,
    actualText: node.actualText,
    language: node.language,
    elementId: node.elementId,
    mcids: [...node.directMcids],
    childMcids: node.kids.flatMap((kid) => kid.kind === "mcid" ? [kid.mcid] : []),
    attributes: node.attributes,
    children: node.kids.flatMap((kid) =>
      kid.kind === "element" ? [projectStructureNodeV1(kid.node)] : []
    ),
  };
}

function projectPageFactsV1(page: PdfPageFactsV2): PdfPageFactsV1 {
  return {
    index: page.index,
    ...(page.label === undefined ? {} : { label: page.label }),
    widthPoints: page.widthPoints,
    heightPoints: page.heightPoints,
    boxes: page.boxes,
    rotation: page.rotation,
    kind: page.kind,
    text: page.text,
    characters: page.characters.map(projectTextCharacterV1),
    structures: page.structures.map(projectStructureNodeV1),
    objectTypeCounts: page.objectTypeCounts,
    operatorSummary: page.operatorSummary,
    images: page.images,
    paths: page.paths,
    annotations: page.annotations,
  };
}

function projectFactsV1(facts: PdfFactsV2, optionsDigest: string): PdfFactsV1 {
  return {
    schema: PDF_FACTS_SCHEMA_V1,
    provenance: {
      engine: "pdfium",
      engineVersion: PDFIUM_ENGINE_VERSION,
      wasmSha256: PDFIUM_WASM_SHA256,
      adapterRevision: PDF_FACTS_ADAPTER_REVISION,
      policyRevision: PDF_ANALYSIS_POLICY_REVISION,
      optionsDigest,
      capabilities: CAPABILITIES,
    },
    inputSha256: facts.inputSha256,
    inputBytes: facts.inputBytes,
    pageCount: facts.pageCount,
    tagged: facts.tagged,
    encrypted: facts.encrypted,
    classification: facts.classification,
    completeness: facts.completeness,
    pages: facts.pages.map(projectPageFactsV1),
    outline: facts.outline,
    inertFeatures: facts.inertFeatures,
    loadError: facts.loadError,
    issues: facts.issues,
  };
}

async function analyzePdfiumV1(
  data: Uint8Array,
  wasmBinary: Uint8Array,
  options: PdfAnalysisOptions,
  failAt?: PdfiumFailureStage,
): Promise<PdfAnalysisResultV1> {
  // The V1 compatibility path must enforce its own canonical-size budget on
  // the projected V1 facts. V2-only evidence must not make an otherwise valid
  // V1 analysis fail before that projection is available.
  const resultV2 = await analyzePdfiumV2(
    data,
    wasmBinary,
    options,
    failAt,
    Number.MAX_SAFE_INTEGER,
  );
  const budgets = resolvePdfAnalysisBudgets(options.budgets);
  const optionsDigest = await digestPdfCanonical({
    budgetRevision: "atlcli.pdf-analysis-budgets/1",
    budgets,
    policyRevision: PDF_ANALYSIS_POLICY_REVISION,
  });
  const facts = projectFactsV1(resultV2.facts, optionsDigest);
  return {
    facts,
    factsDigest: await digestPdfFacts(facts, budgets.maxCanonicalBytes),
    telemetry: resultV2.telemetry,
  };
}

function pageObjectAtPath(
  module: WrappedPdfiumModule,
  page: number,
  path: readonly number[],
): number {
  if (path.length === 0) return 0;
  let object = module.FPDFPage_GetObject(page, path[0]!);
  for (const index of path.slice(1)) {
    if (!object || module.FPDFPageObj_GetType(object) !== PAGE_OBJECT_FORM) return 0;
    if (index < 0 || index >= module.FPDFFormObj_CountObjects(object)) return 0;
    object = module.FPDFFormObj_GetObject(object, index);
  }
  return object;
}

function imageObjectPath(request: PdfAssetMaterializationRequestV1): number[] {
  const prefix = `pdf:p${request.pageIndex}:image:`;
  if (!request.objectId?.startsWith(prefix)) return [];
  const values = request.objectId.slice(prefix.length).split(".").map(Number);
  return values.every((value) => Number.isSafeInteger(value) && value >= 0) ? values : [];
}

function bitmapToRgba(
  module: WrappedPdfiumModule,
  bitmap: number,
  budgets: PdfAnalysisBudgets,
  pageIndex: number,
): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const width = module.FPDFBitmap_GetWidth(bitmap);
  const height = module.FPDFBitmap_GetHeight(bitmap);
  const stride = module.FPDFBitmap_GetStride(bitmap);
  const format = module.FPDFBitmap_GetFormat(bitmap);
  const pointer = module.FPDFBitmap_GetBuffer(bitmap);
  if (
    !pointer
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(stride)
    || width < 1
    || height < 1
    || stride < 1
    || ![1, 2, 3, 4].includes(format)
  ) throw new PdfImportError("pdf/engine-failure", "PDFium returned an invalid bitmap.");
  const pixels = width * height;
  budget(
    Number.isSafeInteger(pixels) && pixels <= budgets.maxRenderedPixelsPerAsset,
    "rendered pixels per asset",
    pixels,
    budgets.maxRenderedPixelsPerAsset,
    pageIndex,
  );
  const channels = format === 1 ? 1 : format === 2 ? 3 : 4;
  if (stride < width * channels) {
    throw new PdfImportError("pdf/engine-failure", "PDFium returned a truncated bitmap stride.");
  }
  const source = memory(module).HEAPU8;
  if (pointer + stride * height > source.byteLength) {
    throw new PdfImportError("pdf/engine-failure", "PDFium bitmap escapes the owned WASM memory.");
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = pointer + y * stride;
    for (let x = 0; x < width; x += 1) {
      const input = row + x * channels;
      const output = (y * width + x) * 4;
      if (format === 1) {
        const gray = source[input] ?? 0;
        rgba.set([gray, gray, gray, 255], output);
      } else {
        rgba[output] = source[input + 2] ?? 0;
        rgba[output + 1] = source[input + 1] ?? 0;
        rgba[output + 2] = source[input] ?? 0;
        rgba[output + 3] = format === 4 ? (source[input + 3] ?? 255) : 255;
      }
    }
  }
  return { width, height, rgba };
}

function validatedRegion(request: PdfAssetMaterializationRequestV1) {
  const rect = request.bbox;
  if (
    !rect
    || [rect.x, rect.y, rect.width, rect.height].some((value) => !Number.isFinite(value))
    || rect.x < 0
    || rect.y < 0
    || rect.width <= 0
    || rect.height <= 0
    || rect.x + rect.width > 1.000001
    || rect.y + rect.height > 1.000001
  ) throw new PdfImportError("pdf/asset-request-invalid", "Rendered-region request has invalid normalized bounds.");
  return rect;
}

async function materializePdfium(
  data: Uint8Array,
  requests: readonly PdfAssetMaterializationRequestV1[],
  wasmBinary: Uint8Array,
  options: PdfAssetMaterializationOptions,
  failAt?: PdfiumFailureStage,
): Promise<PdfMaterializedAssetV1[]> {
  const budgets = resolvePdfAnalysisBudgets(options.budgets);
  validateInput(data, budgets);
  if (!Array.isArray(requests) || requests.length > budgets.maxAssetsTotal) {
    throw new PdfImportError("pdf/budget-exceeded", "PDF materialization request count exceeds the asset budget.", {
      actual: Array.isArray(requests) ? requests.length : 0,
      limit: budgets.maxAssetsTotal,
    });
  }
  if (new Set(requests.map((request) => request.id)).size !== requests.length) {
    throw new PdfImportError("pdf/asset-request-invalid", "PDF materialization request ids must be unique.");
  }
  if (await sha256Hex(wasmBinary) !== PDFIUM_WASM_SHA256) {
    throw new PdfImportError("pdf/wasm-digest-mismatch", "PDFium WASM digest does not match the reviewed artifact.");
  }
  const control: Control = {
    options,
    budgets,
    started: now(),
    failAt,
    stage: "materialize-start",
    counters: {
      textItems: 0,
      pageObjects: 0,
      structureNodes: 0,
      assets: 0,
      decodedPixels: 0,
      decodedBytes: 0,
      evidenceEntries: 0,
      renderedPixels: 0,
      renderedBytes: 0,
    },
  };
  let module: WrappedPdfiumModule | undefined;
  let initialized = false;
  let inputPointer = 0;
  let document = 0;
  let completed = 0;
  options.progress?.({ phase: "start", completed: 0, total: requests.length });
  try {
    module = await init({ wasmBinary: new Uint8Array(wasmBinary).buffer });
    module.PDFiumExt_Init();
    initialized = true;
    check(control, "after-init");
    inputPointer = allocate(module, data.byteLength);
    memory(module).HEAPU8.set(data, inputPointer);
    check(control, "after-input");
    document = module.FPDF_LoadMemDocument64(inputPointer, data.byteLength, "");
    if (!document) throw new PdfImportError("pdf/engine-failure", "PDFium could not load bytes for asset materialization.");
    check(control, "after-load");
    const pageCount = module.FPDF_GetPageCount(document);
    const assets: PdfMaterializedAssetV1[] = [];
    for (const request of requests) {
      check(control, "materialize-request");
      options.progress?.({
        phase: "request-start",
        completed,
        total: requests.length,
        requestId: request.id,
      });
      if (!request.id || request.pageIndex < 0 || request.pageIndex >= pageCount) {
        throw new PdfImportError("pdf/asset-request-invalid", "PDF materialization request targets an invalid page.");
      }
      const page = module.FPDF_LoadPage(document, request.pageIndex);
      if (!page) throw new PdfImportError("pdf/engine-failure", "PDFium could not load a requested asset page.");
      let bitmap = 0;
      try {
        check(control, "after-page-load");
        if (request.kind === "image-object") {
          const path = imageObjectPath(request);
          const object = pageObjectAtPath(module, page, path);
          if (!object || module.FPDFPageObj_GetType(object) !== PAGE_OBJECT_IMAGE) {
            throw new PdfImportError("pdf/asset-request-invalid", "PDF image request does not identify a public image object.");
          }
          const dimensions = withPointer(module, 8, (pointer) => {
            if (!module!.FPDFImageObj_GetImagePixelSize(object, pointer, pointer + 4)) return 0;
            const width = memory(module!).HEAP32[pointer >>> 2] ?? 0;
            const height = memory(module!).HEAP32[(pointer >>> 2) + 1] ?? 0;
            return width * height;
          });
          budget(
            Number.isSafeInteger(dimensions) && dimensions > 0 && dimensions <= budgets.maxRenderedPixelsPerAsset,
            "rendered pixels per asset",
            dimensions,
            budgets.maxRenderedPixelsPerAsset,
            request.pageIndex,
          );
          bitmap = module.FPDFImageObj_GetRenderedBitmap(document, page, object);
        } else if (request.kind === "rendered-region") {
          const rect = validatedRegion(request);
          const dpi = request.dpi ?? 144;
          if (!Number.isSafeInteger(dpi) || dpi < 72 || dpi > budgets.maxRenderDpi) {
            throw new PdfImportError("pdf/budget-exceeded", "PDF render DPI is outside the reviewed budget.", {
              actual: dpi,
              limit: budgets.maxRenderDpi,
            });
          }
          const fullWidth = Math.max(1, Math.ceil(module.FPDF_GetPageWidthF(page) * dpi / 72));
          const fullHeight = Math.max(1, Math.ceil(module.FPDF_GetPageHeightF(page) * dpi / 72));
          const left = Math.floor(rect.x * fullWidth);
          const top = Math.floor(rect.y * fullHeight);
          const width = Math.max(1, Math.ceil(rect.width * fullWidth));
          const height = Math.max(1, Math.ceil(rect.height * fullHeight));
          const pixels = width * height;
          budget(
            Number.isSafeInteger(pixels) && pixels <= budgets.maxRenderedPixelsPerAsset,
            "rendered pixels per asset",
            pixels,
            budgets.maxRenderedPixelsPerAsset,
            request.pageIndex,
          );
          bitmap = module.FPDFBitmap_Create(width, height, 1);
          if (bitmap) {
            module.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
            module.FPDF_RenderPageBitmap(bitmap, page, -left, -top, fullWidth, fullHeight, 0, 0);
          }
        } else {
          throw new PdfImportError("pdf/asset-request-invalid", "Unknown PDF materialization request kind.");
        }
        if (!bitmap) throw new PdfImportError("pdf/engine-failure", "PDFium could not materialize a requested bitmap.");
        check(control, "after-bitmap");
        const decoded = bitmapToRgba(module, bitmap, budgets, request.pageIndex);
        const pixels = decoded.width * decoded.height;
        budget(
          Number.isSafeInteger(pixels) && pixels <= budgets.maxRenderedPixelsPerAsset,
          "rendered pixels per asset",
          pixels,
          budgets.maxRenderedPixelsPerAsset,
          request.pageIndex,
        );
        control.counters.renderedPixels += pixels;
        budget(
          control.counters.renderedPixels <= budgets.maxRenderedPixelsTotal,
          "rendered pixels total",
          control.counters.renderedPixels,
          budgets.maxRenderedPixelsTotal,
        );
        const bytes = encodeRgbaPng(decoded.width, decoded.height, decoded.rgba);
        budget(
          bytes.byteLength <= budgets.maxRenderedBytesPerAsset,
          "rendered bytes per asset",
          bytes.byteLength,
          budgets.maxRenderedBytesPerAsset,
          request.pageIndex,
        );
        control.counters.renderedBytes += bytes.byteLength;
        budget(
          control.counters.renderedBytes <= budgets.maxRenderedBytesTotal,
          "rendered bytes total",
          control.counters.renderedBytes,
          budgets.maxRenderedBytesTotal,
        );
        check(control, "after-render");
        assets.push({
          requestId: request.id,
          pageIndex: request.pageIndex,
          sourceKind: request.kind,
          mediaType: "image/png",
          width: decoded.width,
          height: decoded.height,
          bytes,
          sha256: await sha256Hex(bytes),
          materializerRevision: PDF_ASSET_MATERIALIZER_REVISION,
        });
        completed += 1;
        options.progress?.({
          phase: "request-complete",
          completed,
          total: requests.length,
          requestId: request.id,
        });
      } finally {
        if (bitmap) module.FPDFBitmap_Destroy(bitmap);
        module.FPDF_ClosePage(page);
      }
    }
    return assets;
  } catch (error) {
    throw sanitizedEngineError(error, control.stage);
  } finally {
    if (module && document) module.FPDF_CloseDocument(document);
    if (module && inputPointer) module.pdfium.wasmExports.free(inputPointer);
    if (module && initialized) module.FPDF_DestroyLibrary();
    options.progress?.({ phase: "cleanup", completed, total: requests.length });
  }
}

function createAdapter<TResult extends PdfAnalysisResultV1 | PdfAnalysisResultV2>(
  config: PdfiumAdapterTestConfig,
  analyzer: (
    data: Uint8Array,
    wasmBinary: Uint8Array,
    options: PdfAnalysisOptions,
    failAt?: PdfiumFailureStage,
  ) => Promise<TResult>,
) {
  const wasmBinary = new Uint8Array(config.wasmBinary);
  let active = false;
  return {
    analyze(data: Uint8Array, options: PdfAnalysisOptions = {}) {
      if (!(data instanceof Uint8Array)) {
        return Promise.reject(
          new PdfImportError("pdf/input-type-invalid", "PDF input must be supplied as Uint8Array bytes."),
        );
      }
      if (active) {
        return Promise.reject(
          new PdfImportError(
            "pdf/adapter-busy",
            "This PDFium adapter already owns an active document. Use a separate bounded worker.",
          ),
        );
      }
      active = true;
      const ownedData = new Uint8Array(data);
      return analyzer(ownedData, wasmBinary, options, config.failAt)
        .finally(() => {
          active = false;
        });
    },
    materialize(
      data: Uint8Array,
      requests: readonly PdfAssetMaterializationRequestV1[],
      options: PdfAssetMaterializationOptions = {},
    ) {
      if (!(data instanceof Uint8Array)) {
        return Promise.reject(
          new PdfImportError("pdf/input-type-invalid", "PDF input must be supplied as Uint8Array bytes."),
        );
      }
      if (active) {
        return Promise.reject(
          new PdfImportError(
            "pdf/adapter-busy",
            "This PDFium adapter already owns an active document. Use a separate bounded worker.",
          ),
        );
      }
      active = true;
      return materializePdfium(new Uint8Array(data), [...requests], wasmBinary, options, config.failAt)
        .finally(() => {
          active = false;
        });
    },
  };
}

export function createPdfiumFactsAdapter(config: PdfiumAdapterConfig): PdfiumFactsAdapter {
  return createAdapter(config, analyzePdfiumV1);
}

export function createPdfiumFactsAdapterV2(config: PdfiumAdapterConfig): PdfiumFactsAdapterV2 {
  return createAdapter(config, analyzePdfiumV2);
}

/** @internal Test-only lifecycle fault injection. */
export function createPdfiumFactsAdapterForTest(config: PdfiumAdapterTestConfig): PdfiumFactsAdapter {
  return createAdapter(config, analyzePdfiumV1);
}

/** @internal Test-only V2 lifecycle fault injection. */
export function createPdfiumFactsAdapterV2ForTest(
  config: PdfiumAdapterTestConfig,
): PdfiumFactsAdapterV2 {
  return createAdapter(config, analyzePdfiumV2);
}
