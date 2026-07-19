/**
 * Named-macro body extraction from storage XML (spec 004, E4/E5 shared helper).
 *
 * `extractMacroBody(storage, macroNames, name)` finds the definition-side macro
 * (`multiexcerpt-macro`/`multiexcerpt`, `excerpt`, …) carrying the given name
 * and returns its `<ac:rich-text-body>` inner content re-serialized as a
 * storage fragment, ready for `storageToBlocks`. Storage-based (not
 * walked-blocks-based) because the walker renders definition macros
 * transparently — their body blocks are indistinguishable from surrounding
 * content once walked.
 *
 * Reuses the {@link parseXml} tokenizer — never regex-parses markup (a
 * non-greedy close-tag regex mis-slices nested macros; see `parseXml` docs).
 * Isomorphic; exported from both barrels.
 */
import { parseXml, type XmlElement, type XmlNode } from "./export-blocks.js";

function isElement(node: XmlNode): node is XmlElement {
  return node.type === "element";
}

function textOf(node: XmlNode): string {
  if (node.type === "text") return node.text;
  return node.children.map(textOf).join("");
}

/**
 * Read the macro's declared excerpt name: `MultiExcerptName` (Appfire Cloud),
 * `name` (Appfire Server / Confluence excerpt), or the unnamed first parameter.
 */
function declaredName(macro: XmlElement): string {
  const byName = new Map<string, string>();
  for (const child of macro.children) {
    if (!isElement(child) || child.name !== "ac:parameter") continue;
    const pname = (child.attrs["ac:name"] ?? "").toLowerCase();
    if (!byName.has(pname)) byName.set(pname, textOf(child).trim());
  }
  return byName.get("multiexcerptname") || byName.get("name") || byName.get("") || "";
}

function findMacro(
  nodes: XmlNode[],
  want: readonly string[],
  wantedName: string
): XmlElement | undefined {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    if (node.name === "ac:structured-macro" || node.name === "ac:macro") {
      const macroName = (node.attrs["ac:name"] ?? "").toLowerCase();
      if (want.includes(macroName)) {
        if (wantedName === "" || declaredName(node).toLowerCase() === wantedName) return node;
      }
    }
    const inner = findMacro(node.children, want, wantedName);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * Find the named definition macro in `storage` and return its rich-text body as
 * a storage fragment (`undefined` when no matching macro/body exists). An empty
 * `name` matches the first macro of the given kind (Confluence's plain
 * `excerpt` macro is unnamed).
 */
export function extractMacroBody(
  storage: string,
  macroNames: readonly string[],
  name: string
): string | undefined {
  if (!storage) return undefined;
  const want = macroNames.map((n) => n.toLowerCase());
  const match = findMacro(parseXml(storage), want, name.trim().toLowerCase());
  if (!match) return undefined;
  const body = match.children.find(
    (c): c is XmlElement => isElement(c) && c.name === "ac:rich-text-body"
  );
  if (!body) return undefined;
  const fragment = body.children.map(serializeNode).join("");
  return fragment === "" ? undefined : fragment;
}

// ---- Minimal XML re-serializer (round-trips through parseXml) --------------

function serializeNode(node: XmlNode): string {
  if (node.type === "text") return escapeText(node.text);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  if (node.children.length === 0) return `<${node.name}${attrs}/>`;
  return `<${node.name}${attrs}>${node.children.map(serializeNode).join("")}</${node.name}>`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
