/**
 * Pure comparison primitives for the shape-parity gate (spec 011, T4.x).
 *
 * These functions take already-materialized bytes / report projections from the
 * browser harness run and the Bun/CLI run and decide whether the two engines
 * produced equivalent output. They are deliberately free of IO so
 * `check-parity.test.ts` can exercise every branch on real zip/PNG bytes from
 * `@atlcli/docx/fixtures` — no mocks.
 *
 * Equivalence, per the PLAN:
 *  - PDF: byte-identical (same wasm, same pinned fonts, deterministic clock).
 *  - DOCX: identical part list + identical bytes per part, EXCEPT rasterized
 *    media parts (`word/media/*.png`) which compare by decoded pixel content —
 *    nonblank, alpha-channel presence, content-bounds, and a bounded perceptual
 *    difference — never format/dimensions alone.
 *  - Reports: a canonical projection (code, severity, phase, count) compares
 *    exactly; timing and host-specific free text are excluded.
 */
import { createHash } from "node:crypto";
import { decodePng } from "./png-codec.js";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A per-part sha256 map for a DOCX package (or any part-addressed archive). */
export type PartDigestMap = Record<string, string>;

export function digestParts(parts: Record<string, Uint8Array>): PartDigestMap {
  const map: PartDigestMap = {};
  for (const [name, bytes] of Object.entries(parts)) map[name] = sha256Hex(bytes);
  return map;
}

const MEDIA_PART = /^word\/media\/.*\.png$/i;

export function isRasterMediaPart(name: string): boolean {
  return MEDIA_PART.test(name);
}

// --- report projection ------------------------------------------------------

export interface ProjectedNote {
  code: string;
  severity: string;
  phase: string;
}

export interface ReportProjection {
  /** code|severity|phase -> occurrence count, canonically sorted at compare time. */
  counts: Record<string, number>;
}

function noteKey(note: ProjectedNote): string {
  return `${note.code}|${note.severity}|${note.phase}`;
}

/**
 * Canonicalize a set of notes to codes+severity+phase counts, dropping timing
 * and host-specific free text. `level` (docx) and `severity` (report kernel) are
 * both accepted; `phase` defaults to "" when a note carries none.
 */
/** The shape of any engine note the projection reads (extra fields ignored). */
export interface ProjectableNote {
  code: string;
  severity?: string;
  level?: string;
  phase?: string;
  [key: string]: unknown;
}

export function projectNotes(notes: ReadonlyArray<ProjectableNote>): ReportProjection {
  const counts: Record<string, number> = {};
  for (const note of notes) {
    const key = noteKey({
      code: note.code,
      severity: note.severity ?? note.level ?? "info",
      phase: note.phase ?? "",
    });
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { counts };
}

export function compareReportProjection(browser: ReportProjection, cli: ReportProjection): string[] {
  const failures: string[] = [];
  const keys = new Set([...Object.keys(browser.counts), ...Object.keys(cli.counts)]);
  for (const key of [...keys].sort()) {
    const b = browser.counts[key] ?? 0;
    const c = cli.counts[key] ?? 0;
    if (b !== c) failures.push(`report note ${key}: browser ${b} vs cli ${c}`);
  }
  return failures;
}

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Compare deterministic JSON-compatible contract projections and name the
 * first divergent JSON pointer. This is intentionally stricter than digest
 * parity: a changed stage, disabled reason, section count, or preview freshness
 * must identify the semantic field that drifted.
 */
export function compareStructuredParity(
  browser: unknown,
  cli: unknown
): string[] {
  const compare = (left: unknown, right: unknown, pointer: string): string | undefined => {
    if (Object.is(left, right)) return undefined;
    if (
      left === null ||
      right === null ||
      typeof left !== "object" ||
      typeof right !== "object"
    ) {
      return `${pointer || "/"} differs (browser ${JSON.stringify(
        left
      )} vs cli ${JSON.stringify(right)})`;
    }
    const leftArray = Array.isArray(left);
    const rightArray = Array.isArray(right);
    if (leftArray !== rightArray) {
      return `${pointer || "/"} differs (browser ${
        leftArray ? "array" : "object"
      } vs cli ${rightArray ? "array" : "object"})`;
    }
    if (leftArray && rightArray) {
      if (left.length !== right.length) {
        return `${pointer || "/"} length differs (browser ${left.length} vs cli ${right.length})`;
      }
      for (let index = 0; index < left.length; index += 1) {
        const failure = compare(
          left[index],
          right[index],
          `${pointer}/${index}`
        );
        if (failure) return failure;
      }
      return undefined;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [
      ...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]),
    ].sort();
    for (const key of keys) {
      const nextPointer = `${pointer}/${escapeJsonPointerToken(key)}`;
      if (!(key in leftRecord)) return `${nextPointer} is missing in browser`;
      if (!(key in rightRecord)) return `${nextPointer} is missing in cli`;
      const failure = compare(
        leftRecord[key],
        rightRecord[key],
        nextPointer
      );
      if (failure) return failure;
    }
    return undefined;
  };
  const failure = compare(browser, cli, "");
  return failure ? [failure] : [];
}

// --- raster content metric --------------------------------------------------

export interface RasterCheckOptions {
  /** Max mean per-channel difference (0..1) two images may differ by. */
  perceptualTolerance?: number;
  /** Min intersection-over-union of content bounding boxes. */
  minBoundsIou?: number;
}

export interface RasterCheckResult {
  ok: boolean;
  reasons: string[];
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  populated: boolean;
}

/** Bounding box of pixels that are not fully transparent AND not the background. */
function contentBounds(width: number, height: number, rgba: Uint8Array): Bounds {
  // Background sample = top-left pixel; a "content" pixel differs from it or is
  // non-transparent. This flags a blank (all one colour) image as unpopulated.
  const bg = [rgba[0], rgba[1], rgba[2], rgba[3]];
  const bounds: Bounds = { minX: width, minY: height, maxX: -1, maxY: -1, populated: false };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const transparent = rgba[i + 3] === 0;
      const sameAsBg =
        rgba[i] === bg[0] && rgba[i + 1] === bg[1] && rgba[i + 2] === bg[2] && rgba[i + 3] === bg[3];
      if (transparent || sameAsBg) continue;
      bounds.populated = true;
      if (x < bounds.minX) bounds.minX = x;
      if (y < bounds.minY) bounds.minY = y;
      if (x > bounds.maxX) bounds.maxX = x;
      if (y > bounds.maxY) bounds.maxY = y;
    }
  }
  return bounds;
}

function boundsIou(a: Bounds, b: Bounds): number {
  if (!a.populated || !b.populated) return 0;
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1);
  const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1);
  const inter = ix * iy;
  const areaA = (a.maxX - a.minX + 1) * (a.maxY - a.minY + 1);
  const areaB = (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

function isBlank(width: number, height: number, rgba: Uint8Array): boolean {
  // Blank = every pixel identical (covers all-transparent and all-one-colour).
  for (let i = 4; i < rgba.length; i += 4) {
    if (
      rgba[i] !== rgba[0] ||
      rgba[i + 1] !== rgba[1] ||
      rgba[i + 2] !== rgba[2] ||
      rgba[i + 3] !== rgba[3]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Compare two rasterized media parts by decoded pixel CONTENT. A same-size blank
 * or mis-cropped image must fail — dimensions/format equality is never enough.
 */
export function compareRasterMedia(
  browserPng: Uint8Array,
  cliPng: Uint8Array,
  options: RasterCheckOptions = {},
): RasterCheckResult {
  const tolerance = options.perceptualTolerance ?? 0.05;
  const minIou = options.minBoundsIou ?? 0.9;
  const reasons: string[] = [];

  const a = decodePng(browserPng);
  const b = decodePng(cliPng);

  if (!a.hasAlpha || !b.hasAlpha) {
    reasons.push(`alpha channel missing (browser=${a.hasAlpha}, cli=${b.hasAlpha})`);
  }
  if (isBlank(a.width, a.height, a.rgba)) reasons.push("browser image is blank (uniform pixels)");
  if (isBlank(b.width, b.height, b.rgba)) reasons.push("cli image is blank (uniform pixels)");

  const boundsA = contentBounds(a.width, a.height, a.rgba);
  const boundsB = contentBounds(b.width, b.height, b.rgba);
  if (!boundsA.populated) reasons.push("browser image has no content region");
  if (!boundsB.populated) reasons.push("cli image has no content region");

  if (a.width === b.width && a.height === b.height) {
    const iou = boundsIou(boundsA, boundsB);
    if (boundsA.populated && boundsB.populated && iou < minIou) {
      reasons.push(`content bounds diverge (IoU ${iou.toFixed(3)} < ${minIou}) — cropped or shifted`);
    }
    // Perceptual mean-abs-diff over the shared grid.
    let sum = 0;
    for (let i = 0; i < a.rgba.length; i++) sum += Math.abs(a.rgba[i] - b.rgba[i]);
    const mad = sum / a.rgba.length / 255;
    if (mad > tolerance) {
      reasons.push(`perceptual difference ${mad.toFixed(4)} > tolerance ${tolerance}`);
    }
  } else {
    reasons.push(`dimensions differ (${a.width}x${a.height} vs ${b.width}x${b.height})`);
  }

  return { ok: reasons.length === 0, reasons };
}

// --- digest-map comparison --------------------------------------------------

export interface DocxParityInput {
  parts: Record<string, Uint8Array>;
  notes: ReadonlyArray<ProjectableNote>;
}

export interface ParityFailure {
  case: string;
  detail: string;
}

/**
 * Compare a DOCX package produced by the browser vs the CLI. Non-media parts and
 * relationships/naming compare by exact byte digest; `word/media/*.png` parts
 * compare by raster content. The FIRST divergent part or report code is named.
 */
export function compareDocxParity(
  caseId: string,
  browser: DocxParityInput,
  cli: DocxParityInput,
  rasterOptions?: RasterCheckOptions,
): ParityFailure[] {
  const failures: ParityFailure[] = [];
  const push = (detail: string) => failures.push({ case: caseId, detail });

  const browserNames = Object.keys(browser.parts).sort();
  const cliNames = Object.keys(cli.parts).sort();
  const nameSet = new Set([...browserNames, ...cliNames]);
  for (const name of [...nameSet].sort()) {
    const inBrowser = name in browser.parts;
    const inCli = name in cli.parts;
    if (inBrowser !== inCli) {
      push(`part list mismatch: "${name}" present in ${inBrowser ? "browser" : "cli"} only`);
      continue;
    }
    if (isRasterMediaPart(name)) {
      const raster = compareRasterMedia(browser.parts[name], cli.parts[name], rasterOptions);
      if (!raster.ok) push(`raster media part "${name}": ${raster.reasons.join("; ")}`);
    } else {
      const bd = sha256Hex(browser.parts[name]);
      const cd = sha256Hex(cli.parts[name]);
      if (bd !== cd) push(`part "${name}" bytes differ (browser ${bd.slice(0, 12)} vs cli ${cd.slice(0, 12)})`);
    }
  }

  for (const detail of compareReportProjection(projectNotes(browser.notes), projectNotes(cli.notes))) {
    push(detail);
  }
  return failures;
}

/** Compare a PDF produced by the browser vs the CLI: byte-identical + report. */
export function comparePdfParity(
  caseId: string,
  browser: { bytes: Uint8Array; compilerVersion: string; notes: DocxParityInput["notes"] },
  cli: { bytes: Uint8Array; compilerVersion: string; notes: DocxParityInput["notes"] },
): ParityFailure[] {
  const failures: ParityFailure[] = [];
  const push = (detail: string) => failures.push({ case: caseId, detail });
  if (browser.compilerVersion !== cli.compilerVersion) {
    // Fail loudly on version skew rather than producing a confusing byte diff.
    push(`compiler version mismatch: browser ${browser.compilerVersion} vs cli ${cli.compilerVersion}`);
    return failures;
  }
  const bd = sha256Hex(browser.bytes);
  const cd = sha256Hex(cli.bytes);
  if (bd !== cd) push(`PDF bytes differ (browser ${bd.slice(0, 16)} vs cli ${cd.slice(0, 16)})`);
  for (const detail of compareReportProjection(projectNotes(browser.notes), projectNotes(cli.notes))) {
    push(detail);
  }
  return failures;
}
