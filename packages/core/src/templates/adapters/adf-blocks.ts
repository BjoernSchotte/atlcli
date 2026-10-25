/**
 * Control paragraphs: a paragraph whose whole text is `{{#if …}}`,
 * `{{else}}`, `{{/each}}`, … controls its sibling blocks, so a template can
 * repeat or drop paragraphs, list items and table rows. Control nodes are
 * removed from the output. Blocks that don't pair stay as they are.
 */
import { childScope, evaluateExpression } from "../render.js";
import type { AdfContext, AdfNode } from "./adf.js";

export type BlockName = "if" | "unless" | "each" | "with";

export type Control =
  | { kind: "open"; name: BlockName; expr: string }
  | { kind: "else" }
  | { kind: "close"; name: BlockName };

export const CONTROL = /^\{\{~?\s*(?:#(if|unless|each|with)\s+([^}]+?)|(else)|\/(if|unless|each|with))\s*~?\}\}$/;

export function controlOf(text: string): Control | undefined {
  const m = CONTROL.exec(text.trim());
  if (!m) return undefined;
  if (m[1]) return { kind: "open", name: m[1] as BlockName, expr: m[2]!.trim() };
  if (m[3]) return { kind: "else" };
  return { kind: "close", name: m[4] as BlockName };
}

/** A pairing of controls over a sibling list: plain items and blocks. */
export interface Block<N> {
  control: Extract<Control, { kind: "open" }>;
  then: Item<N>[];
  otherwise: Item<N>[];
}
export type Item<N> = { node: N } | { block: Block<N> };

/** Pairs controls into blocks; undefined when they don't pair (unknown close, crossing, leftovers). */
export function structure<N>(nodes: N[], controlFor: (n: N) => Control | undefined): Item<N>[] | undefined {
  const root: Item<N>[] = [];
  const stack: Array<{ block: Block<N>; inElse: boolean }> = [];
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
      stack.push({ block, inElse: false });
    } else if (c.kind === "else") {
      const top = stack.at(-1);
      if (!top || top.inElse || top.block.control.name === "with") return undefined;
      top.inElse = true;
    } else {
      const top = stack.pop();
      if (!top || top.block.control.name !== c.name) return undefined;
    }
  }
  return stack.length === 0 ? root : undefined;
}

/** Handlebars truthiness for block subjects (0 and [] are empty). */
export const isEmpty = (v: unknown) => v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0);

/** What a block emits: which items, under which scope. */
export function expandBlock<N, R, C extends Pick<AdfContext, "scope" | "opts" | "warnings">>(
  block: Block<N>,
  ctx: C,
  emit: (items: Item<N>[], ctx: C) => R[],
): R[] {
  const { value, warnings } = evaluateExpression(block.control.expr, ctx.scope, { ...ctx.opts, strict: false });
  ctx.warnings.push(...warnings);
  switch (block.control.name) {
    case "if":
      return emit(isEmpty(value) ? block.otherwise : block.then, ctx);
    case "unless":
      return emit(isEmpty(value) ? block.then : block.otherwise, ctx);
    case "with":
      return isEmpty(value) ? [] : emit(block.then, { ...ctx, scope: childScope(ctx.scope, value) });
    case "each": {
      const entries: Array<[string | number, unknown]> = Array.isArray(value)
        ? value.map((v, i) => [i, v])
        : value && typeof value === "object"
          ? Object.entries(value)
          : [];
      if (entries.length === 0) return emit(block.otherwise, ctx);
      return entries.flatMap(([key, item], i) =>
        emit(block.then, { ...ctx, scope: childScope(ctx.scope, item, { index: i, key, first: i === 0, last: i === entries.length - 1 }) }),
      );
    }
  }
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

export function renderAdfBlocks(nodes: AdfNode[], ctx: AdfContext, render: (n: AdfNode, c: AdfContext) => AdfNode): AdfNode[] {
  if (!nodes.some((n) => nodeControl(n))) return nodes.map((n) => render(n, ctx));
  const items = structure(nodes, nodeControl);
  if (!items) {
    ctx.warnings.push({
      code: "unbalanced-block",
      message: `${ctx.opts.unit}: {{#…}} control paragraphs don't pair up; left as is`,
      unit: ctx.opts.unit,
    });
    return nodes.map((n) => (nodeControl(n) ? n : render(n, ctx)));
  }
  const emit = (list: Item<AdfNode>[], c: AdfContext): AdfNode[] =>
    list.flatMap((item) => ("node" in item ? [render(item.node, c)] : expandBlock(item.block, c, emit)));
  return emit(items, ctx);
}
