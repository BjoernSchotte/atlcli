/**
 * Full-document structure tree.
 *
 * Reads StructTreeRoot directly from the file (see pdf-objects.ts) so every
 * element has one identity across pages. Content references are reported as
 * (pageIndex, MCID) pairs; joining them with PDFium character facts is the
 * only way structure obtains text. The tree never carries body text itself.
 */
import type { PdfPageFactsV2 } from "./contracts.js";
import { PdfObjectReader, classifyMarkedContent, isRef, nameOf, pdfText, type MarkedContentKind, type PdfDict, type PdfValue } from "./pdf-objects.js";

export type DocStructKid =
  | { kind: "element"; element: DocStructElement }
  | { kind: "content"; pageIndex: number | null; mcid: number; inXObject: boolean }
  | { kind: "object"; pageIndex: number | null; objNum: number | null }
  | { kind: "invalid"; reason: "cycle" | "not-a-dictionary" | "depth-budget" | "element-budget" };

export interface DocStructElement {
  /** `obj:<num>` for indirect elements, else a structural path; never derived from text. */
  id: string;
  role: string;
  /** Role after RoleMap resolution; equals `role` when no mapping applies. */
  standardRole: string;
  title: string;
  alt: string;
  actualText: string;
  language: string;
  /** The element's /ID entry, used by table /Headers references. */
  elementId: string;
  attributes: { rowSpan?: number; colSpan?: number; scope?: string; headers?: string[] };
  kids: DocStructKid[];
}

export interface DocStructTree {
  pageCount: number;
  /** Per page: MCID -> what its marked content draws, from the content stream. */
  markedContent: Array<Map<number, MarkedContentKind>>;
  recoveredByScan: boolean;
  roots: DocStructElement[];
}

export interface DocStructTreeOptions {
  maxElements?: number;
  maxDepth?: number;
}

/** Returns null when the document has no StructTreeRoot. */
export function readDocStructTree(bytes: Uint8Array, options: DocStructTreeOptions = {}): DocStructTree | null {
  const reader = new PdfObjectReader(bytes);
  const catalog = reader.dict(reader.trailer.entries.get("Root"));
  if (!catalog) return null;
  const root = reader.dict(catalog.entries.get("StructTreeRoot"));
  if (!root) return null;

  const pageIndexByObj = new Map<number, number>();
  collectPages(reader, catalog.entries.get("Pages"), pageIndexByObj, new Set(), 0);
  const markedContent = [...pageIndexByObj.keys()].map((num) => {
    const page = reader.dict({ kind: "ref", num, gen: 0 });
    return page ? classifyMarkedContent(reader, page) : new Map<number, MarkedContentKind>();
  });

  const roleMap = reader.dict(root.entries.get("RoleMap"));
  const resolveRole = (role: string): string => {
    let current = role;
    const seen = new Set<string>();
    while (roleMap && !seen.has(current) && !STANDARD_ROLES.has(current)) {
      seen.add(current);
      const next = nameOf(reader.resolve(roleMap.entries.get(current)));
      if (!next) break;
      current = next;
    }
    return current;
  };

  const maxElements = options.maxElements ?? 200_000;
  const maxDepth = options.maxDepth ?? 128;
  let elementCount = 0;
  const visiting = new Set<number>();

  const pageOf = (v: PdfValue | undefined): number | null =>
    isRef(v) ? (pageIndexByObj.get(v.num) ?? null) : null;

  const element = (value: PdfValue, path: string, inheritedPage: number | null, depth: number): DocStructKid => {
    if (depth > maxDepth) return { kind: "invalid", reason: "depth-budget" };
    const objNum = isRef(value) ? value.num : null;
    if (objNum !== null && visiting.has(objNum)) return { kind: "invalid", reason: "cycle" };
    const dict = reader.dict(value);
    if (!dict) return { kind: "invalid", reason: "not-a-dictionary" };
    if (++elementCount > maxElements) return { kind: "invalid", reason: "element-budget" };
    if (objNum !== null) visiting.add(objNum);
    try {
      const role = nameOf(dict.entries.get("S")) ?? "";
      const page = pageOf(dict.entries.get("Pg")) ?? inheritedPage;
      const id = objNum !== null ? `obj:${objNum}` : path;
      const kids: DocStructKid[] = [];
      const rawKids = reader.resolve(dict.entries.get("K"));
      const list = rawKids === null ? [] : Array.isArray(rawKids) ? rawKids : [rawKids];
      // Keep the unresolved entry: a reference to a kid must be followed, not inlined.
      const original = dict.entries.get("K");
      const originals = Array.isArray(original) ? original : Array.isArray(rawKids) ? rawKids : [original ?? null];
      list.forEach((kid, i) => {
        const source = originals[i] ?? kid;
        kids.push(childKid(source, `${id}/${i}`, page, depth + 1));
      });
      return {
        kind: "element",
        element: {
          id,
          role,
          standardRole: resolveRole(role),
          title: pdfText(dict.entries.get("T")),
          alt: pdfText(dict.entries.get("Alt")),
          actualText: pdfText(dict.entries.get("ActualText")),
          language: pdfText(dict.entries.get("Lang")),
          elementId: pdfText(dict.entries.get("ID")),
          attributes: attributes(reader, dict),
          kids,
        },
      };
    } finally {
      if (objNum !== null) visiting.delete(objNum);
    }
  };

  const childKid = (value: PdfValue, path: string, page: number | null, depth: number): DocStructKid => {
    const resolved = reader.resolve(value);
    if (typeof resolved === "number") return { kind: "content", pageIndex: page, mcid: resolved, inXObject: false };
    const dict = reader.dict(value);
    if (!dict) return { kind: "invalid", reason: "not-a-dictionary" };
    const type = nameOf(dict.entries.get("Type"));
    if (type === "MCR" || (!dict.entries.has("S") && dict.entries.has("MCID"))) {
      const mcid = reader.resolve(dict.entries.get("MCID"));
      if (typeof mcid !== "number") return { kind: "invalid", reason: "not-a-dictionary" };
      return {
        kind: "content",
        pageIndex: pageOf(dict.entries.get("Pg")) ?? page,
        mcid,
        inXObject: dict.entries.has("Stm"),
      };
    }
    if (type === "OBJR") {
      const obj = dict.entries.get("Obj");
      return { kind: "object", pageIndex: pageOf(dict.entries.get("Pg")) ?? page, objNum: isRef(obj) ? obj.num : null };
    }
    return element(value, path, page, depth);
  };

  const rootKids = reader.resolve(root.entries.get("K"));
  const originalRootKids = root.entries.get("K");
  const rootList = rootKids === null ? [] : Array.isArray(rootKids) ? rootKids : [rootKids];
  const originals = Array.isArray(originalRootKids) ? originalRootKids : Array.isArray(rootKids) ? rootKids : [originalRootKids ?? null];
  const roots: DocStructElement[] = [];
  rootList.forEach((kid, i) => {
    const r = element(originals[i] ?? kid, `root/${i}`, null, 0);
    if (r.kind === "element") roots.push(r.element);
  });
  return { pageCount: pageIndexByObj.size, markedContent, recoveredByScan: reader.recoveredByScan, roots };
}

function collectPages(reader: PdfObjectReader, node: PdfValue | undefined, out: Map<number, number>, seen: Set<number>, depth: number): void {
  if (depth > 64 || !isRef(node) || seen.has(node.num)) return;
  seen.add(node.num);
  const dict = reader.dict(node);
  if (!dict) return;
  if (nameOf(dict.entries.get("Type")) === "Page" || !dict.entries.has("Kids")) {
    out.set(node.num, out.size);
    return;
  }
  const kids = reader.resolve(dict.entries.get("Kids"));
  if (Array.isArray(kids)) for (const kid of kids) collectPages(reader, kid, out, seen, depth + 1);
}

function attributes(reader: PdfObjectReader, dict: PdfDict): DocStructElement["attributes"] {
  const out: DocStructElement["attributes"] = {};
  const raw = reader.resolve(dict.entries.get("A"));
  const list = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    const a = reader.dict(item);
    if (!a) continue; // revision numbers interleave attribute objects
    const num = (k: string) => {
      const v = reader.resolve(a.entries.get(k));
      return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
    };
    out.rowSpan ??= num("RowSpan");
    out.colSpan ??= num("ColSpan");
    out.scope ??= nameOf(reader.resolve(a.entries.get("Scope"))) ?? undefined;
    const headers = reader.resolve(a.entries.get("Headers"));
    if (Array.isArray(headers) && !out.headers) out.headers = headers.map((h) => pdfText(reader.resolve(h)));
  }
  return out;
}

const STANDARD_ROLES = new Set([
  "Document", "DocumentFragment", "Part", "Art", "Sect", "Div", "BlockQuote", "Caption", "TOC", "TOCI", "Index",
  "NonStruct", "Private", "Aside", "Title", "FENote", "Sub", "P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "L", "LI",
  "Lbl", "LBody", "Table", "TR", "TH", "TD", "THead", "TBody", "TFoot", "Span", "Quote", "Note", "Reference", "BibEntry",
  "Code", "Link", "Annot", "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP", "Figure", "Formula", "Form", "Em", "Strong",
  "Artifact",
]);

// ---------------------------------------------------------------------------
// Correlation with PDFium facts (body-free metrics)
// ---------------------------------------------------------------------------

export interface DocStructCorrelation {
  elements: number;
  contentRefs: number;
  /** References that match at least one PDFium character, image or path on the referenced page. */
  resolvedRefs: number;
  /** References with no PDFium object whose marked content draws only spaces. */
  whitespaceRefs: number;
  /** References with no PDFium object whose marked content paints only via XObjects (figures). */
  xobjectPaintRefs: number;
  /** References with no PDFium object and no whitespace or XObject proof: potential loss. */
  unmatchedRefs: number;
  refsWithoutPage: number;
  xobjectRefs: number;
  /** (page, MCID) pairs referenced by more than one structure position. */
  duplicateRefs: number;
  invalidKids: number;
  charsWithMcid: number;
  /** Characters whose (page, MCID) is referenced exactly once by the tree. */
  charsOwned: number;
  /** Characters with an MCID the tree never references. */
  charsOrphaned: number;
  tables: DocStructTableSummary[];
}

export interface DocStructTableSummary {
  id: string;
  pageIndexes: number[];
  rows: number;
  headerRows: number;
  cells: number;
  emptyCells: number;
  spannedCells: number;
  /** Grid width after RowSpan/ColSpan occupancy. */
  columns: number;
  /** Rows narrower than the grid after occupancy (e.g. a producer omitted an empty cell element). */
  shortRows: number;
  /** Short rows whose cells could all be placed by their /Headers references. */
  shortRowsPlacedByHeaders: number;
  /** Every cell's content references resolve to PDFium objects or the cell is intentionally empty. */
  complete: boolean;
}

export function correlateDocStructTree(tree: DocStructTree, pages: ReadonlyArray<Pick<PdfPageFactsV2, "index" | "characters" | "images" | "paths">>): DocStructCorrelation {
  const objectMcids = new Map<number, Map<number, number>>(); // page -> mcid -> character count
  const otherMcids = new Map<number, Set<number>>();
  let charsWithMcid = 0;
  for (const page of pages) {
    const counts = new Map<number, number>();
    for (const c of page.characters) {
      if (c.mcid === null || c.mcid < 0) continue;
      charsWithMcid++;
      counts.set(c.mcid, (counts.get(c.mcid) ?? 0) + 1);
    }
    objectMcids.set(page.index, counts);
    const other = new Set<number>();
    for (const o of [...page.images, ...page.paths]) if (o.mcid !== null && o.mcid >= 0) other.add(o.mcid);
    otherMcids.set(page.index, other);
  }

  const refCount = new Map<string, number>();
  const result: DocStructCorrelation = {
    elements: 0, contentRefs: 0, resolvedRefs: 0, whitespaceRefs: 0, xobjectPaintRefs: 0, unmatchedRefs: 0, refsWithoutPage: 0, xobjectRefs: 0,
    duplicateRefs: 0, invalidKids: 0, charsWithMcid, charsOwned: 0, charsOrphaned: 0, tables: [],
  };
  const resolves = (pageIndex: number, mcid: number) =>
    (objectMcids.get(pageIndex)?.get(mcid) ?? 0) > 0 || (otherMcids.get(pageIndex)?.has(mcid) ?? false);
  const whitespace = (pageIndex: number, mcid: number) => tree.markedContent[pageIndex]?.get(mcid) === "whitespace";
  const accounted = (pageIndex: number, mcid: number) => resolves(pageIndex, mcid) || whitespace(pageIndex, mcid);

  const walk = (el: DocStructElement) => {
    result.elements++;
    if (el.standardRole === "Table") result.tables.push(summarizeTable(el, accounted));
    for (const kid of el.kids) {
      if (kid.kind === "element") walk(kid.element);
      else if (kid.kind === "invalid") result.invalidKids++;
      else if (kid.kind === "content") {
        result.contentRefs++;
        if (kid.inXObject) result.xobjectRefs++;
        if (kid.pageIndex === null) {
          result.refsWithoutPage++;
          continue;
        }
        const key = `${kid.pageIndex}:${kid.mcid}`;
        refCount.set(key, (refCount.get(key) ?? 0) + 1);
        if (resolves(kid.pageIndex, kid.mcid)) result.resolvedRefs++;
        else if (whitespace(kid.pageIndex, kid.mcid)) result.whitespaceRefs++;
        else if (tree.markedContent[kid.pageIndex]?.get(kid.mcid) === "xobject") result.xobjectPaintRefs++;
        else result.unmatchedRefs++;
      }
    }
  };
  tree.roots.forEach(walk);

  for (const n of refCount.values()) if (n > 1) result.duplicateRefs++;
  for (const [pageIndex, counts] of objectMcids) {
    for (const [mcid, n] of counts) {
      const refs = refCount.get(`${pageIndex}:${mcid}`) ?? 0;
      if (refs === 1) result.charsOwned += n;
      else if (refs === 0) result.charsOrphaned += n;
    }
  }
  return result;
}

function summarizeTable(table: DocStructElement, resolves: (page: number, mcid: number) => boolean): DocStructTableSummary {
  const rows: Array<{ header: boolean; cells: DocStructElement[] }> = [];
  const collectRows = (el: DocStructElement, header: boolean) => {
    for (const kid of el.kids) {
      if (kid.kind !== "element") continue;
      const r = kid.element.standardRole;
      if (r === "TR") rows.push({ header, cells: kid.element.kids.flatMap((k) => (k.kind === "element" && (k.element.standardRole === "TH" || k.element.standardRole === "TD") ? [k.element] : [])) });
      else if (r === "THead") collectRows(kid.element, true);
      else if (r === "TBody" || r === "TFoot") collectRows(kid.element, false);
    }
  };
  collectRows(table, false);

  // Lay cells onto a grid; a cell spanning rows occupies slots in later rows.
  const occupied: Array<Set<number>> = rows.map(() => new Set());
  const headerColumn = new Map<string, number>();
  const widths: number[] = [];
  rows.forEach((row, r) => {
    let col = 0;
    for (const cell of row.cells) {
      while (occupied[r].has(col)) col++;
      const cs = cell.attributes.colSpan ?? 1;
      const rs = cell.attributes.rowSpan ?? 1;
      if (cell.standardRole === "TH" && cell.elementId) headerColumn.set(cell.elementId, col);
      for (let dr = 0; dr < rs && r + dr < rows.length; dr++) for (let dc = 0; dc < cs; dc++) occupied[r + dr].add(col + dc);
      col += cs;
    }
    widths.push(occupied[r].size === 0 ? 0 : Math.max(...occupied[r]) + 1);
  });
  const columns = widths.length === 0 ? 0 : Math.max(...widths);

  let shortRows = 0;
  let shortRowsPlacedByHeaders = 0;
  rows.forEach((row, r) => {
    if (occupied[r].size >= columns) return;
    shortRows++;
    const placed = row.cells.map((c) => c.attributes.headers?.map((h) => headerColumn.get(h)).find((x) => x !== undefined));
    if (placed.every((x) => x !== undefined) && new Set(placed).size === placed.length) shortRowsPlacedByHeaders++;
  });

  const pages = new Set<number>();
  let cells = 0;
  let emptyCells = 0;
  let spannedCells = 0;
  let complete = true;
  for (const row of rows) {
    for (const cell of row.cells) {
      cells++;
      if ((cell.attributes.colSpan ?? 1) > 1 || (cell.attributes.rowSpan ?? 1) > 1) spannedCells++;
      const refs = contentRefs(cell);
      if (refs.length === 0) emptyCells++;
      for (const ref of refs) {
        if (ref.pageIndex !== null) pages.add(ref.pageIndex);
        if (ref.pageIndex === null || !resolves(ref.pageIndex, ref.mcid)) complete = false;
      }
      if (hasInvalid(cell)) complete = false;
    }
  }
  return {
    id: table.id,
    pageIndexes: [...pages].sort((a, b) => a - b),
    rows: rows.length,
    headerRows: rows.filter((r) => r.header || (r.cells.length > 0 && r.cells.every((c) => c.standardRole === "TH"))).length,
    cells,
    emptyCells,
    spannedCells,
    columns,
    shortRows,
    shortRowsPlacedByHeaders,
    complete,
  };
}

function contentRefs(el: DocStructElement): Array<{ pageIndex: number | null; mcid: number }> {
  const out: Array<{ pageIndex: number | null; mcid: number }> = [];
  for (const kid of el.kids) {
    if (kid.kind === "content") out.push(kid);
    else if (kid.kind === "element") out.push(...contentRefs(kid.element));
  }
  return out;
}

function hasInvalid(el: DocStructElement): boolean {
  return el.kids.some((k) => k.kind === "invalid" || (k.kind === "element" && hasInvalid(k.element)));
}

/**
 * PDFium character positions owned by an element, in structure order.
 *
 * Content references are followed in kid order; within one (page, MCID) the
 * PDFium character order is kept. The structure tree contributes order and
 * ownership only, so the result can never contain text PDFium did not read.
 */
export function elementCharacters(
  element: DocStructElement,
  pages: ReadonlyArray<Pick<PdfPageFactsV2, "index" | "characters">>,
): Array<{ pageIndex: number; index: number }> {
  const byMcid = new Map<string, number[]>();
  for (const page of pages) {
    for (const c of page.characters) {
      if (c.mcid === null || c.mcid < 0) continue;
      const key = `${page.index}:${c.mcid}`;
      const list = byMcid.get(key);
      if (list) list.push(c.index);
      else byMcid.set(key, [c.index]);
    }
  }
  const out: Array<{ pageIndex: number; index: number }> = [];
  for (const ref of contentRefs(element)) {
    if (ref.pageIndex === null) continue;
    for (const index of byMcid.get(`${ref.pageIndex}:${ref.mcid}`) ?? []) out.push({ pageIndex: ref.pageIndex, index });
  }
  return out;
}
