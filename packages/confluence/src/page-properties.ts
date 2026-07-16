/**
 * Page Properties macro extraction (spec 001 mapping gap **G4**).
 *
 * Confluence's "Page Properties" macro is `ac:name="details"` and lives in the
 * page's OWN storage — there is no side API for it. It wraps a two-column table
 * whose first cell is the label and whose second is the value:
 *
 * ```xml
 * <ac:structured-macro ac:name="details">
 *   <ac:parameter ac:name="id">specs</ac:parameter>
 *   <ac:rich-text-body>
 *     <table><tbody>
 *       <tr><th>Status</th><td>Approved</td></tr>
 *     </tbody></table>
 *   </ac:rich-text-body>
 * </ac:structured-macro>
 * ```
 *
 * This module turns that into label→value maps so `$scroll.pageproperty.(key)`
 * can resolve. It is a Confluence storage-format concern (like
 * `export-blocks.ts`), not a DOCX one — the DOCX resolver merely consumes it,
 * and the CLI could too.
 *
 * Isomorphic: no host globals, built on the shared {@link parseXml} tree rather
 * than a regex, because a details macro can legitimately contain other macros
 * and a non-greedy `</ac:structured-macro>` match would slice the wrong one.
 */
import { parseXml, type XmlElement, type XmlNode } from "./export-blocks.js";

/** One Page Properties macro instance on a page. */
export interface PagePropertiesMacro {
  /**
   * The macro's `id` PARAMETER — the human-set "Page Properties ID" an author
   * types in the macro dialog (e.g. `zoo-meta`). This is what a template means
   * by "macro id", since the alternative is a UUID nobody would hand-write.
   */
  id?: string;
  /**
   * The `ac:macro-id` ATTRIBUTE Confluence assigns automatically (a UUID).
   * Kept because real storage carries both and Scroll's docs say only
   * "macro-id"; matching either costs nothing and a UUID cannot collide with a
   * hand-written label.
   */
  macroId?: string;
  /** Label → value, in document order. Labels keep their original casing. */
  rows: Map<string, string>;
}

function isElement(node: XmlNode): node is XmlElement {
  return node.type === "element";
}

function tag(node: XmlNode): string {
  return isElement(node) ? node.name.toLowerCase() : "";
}

/** Flatten an element's text, collapsing whitespace (values are plain text). */
function textOf(node: XmlNode): string {
  if (node.type === "text") return node.text;
  return node.children.map(textOf).join("");
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Depth-first walk yielding every element. */
function* elements(nodes: XmlNode[]): Generator<XmlElement> {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    yield node;
    yield* elements(node.children);
  }
}

/** Read `<ac:parameter ac:name="id">value</ac:parameter>` from a macro's children. */
function macroId(macro: XmlElement): string | undefined {
  for (const child of macro.children) {
    if (!isElement(child)) continue;
    if (child.name.toLowerCase() !== "ac:parameter") continue;
    if ((child.attrs["ac:name"] ?? "").toLowerCase() !== "id") continue;
    const value = normalize(textOf(child));
    return value === "" ? undefined : value;
  }
  return undefined;
}

/**
 * Collect the label→value rows of a details macro.
 *
 * Confluence writes the label as `<th>` in the modern editor and as `<td>` in
 * older content, so the FIRST cell is the label whatever its tag; the remaining
 * cells join as the value. Rows with fewer than two cells carry no property and
 * are skipped rather than yielding an empty-keyed entry.
 */
function macroRows(macro: XmlElement): Map<string, string> {
  const rows = new Map<string, string>();
  for (const el of elements(macro.children)) {
    if (tag(el) !== "tr") continue;
    const cells = el.children.filter(
      (c): c is XmlElement => isElement(c) && (tag(c) === "td" || tag(c) === "th")
    );
    if (cells.length < 2) continue;
    const label = normalize(textOf(cells[0]));
    if (label === "") continue;
    const value = normalize(cells.slice(1).map(textOf).join(" "));
    // First occurrence wins — a duplicated label is a page-authoring mistake and
    // silently overwriting it would make the export depend on row order.
    if (!rows.has(label)) rows.set(label, value);
  }
  return rows;
}

/**
 * Parse every Page Properties macro out of a page's storage, in document order.
 *
 * Nested macros are handled correctly: the tree walk finds a `details` macro
 * wherever it sits, including inside a layout section or another macro's body.
 */
export function parsePageProperties(storage: string): PagePropertiesMacro[] {
  if (!storage || !storage.includes("details")) return [];
  const out: PagePropertiesMacro[] = [];
  for (const el of elements(parseXml(storage))) {
    if (el.name.toLowerCase() !== "ac:structured-macro") continue;
    if ((el.attrs["ac:name"] ?? "").toLowerCase() !== "details") continue;
    out.push({
      id: macroId(el),
      macroId: el.attrs["ac:macro-id"] || undefined,
      rows: macroRows(el),
    });
  }
  return out;
}

/**
 * Look a property up across the given macros.
 *
 * @param macros - parsed macros, in document order.
 * @param key - the property label, matched case-insensitively (Scroll templates
 *   are authored by hand and rarely match the page's casing exactly).
 * @param id - when given, scopes the lookup to the macro carrying that id —
 *   matched against the `id` parameter OR the `ac:macro-id` attribute, because
 *   Scroll's docs say only "macro-id" and real storage carries both.
 * @returns the value, or `undefined` when absent (caller decides the fallback).
 */
export function lookupPageProperty(
  macros: PagePropertiesMacro[],
  key: string,
  id?: string
): string | undefined {
  const wanted = key.trim().toLowerCase();
  if (wanted === "") return undefined;
  const scope = id ? macros.filter((m) => m.id === id || m.macroId === id) : macros;
  for (const macro of scope) {
    for (const [label, value] of macro.rows) {
      if (label.toLowerCase() === wanted) return value;
    }
  }
  return undefined;
}
