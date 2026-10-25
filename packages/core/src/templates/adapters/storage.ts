/**
 * Confluence storage XHTML. A small offset tokenizer instead of a DOM: output
 * is printed from the original string, so every token rendering leaves alone
 * keeps its exact bytes (entities, attribute order, whitespace, CDATA). Only a
 * text token whose text changed is re-serialized.
 *
 * Skipped: code/pre, plain-text macro bodies, code/noformat macros. Inline
 * formatting (strong, em, span, …) is part of a text run; any other element
 * (links, images, macros) is a run boundary.
 */
import { finish, RenderBudget, renderSegments, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";
import type { AdfContext } from "./adf.js";
import { controlOf, droppedContent, expandBlock, structure, type Control, type Item } from "./adf-blocks.js";
import { distribute, withoutPosition } from "./runs.js";

interface Text {
  kind: "text";
  start: number;
  end: number;
  decoded: string;
}
interface Opaque {
  kind: "opaque"; // CDATA, comments
  start: number;
  end: number;
}
interface El {
  kind: "el";
  name: string;
  attrs: Record<string, string>;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  children: Node[];
}
type Node = Text | Opaque | El;
type Ctx = AdfContext;

const TOKEN = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\/?[A-Za-z][\w:.-]*(?:\s[^>]*)?\/?>|[^<]+|</g;
const INLINE = new Set(["strong", "b", "em", "i", "u", "s", "del", "span", "sub", "sup", "small", "big", "font", "a"]);
const SKIP = new Set(["ac:plain-text-body", "code", "pre"]);
const VOID = new Set(["br", "hr", "img", "col"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Brackets an entity the decoder does not know (`&hellip;`), so re-encoding puts it back as it was. */
const KEEP_OPEN = "";
const KEEP_CLOSE = "";

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? `${KEEP_OPEN}${e}${KEEP_CLOSE}`;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Escapes every `&`, `<`, `>` (values included), then restores the entities the decoder kept. */
export const encodeText = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;")
    .replace(new RegExp(`${KEEP_OPEN}([a-z][a-z0-9]*)${KEEP_CLOSE}`, "gi"), "&$1;");

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/\s([\w:.-]+)="([^"]*)"/g)) attrs[m[1]!] = m[2]!;
  return attrs;
}

function parseTree(source: string): El | undefined {
  const root: El = { kind: "el", name: "#root", attrs: {}, start: 0, openEnd: 0, closeStart: source.length, end: source.length, children: [] };
  const stack: El[] = [root];
  for (const m of source.matchAll(TOKEN)) {
    const token = m[0];
    const start = m.index!;
    const end = start + token.length;
    const top = stack.at(-1)!;
    if (token.startsWith("<![CDATA[") || token.startsWith("<!--")) {
      top.children.push({ kind: "opaque", start, end });
    } else if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim();
      if (top.name !== name) return undefined;
      top.closeStart = start;
      top.end = end;
      stack.pop();
    } else if (token.length > 1 && token[0] === "<") {
      const name = /^<([\w:.-]+)/.exec(token)![1]!;
      const el: El = { kind: "el", name, attrs: parseAttrs(token), start, openEnd: end, closeStart: end, end, children: [] };
      top.children.push(el);
      if (!token.endsWith("/>") && !VOID.has(name.toLowerCase())) stack.push(el);
    } else {
      top.children.push({ kind: "text", start, end, decoded: decodeEntities(token) });
    }
  }
  return stack.length === 1 ? root : undefined;
}

const skipped = (el: El) => SKIP.has(el.name) || (el.name === "ac:structured-macro" && /^(code|noformat)$/.test(el.attrs["ac:name"] ?? ""));
const inRun = (el: El) => INLINE.has(el.name) && !skipped(el);
const blank = (n: Node) => n.kind === "text" && n.decoded.trim() === "";

/** Text runs of a node list: through inline elements, split at every other element. */
function runsOf(nodes: Node[]): Array<{ texts: Text[]; boundaryAfter: boolean }> {
  const runs: Array<{ texts: Text[]; boundaryAfter: boolean }> = [];
  let current: Text[] = [];
  const close = (boundary: boolean) => {
    if (current.length) runs.push({ texts: current, boundaryAfter: boundary });
    current = [];
  };
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.kind === "text") current.push(n);
      else if (n.kind === "el" && inRun(n)) walk(n.children);
      else close(true);
    }
  };
  walk(nodes);
  close(false);
  return runs;
}

/** Text of a p (or li/td) that holds only text; the shape a control paragraph has. */
function textOnly(el: El | undefined): string | undefined {
  if (!el || el.children.length === 0 || !el.children.every((c) => c.kind === "text")) return undefined;
  return (el.children as Text[]).map((t) => t.decoded).join("");
}
const onlyChild = (el: El) => {
  const kids = el.children.filter((c) => !blank(c));
  return kids.length === 1 && kids[0]!.kind === "el" ? (kids[0] as El) : undefined;
};

/** Text of a cell, with other elements as `[name]`, so a non-empty cell never reads as empty. */
const plainText = (n: Node): string =>
  n.kind === "text"
    ? n.decoded
    : n.kind === "opaque"
      ? ""
      : ["td", "th", "p", "br"].includes(n.name) || inRun(n)
        ? n.children.map(plainText).join("")
        : `[${n.name}]`;

function controlFor(n: Node): Control | undefined {
  if (n.kind !== "el") return undefined;
  let text: string | undefined;
  if (n.name === "p") text = textOnly(n);
  else if (n.name === "li") text = textOnly(n) ?? (onlyChild(n)?.name === "p" ? textOnly(onlyChild(n)) : undefined);
  else if (n.name === "tr") {
    const cell = n.children.find((c): c is El => c.kind === "el");
    if (cell && (cell.name === "td" || cell.name === "th")) {
      text = textOnly(cell) ?? (onlyChild(cell)?.name === "p" ? textOnly(onlyChild(cell)) : undefined);
    }
  }
  return text === undefined ? undefined : controlOf(text);
}

export function renderStorage(storage: string, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] } {
  if (!storage.includes("{{")) return { value: storage, warnings: [] };
  const root = parseTree(storage);
  if (!root) {
    return finish(storage, [{ code: "parse-error", message: `${opts.unit}: storage could not be tokenized; left as is`, unit: opts.unit }], opts);
  }
  const ctx: Ctx = { scope, opts: { ...opts, strict: false, budget: opts.budget ?? new RenderBudget() }, warnings: [] };
  const raw = (n: Node) => storage.slice(n.start, n.end);

  const printEl = (el: El, c: Ctx): string => {
    if (skipped(el) || el.openEnd === el.end || !storage.slice(el.start, el.end).includes("{{")) return raw(el);
    return storage.slice(el.start, el.openEnd) + printChildren(el.children, c) + storage.slice(el.closeStart, el.end);
  };

  /** A sibling list: control blocks first, then text runs. */
  const printChildren = (nodes: Node[], c: Ctx): string => {
    if (!nodes.some(controlFor)) return printList(nodes, c);
    const items = structure(nodes, controlFor);
    if (!items) {
      c.warnings.push({ code: "unbalanced-block", message: `${c.opts.unit}: {{#…}} control paragraphs don't pair up; left as is`, unit: c.opts.unit });
      return nodes.map((n) => (controlFor(n) ? raw(n) : printList([n], c))).join("");
    }
    for (const n of nodes) {
      if (n.kind !== "el" || n.name !== "tr" || !controlFor(n)) continue;
      const lost = n.children.filter((k): k is El => k.kind === "el").slice(1).map(plainText).join(" ").trim();
      if (lost) droppedContent(c, lost);
    }
    const emit = (list: Item<Node>[], cc: Ctx): string[] => {
      const out: string[] = [];
      let plain: Node[] = [];
      const flush = () => {
        if (plain.length) out.push(printList(plain, cc));
        plain = [];
      };
      for (const item of list) {
        if ("node" in item) plain.push(item.node);
        else {
          flush();
          out.push(...expandBlock(item.block, cc, emit));
        }
      }
      flush();
      return out;
    };
    return emit(items, c).join("");
  };

  /** Prints nodes, rendering each text run that holds a placeholder. */
  const printList = (nodes: Node[], c: Ctx): string => {
    const replaced = new Map<Text, string>();
    for (const run of runsOf(nodes)) {
      const pieces = run.texts.map((t) => t.decoded);
      const joined = pieces.join("");
      if (!joined.includes("{{")) continue;
      if (run.boundaryAfter && (joined.match(/\{\{/g)?.length ?? 0) > (joined.match(/\}\}/g)?.length ?? 0)) {
        c.warnings.push({ code: "crosses-inline-node", message: `${c.opts.unit}: an expression runs into a link, image or macro; left as is`, unit: c.opts.unit });
        continue;
      }
      const { segments, warnings } = renderSegments(joined, c.scope, c.opts);
      c.warnings.push(...warnings.map(withoutPosition));
      distribute(pieces, segments).forEach((text, i) => {
        if (text !== pieces[i]) replaced.set(run.texts[i]!, encodeText(text));
      });
    }
    const print = (n: Node): string => {
      if (n.kind === "text") return replaced.get(n) ?? raw(n);
      if (n.kind === "opaque") return raw(n);
      if (inRun(n)) return storage.slice(n.start, n.openEnd) + n.children.map(print).join("") + storage.slice(n.closeStart, n.end);
      return printEl(n, c);
    };
    return nodes.map(print).join("");
  };

  const value = printChildren(root.children, ctx);
  return finish(value, ctx.warnings, opts);
}

/** Decoded text runs a template author wrote (skipping code), for variable collection. */
export function storageTextUnits(storage: string): string[] {
  const root = parseTree(storage);
  if (!root) return [];
  const units: string[] = [];
  const visit = (nodes: Node[]) => {
    for (const run of runsOf(nodes)) {
      const text = run.texts.map((t) => t.decoded).join("");
      if (text.trim()) units.push(text);
    }
    for (const n of nodes) {
      if (n.kind !== "el" || skipped(n)) continue;
      if (inRun(n)) visit(n.children.filter((c) => c.kind === "el"));
      else visit(n.children);
    }
  };
  visit(root.children);
  return units;
}
