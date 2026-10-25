/**
 * Jira/Confluence ADF. Only text changes: adjacent text nodes of one inline
 * container form a unit (the editor splits text at marks, so `{{cus` +
 * **`tomer}}`** still resolves), every other inline node is a boundary, and
 * code is never rendered. A document without `{{` comes back as the same
 * object.
 */
import { finish, RenderBudget, renderSegments, renderText, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";
import { renderAdfBlocks } from "./adf-blocks.js";
import { distribute, withoutPosition } from "./runs.js";

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  [key: string]: unknown;
}

export interface AdfContext {
  scope: TemplateScope;
  opts: RenderOptions & { unit: string; budget: RenderBudget };
  warnings: RenderWarning[];
}

const URL_OK = /^(https?:|mailto:|\/|#)/;
const isRunText = (n: AdfNode) => n.type === "text" && !(n.marks ?? []).some((m) => m.type === "code");
const hasPlaceholder = (v: unknown) => JSON.stringify(v).includes("{{");

export function renderAdf<T>(doc: T, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: T; warnings: RenderWarning[] } {
  if (doc === null || typeof doc !== "object" || !hasPlaceholder(doc)) return { value: doc, warnings: [] };
  const ctx: AdfContext = { scope, opts: { ...opts, strict: false, budget: opts.budget ?? new RenderBudget() }, warnings: [] };
  const value = renderNode(doc as unknown as AdfNode, ctx) as unknown as T;
  return finish(value, ctx.warnings, opts);
}

export function renderNode(node: AdfNode, ctx: AdfContext): AdfNode {
  if (node.type === "codeBlock" || !Array.isArray(node.content) || !hasPlaceholder(node)) return node;
  const content = node.content.some((c) => c.type === "text")
    ? renderInline(node.content, ctx)
    : renderAdfBlocks(node.content, ctx, (child, c) => renderNode(child, c));
  return { ...node, content };
}

function renderInline(children: AdfNode[], ctx: AdfContext): AdfNode[] {
  const out: AdfNode[] = [];
  let run: AdfNode[] = [];
  const flush = (next?: AdfNode) => {
    if (run.length === 0) return;
    const pieces = run.map((n) => n.text ?? "");
    const joined = pieces.join("");
    const open = joined.match(/\{\{/g)?.length ?? 0;
    const close = joined.match(/\}\}/g)?.length ?? 0;
    if (!joined.includes("{{")) {
      out.push(...run.map((n) => renderLinkMarks(n, ctx)));
    } else if (next !== undefined && open > close) {
      ctx.warnings.push({
        code: "crosses-inline-node",
        message: `${ctx.opts.unit}: an expression runs into a ${next.type}; left as is`,
        unit: ctx.opts.unit,
      });
      out.push(...run.map((n) => renderLinkMarks(n, ctx)));
    } else {
      const { segments, warnings } = renderSegments(joined, ctx.scope, ctx.opts);
      ctx.warnings.push(...warnings.map(withoutPosition));
      const texts = distribute(pieces, segments);
      run.forEach((n, i) => {
        // ADF forbids empty text nodes.
        if (texts[i] !== "") out.push(renderLinkMarks(texts[i] === n.text ? n : { ...n, text: texts[i] }, ctx));
      });
    }
    run = [];
  };
  for (const child of children) {
    if (isRunText(child)) {
      run.push(child);
      continue;
    }
    flush(child);
    out.push(child.type === "text" ? child : renderNode(child, ctx));
  }
  flush();
  return out;
}

function renderLinkMarks(node: AdfNode, ctx: AdfContext): AdfNode {
  const templated = (m: AdfMark) => m.type === "link" && typeof m.attrs?.href === "string" && m.attrs.href.includes("{{");
  if (!node.marks?.some(templated)) return node;
  const marks = node.marks.map((m) => {
    if (!templated(m)) return m;
    const href = m.attrs!.href as string;
    const { text, warnings } = renderText(href, ctx.scope, ctx.opts);
    ctx.warnings.push(...warnings.map(withoutPosition));
    let ok = URL_OK.test(text);
    if (ok && /^https?:/.test(text)) {
      try {
        new URL(text);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      ctx.warnings.push({ code: "invalid-url", message: `${ctx.opts.unit}: link "${href}" renders to an invalid URL; kept`, unit: ctx.opts.unit });
      return m;
    }
    return { ...m, attrs: { ...m.attrs, href: text } };
  });
  return { ...node, marks };
}

/** Joined text of every inline run plus templated link hrefs: what a template author wrote. */
export function adfTextUnits(doc: unknown): string[] {
  const units: string[] = [];
  const visit = (node: AdfNode) => {
    if (!node || typeof node !== "object" || node.type === "codeBlock" || !Array.isArray(node.content)) return;
    let run = "";
    for (const child of node.content) {
      if (isRunText(child)) {
        run += child.text ?? "";
        for (const m of child.marks ?? []) if (m.type === "link" && typeof m.attrs?.href === "string") units.push(m.attrs.href);
        continue;
      }
      if (run) units.push(run);
      run = "";
      visit(child);
    }
    if (run) units.push(run);
  };
  visit(doc as AdfNode);
  return units;
}
