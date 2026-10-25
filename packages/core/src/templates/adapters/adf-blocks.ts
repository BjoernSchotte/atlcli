/**
 * Control paragraphs: a paragraph whose whole text is a Jinja block tag
 * (`{% if … %}`, `{% elif … %}`, `{% else %}`, `{% endif %}`,
 * `{% for x in … %}`, `{% endfor %}`) controls its sibling blocks, so a
 * template can repeat or drop paragraphs, list items and table rows. Control
 * nodes are removed from the output. Blocks that don't pair stay as they are.
 */
import { childScope, evaluateExpression } from "../render.js";
import type { AdfContext, AdfNode } from "./adf.js";

export type BlockName = "if" | "for";

export type Control =
  | { kind: "open"; name: "if"; expr: string }
  | { kind: "open"; name: "for"; expr: string; names: string[] }
  | { kind: "elif"; expr: string }
  | { kind: "else" }
  | { kind: "close"; name: BlockName };

/** A whole-paragraph block tag; the expression may not contain `%}` (so `{% if a %}x{% endif %}` is text). */
export const CONTROL = /^\{%-?\s*(?:(if|elif)\s+((?:(?!%\}).)+?)|for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)?)\s+in\s+((?:(?!%\}).)+?)|(else)|end(if|for))\s*-?%\}$/;

export function controlOf(text: string): Control | undefined {
  const m = CONTROL.exec(text.trim());
  if (!m) return undefined;
  if (m[1] === "if") return { kind: "open", name: "if", expr: m[2]!.trim() };
  if (m[1] === "elif") return { kind: "elif", expr: m[2]!.trim() };
  if (m[3]) return { kind: "open", name: "for", expr: m[4]!.trim(), names: m[3].split(",").map((n) => n.trim()) };
  if (m[5]) return { kind: "else" };
  return { kind: "close", name: m[6] as BlockName };
}

/** A pairing of controls over a sibling list: plain items and blocks. */
export interface Block<N> {
  control: Extract<Control, { kind: "open" }>;
  then: Item<N>[];
  otherwise: Item<N>[];
}
export type Item<N> = { node: N } | { block: Block<N> };

/**
 * Pairs controls into blocks; undefined when they don't pair (unknown close,
 * crossing, leftovers). `elif` opens an implicit `if` inside the else branch,
 * closed together with its `endif`.
 */
export function structure<N>(nodes: N[], controlFor: (n: N) => Control | undefined): Item<N>[] | undefined {
  const root: Item<N>[] = [];
  const stack: Array<{ block: Block<N>; inElse: boolean; implicit: boolean }> = [];
  const target = () => {
    const top = stack.at(-1);
    return top ? (top.inElse ? top.block.otherwise : top.block.then) : root;
  };
  for (const node of nodes) {
    const c = controlFor(node);
    if (!c) {
      target().push({ node });
    } else if (c.kind === "open") {
      const block: Block<N> = { control: c, then: [], otherwise: [] };
      target().push({ block });
      stack.push({ block, inElse: false, implicit: false });
    } else if (c.kind === "elif") {
      const top = stack.at(-1);
      if (!top || top.inElse || top.block.control.name !== "if") return undefined;
      top.inElse = true;
      const block: Block<N> = { control: { kind: "open", name: "if", expr: c.expr }, then: [], otherwise: [] };
      top.block.otherwise.push({ block });
      stack.push({ block, inElse: false, implicit: true });
    } else if (c.kind === "else") {
      const top = stack.at(-1);
      if (!top || top.inElse) return undefined;
      top.inElse = true;
    } else {
      while (stack.at(-1)?.implicit) stack.pop();
      const top = stack.pop();
      if (!top || top.block.control.name !== c.name) return undefined;
    }
  }
  return stack.length === 0 ? root : undefined;
}

/** Truthiness for block subjects: Jinja's, where an empty list or object is false too. */
export const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === false ||
  v === 0 ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Loop items with their bindings: `for x in list`, `for k in dict` (keys), `for k, v in dict`, `for a, b in pairs`. */
function loopBindings(value: unknown, names: string[]): Array<Record<string, unknown>> {
  const [a, b] = names as [string, string | undefined];
  if (Array.isArray(value)) {
    return value.map((item) => (b === undefined ? { [a]: item } : { [a]: Array.isArray(item) ? item[0] : undefined, [b]: Array.isArray(item) ? item[1] : undefined }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([k, v]) => (b === undefined ? { [a]: k } : { [a]: k, [b]: v }));
  }
  return [];
}

/** What a block emits: which items, under which scope. */
export function expandBlock<N, R, C extends Pick<AdfContext, "scope" | "opts" | "warnings">>(
  block: Block<N>,
  ctx: C,
  emit: (items: Item<N>[], ctx: C) => R[],
): R[] {
  const { value, warnings } = evaluateExpression(block.control.expr, ctx.scope, { ...ctx.opts, strict: false });
  ctx.warnings.push(...warnings);
  if (block.control.name === "if") return emit(isEmpty(value) ? block.otherwise : block.then, ctx);
  const items = loopBindings(value, block.control.names);
  if (items.length === 0) return emit(block.otherwise, ctx);
  const length = items.length;
  return items.flatMap((bindings, i) => {
    ctx.opts.budget.iterate(ctx.opts.unit);
    const loop = { index: i + 1, index0: i, revindex: length - i, revindex0: length - i - 1, first: i === 0, last: i === length - 1, length };
    return emit(block.then, { ...ctx, scope: childScope(ctx.scope, { ...bindings, loop }) });
  });
}

const paragraphText = (n: AdfNode | undefined): string | undefined =>
  n?.type === "paragraph" &&
  n.content?.length &&
  n.content.every((c) => c.type === "text" && !(c.marks ?? []).some((m) => m.type === "code"))
    ? n.content.map((c) => c.text ?? "").join("")
    : undefined;

/** Paragraph, a list item holding only such a paragraph, or a row whose first cell does. */
function nodeControl(n: AdfNode): Control | undefined {
  let text = paragraphText(n);
  if (text === undefined && n.type === "listItem" && n.content?.length === 1) text = paragraphText(n.content[0]);
  if (text === undefined && n.type === "tableRow") {
    const first = n.content?.[0];
    if (first && (first.type === "tableCell" || first.type === "tableHeader") && first.content?.length === 1) {
      text = paragraphText(first.content[0]);
    }
  }
  return text === undefined ? undefined : controlOf(text);
}

/** Text of a cell, with other nodes as `[type]`, so a non-empty cell never reads as empty. */
const plainText = (n: AdfNode): string =>
  n.type === "text"
    ? (n.text ?? "")
    : ["paragraph", "tableCell", "tableHeader", "hardBreak"].includes(n.type)
      ? (n.content ?? []).map(plainText).join("")
      : `[${n.type}]`;

/** A control row is removed whole; content in its other cells goes with it. */
export function droppedContent(ctx: Pick<AdfContext, "opts" | "warnings">, lost: string): void {
  ctx.warnings.push({
    code: "dropped-content",
    message: `${ctx.opts.unit}: a {% … %} control row is removed with the content of its other cells ("${lost.slice(0, 60)}")`,
    unit: ctx.opts.unit,
  });
}

export function renderAdfBlocks(nodes: AdfNode[], ctx: AdfContext, render: (n: AdfNode, c: AdfContext) => AdfNode): AdfNode[] {
  if (!nodes.some((n) => nodeControl(n))) return nodes.map((n) => render(n, ctx));
  const items = structure(nodes, nodeControl);
  if (!items) {
    ctx.warnings.push({
      code: "unbalanced-block",
      message: `${ctx.opts.unit}: {% … %} control paragraphs don't pair up; left as is`,
      unit: ctx.opts.unit,
    });
    return nodes.map((n) => (nodeControl(n) ? n : render(n, ctx)));
  }
  for (const n of nodes) {
    const lost = nodeControl(n) && n.type === "tableRow" ? (n.content ?? []).slice(1).map(plainText).join(" ").trim() : "";
    if (lost) droppedContent(ctx, lost);
  }
  const emit = (list: Item<AdfNode>[], c: AdfContext): AdfNode[] =>
    list.flatMap((item) => ("node" in item ? [render(item.node, c)] : expandBlock(item.block, c, emit)));
  return emit(items, ctx);
}
