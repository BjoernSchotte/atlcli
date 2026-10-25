/**
 * Tolerant template rendering shared by every atlcli operation that writes
 * content. Handlebars renders a missing value as empty, which would silently
 * cut text out of a copied issue or page. An AST pass first finds every
 * expression that cannot resolve and escapes it, so Handlebars prints it
 * literally; each one becomes a warning instead.
 *
 * Browser-safe: no node: imports (exported from index.browser.ts).
 */
import type Handlebars from "handlebars";
import { getBuiltinVariables } from "./builtins.js";
import { createTemplateHandlebars, TEMPLATE_HELPER_NAMES } from "./helpers.js";

/** What templates see: `this` (user variables plus operation context) and `@data`. */
export interface TemplateScope {
  context: unknown;
  /** Data variables without the `@`: built-ins, `root`, loop data. */
  data: Record<string, unknown>;
  /** Inside a control-paragraph each/with: `this` is the item. */
  item?: boolean;
}

export type RenderWarningCode =
  | "unresolved"
  | "parse-error"
  | "unknown-helper"
  | "unsupported"
  | "unbalanced-block"
  | "crosses-inline-node"
  | "invalid-url"
  | "unused-variable"
  | "not-rendered-field";

export interface RenderWarning {
  code: RenderWarningCode;
  message: string;
  /** Where: "TPL-1 summary", "page 123 body", … */
  unit?: string;
  line?: number;
  column?: number;
}

export interface RenderOptions {
  unit?: string;
  /** Any warning fails the render with a RenderError. */
  strict?: boolean;
  /** Shared per run; a fresh default budget per call otherwise. */
  budget?: RenderBudget;
}

/** A top-level piece of a unit: `source.slice(start, end)` renders to `output`. */
export interface Segment {
  start: number;
  end: number;
  output: string;
  /** Plain text (its output only drops characters: `~` trimming, `\` escapes) or an expression. */
  kind?: "content" | "expr";
}

export class RenderError extends Error {
  constructor(
    message: string,
    readonly warnings: RenderWarning[] = [],
  ) {
    super(message);
    this.name = "RenderError";
  }
}

/** Output limits: per unit and per run (characters), and loop iterations per run. */
export class RenderBudget {
  private used = 0;
  private iterations = 0;
  constructor(
    readonly perUnit = 1_000_000,
    readonly perRun = 16_000_000,
    readonly maxIterations = 100_000,
  ) {}

  /** One {{#each}} item (text or control paragraphs); counted while rendering, so nesting cannot run away. */
  iterate(unit?: string): void {
    if (++this.iterations > this.maxIterations) {
      throw new RenderError(`Template loop limit exceeded in ${unit ?? "a value"} (more than ${this.maxIterations} {{#each}} items in this run)`);
    }
  }

  charge(chars: number, unit?: string): void {
    if (chars > this.perUnit) {
      throw new RenderError(`Template output limit exceeded in ${unit ?? "a value"} (${chars} > ${this.perUnit} characters)`);
    }
    this.used += chars;
    if (this.used > this.perRun) {
      throw new RenderError(`Template output limit exceeded for this run (${this.used} > ${this.perRun} characters)`);
    }
  }
}

const HELPERS = new Set(TEMPLATE_HELPER_NAMES);
const BLOCK_BUILTINS = new Set(["if", "unless", "each", "with"]);
/** Bodies of these change `this`, so plain paths inside are not checked statically. */
const BLOCK_SCOPING = new Set(["each", "with"]);
const LOOP_DATA = new Set(["index", "key", "first", "last"]);

export function createTemplateScope(
  input: {
    vars?: Record<string, unknown>;
    now?: Date;
    user?: string;
    profile?: string;
    space?: string;
    project?: string;
    source?: unknown;
    parent?: unknown;
    /** Makes @uuid differ between units under one frozen clock. */
    seed?: string;
  } = {},
): TemplateScope {
  const context: Record<string, unknown> = { ...(input.vars ?? {}) };
  if (input.source !== undefined) context.source = input.source;
  if (input.parent !== undefined) context.parent = input.parent;
  const data = getBuiltinVariables({
    now: input.now,
    user: input.user,
    profile: input.profile,
    space: input.space,
    project: input.project,
    seed: input.seed,
  });
  return { context, data: { ...data, root: context } };
}

/** Scope for an each/with body: `this` becomes `context`; `@root` stays. */
export function childScope(scope: TemplateScope, context: unknown, data: Record<string, unknown> = {}): TemplateScope {
  return { context, data: { ...scope.data, ...data }, item: true };
}

/** Own-property walk; never reaches the prototype chain. */
function lookup(base: unknown, parts: string[]): boolean {
  let value = base;
  for (const part of parts) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return false;
    value = (value as Record<string, unknown>)[part];
  }
  return true;
}

/** Line starts as Handlebars counts lines: \r\n, \n and a lone \r each end one. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n" || (source[i] === "\r" && source[i + 1] !== "\n")) starts.push(i + 1);
  }
  return starts;
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

function parse(hbs: typeof Handlebars, source: string): hbs.AST.Program | Error {
  try {
    return hbs.parse(source);
  } catch (error) {
    return new Error(firstLine(error));
  }
}

const helperName = (expr: hbs.AST.Expression): string =>
  expr.type === "PathExpression" ? (expr as hbs.AST.PathExpression).original : "";

/** Whether `expr` resolves in `scope`; `scoped` = inside an each/with body. */
function resolves(expr: hbs.AST.Expression, scope: TemplateScope, scoped: boolean): boolean {
  if (expr.type === "SubExpression") {
    const sub = expr as hbs.AST.SubExpression;
    const name = helperName(sub.path);
    return HELPERS.has(name) && sub.params.every((p, i) => (name === "default" && i === 0) || resolves(p, scope, scoped));
  }
  if (expr.type !== "PathExpression") return true; // literals
  const path = expr as hbs.AST.PathExpression;
  if (path.data) {
    const [head, ...rest] = path.parts;
    if (head === "root") return lookup(scope.data.root, rest);
    if (scoped && LOOP_DATA.has(head!)) return true;
    return lookup(scope.data, path.parts);
  }
  if (scoped) return true;
  // ../x has no parent outside a block; `this` at the top is the variables object.
  if (path.depth > 0) return false;
  if (path.parts.length === 0) return scope.item === true;
  return lookup(scope.context, path.parts);
}

interface Analysis {
  /** Source ranges whose `{{` must be escaped. */
  escapes: Array<[number, number]>;
  warnings: RenderWarning[];
}

function analyze(program: hbs.AST.Program, source: string, scope: TemplateScope, unit: string | undefined): Analysis {
  const starts = lineStarts(source);
  const offset = (p: hbs.AST.Position) => starts[p.line - 1]! + p.column;
  const out: Analysis = { escapes: [], warnings: [] };
  const warn = (code: RenderWarningCode, node: hbs.AST.Node, message: string) =>
    out.warnings.push({ code, message, unit, line: node.loc.start.line, column: node.loc.start.column });
  const escape = (node: hbs.AST.Node) => out.escapes.push([offset(node.loc.start), offset(node.loc.end)]);
  const text = (node: hbs.AST.Node) => source.slice(offset(node.loc.start), offset(node.loc.end));

  const walk = (body: hbs.AST.Statement[], scoped: boolean) => {
    for (const stmt of body) {
      switch (stmt.type) {
        case "MustacheStatement": {
          const m = stmt as hbs.AST.MustacheStatement;
          const name = helperName(m.path);
          const isCall = m.params.length > 0 || (m.hash?.pairs.length ?? 0) > 0;
          if (m.path.type === "SubExpression") {
            if (!resolves(m.path, scope, scoped)) {
              warn("unresolved", m, `Unresolved ${text(m)}`);
              escape(m);
            }
          } else if (isCall) {
            if (!HELPERS.has(name)) {
              warn("unknown-helper", m, `Unknown helper "${name}" in ${text(m)}`);
              escape(m);
            } else if (!m.params.every((p, i) => (name === "default" && i === 0) || resolves(p, scope, scoped))) {
              warn("unresolved", m, `Unresolved value in ${text(m)}`);
              escape(m);
            }
          } else if (!HELPERS.has(name) && !resolves(m.path, scope, scoped)) {
            warn("unresolved", m, `Unresolved ${text(m)}`);
            escape(m);
          }
          break;
        }
        case "BlockStatement": {
          const b = stmt as hbs.AST.BlockStatement;
          const name = helperName(b.path);
          if (!BLOCK_BUILTINS.has(name)) {
            warn("unknown-helper", b, `Unknown block helper "#${name}"`);
            escape(b);
            break;
          }
          const subject = b.params[0];
          if (subject && !resolves(subject, scope, scoped)) {
            warn("unresolved", b, `Unresolved {{#${name}}} subject; treated as empty`);
          }
          walk(b.program.body, scoped || BLOCK_SCOPING.has(name));
          if (b.inverse) walk(b.inverse.body, scoped);
          break;
        }
        case "PartialStatement":
        case "PartialBlockStatement":
        case "DecoratorBlock":
        case "Decorator":
          warn("unsupported", stmt, `Partials and decorators are not supported: ${text(stmt)}`);
          escape(stmt);
          break;
        default:
          break; // ContentStatement, CommentStatement
      }
    }
  };
  walk(program.body, false);
  return out;
}

/** Puts a backslash before every unescaped `{{` inside the ranges, so Handlebars prints them. */
function applyEscapes(source: string, ranges: Array<[number, number]>, shift = 0): string {
  const points = new Set<number>();
  for (const [start, end] of ranges) {
    const from = start - shift;
    const to = end - shift;
    for (let i = source.indexOf("{{", Math.max(0, from)); i !== -1 && i < to; i = source.indexOf("{{", i + 2)) {
      if (source[i - 1] !== "\\") points.add(i);
    }
  }
  let out = "";
  let last = 0;
  for (const p of [...points].sort((a, b) => a - b)) {
    out += source.slice(last, p) + "\\";
    last = p;
  }
  return out + source.slice(last);
}

const STR = "__atlcliStr";

/**
 * Rewrites `{{expr …}}` to `{{__atlcliStr (expr …)}}`. With noEscape,
 * Handlebars joins mustache values with `+`, so two numbers would be added
 * ("{{year}}{{year}}" → "4052"); stringifying each value first prevents it.
 */
function stringifyMustaches(body: hbs.AST.Statement[]): void {
  for (const stmt of body) {
    if (stmt.type === "MustacheStatement") {
      const m = stmt as hbs.AST.MustacheStatement & { params: hbs.AST.Expression[]; path: hbs.AST.Expression };
      const call = m.params.length > 0 || (m.hash?.pairs.length ?? 0) > 0;
      const inner: hbs.AST.Expression = call
        ? ({ type: "SubExpression", path: m.path, params: m.params, hash: m.hash, loc: m.loc } as hbs.AST.SubExpression)
        : m.path;
      m.path = { type: "PathExpression", data: false, depth: 0, parts: [STR], original: STR, loc: m.loc } as hbs.AST.PathExpression;
      m.params = [inner];
      (m as { hash?: hbs.AST.Hash }).hash = undefined;
    } else if (stmt.type === "BlockStatement") {
      const b = stmt as hbs.AST.BlockStatement;
      stringifyMustaches(b.program.body);
      if (b.inverse) stringifyMustaches(b.inverse.body);
    }
  }
}

function compile(hbs: typeof Handlebars, source: string, scope: TemplateScope, budget: RenderBudget, unit?: string): string {
  const program = hbs.parse(source);
  stringifyMustaches(program.body);
  // Counted while rendering: a nested loop must hit the limit before it builds a huge string.
  let produced = 0;
  hbs.registerHelper(STR, (v: unknown) => {
    const text = v === undefined || v === null ? "" : String(v);
    produced += text.length;
    if (produced > budget.perUnit) budget.charge(produced, unit);
    return text;
  });
  const each = hbs.helpers.each!;
  hbs.registerHelper("each", function (this: unknown, context: unknown, options: Handlebars.HelperOptions) {
    const fn = options.fn;
    return each.call(this, context, {
      ...options,
      fn: (c: unknown, o?: Handlebars.RuntimeOptions) => {
        budget.iterate(unit);
        return fn(c, o);
      },
    });
  });
  return hbs.compile(program, { noEscape: true, strict: false })(scope.context, { data: scope.data });
}

/** Throws a RenderError when `opts.strict` and there are warnings; otherwise passes through. */
export function finish<T>(value: T, warnings: RenderWarning[], opts: RenderOptions = {}): { value: T; warnings: RenderWarning[] } {
  if (opts.strict && warnings.length > 0) {
    throw new RenderError(`Template warnings with --strict: ${warnings.map((w) => (w.unit ? `${w.unit}: ${w.message}` : w.message)).join("; ")}`, warnings);
  }
  return { value, warnings };
}

export function renderText(source: string, scope: TemplateScope, opts: RenderOptions = {}): { text: string; warnings: RenderWarning[] } {
  const budget = opts.budget ?? new RenderBudget();
  if (!source.includes("{{")) {
    budget.charge(source.length, opts.unit);
    return { text: source, warnings: [] };
  }
  const hbs = createTemplateHandlebars();
  const program = parse(hbs, source);
  if (program instanceof Error) {
    budget.charge(source.length, opts.unit);
    return { text: source, warnings: finish(null, [{ code: "parse-error", message: program.message, unit: opts.unit }], opts).warnings };
  }
  const { escapes, warnings } = analyze(program, source, scope, opts.unit);
  finish(null, warnings, opts);
  const text = compile(hbs, applyEscapes(source, escapes), scope, budget, opts.unit);
  budget.charge(text.length, opts.unit);
  return { text, warnings };
}

/**
 * Like renderText, but per top-level statement, so adapters can map output
 * back onto the pieces (ADF text nodes, storage text tokens) the unit came
 * from. Content keeps Handlebars' processed value (escapes, `~` stripping).
 */
export function renderSegments(source: string, scope: TemplateScope, opts: RenderOptions = {}): { segments: Segment[]; warnings: RenderWarning[] } {
  const budget = opts.budget ?? new RenderBudget();
  const whole = (warnings: RenderWarning[]) => {
    finish(null, warnings, opts);
    budget.charge(source.length, opts.unit);
    return { segments: [{ start: 0, end: source.length, output: source }], warnings };
  };
  if (!source.includes("{{")) return whole([]);
  const hbs = createTemplateHandlebars();
  const program = parse(hbs, source);
  if (program instanceof Error) return whole([{ code: "parse-error", message: program.message, unit: opts.unit }]);
  const { escapes, warnings } = analyze(program, source, scope, opts.unit);
  finish(null, warnings, opts);

  const starts = lineStarts(source);
  const offset = (p: hbs.AST.Position) => starts[p.line - 1]! + p.column;
  const body = program.body;
  const bounds = body.map((s) => offset(s.loc.start));
  const monotonic = bounds[0] === 0 && bounds.every((b, i) => i === 0 || b > bounds[i - 1]!);
  if (!monotonic) {
    // Unexpected locations: render the unit as one segment.
    const output = compile(hbs, applyEscapes(source, escapes), scope, budget, opts.unit);
    budget.charge(output.length, opts.unit);
    return { segments: [{ start: 0, end: source.length, output }], warnings };
  }
  const segments: Segment[] = [];
  let total = 0;
  body.forEach((stmt, i) => {
    const start = bounds[i]!;
    const end = bounds[i + 1] ?? source.length;
    const slice = source.slice(start, end);
    const content = stmt.type === "ContentStatement";
    const output = content
      ? (stmt as hbs.AST.ContentStatement).value
      : stmt.type === "CommentStatement"
        ? ""
        : compile(hbs, applyEscapes(slice, escapes, start), scope, budget, opts.unit);
    total += output.length;
    if (total > budget.perUnit) budget.charge(total, opts.unit);
    segments.push({ start, end, output, kind: content ? "content" : "expr" });
  });
  budget.charge(total, opts.unit);
  return { segments, warnings };
}

const CAPTURE = "__atlcliCapture";

/** Evaluates a block subject (`systems`, `(eq a "x")`) to its value; unknown → undefined with a warning. */
export function evaluateExpression(expr: string, scope: TemplateScope, opts: RenderOptions = {}): { value: unknown; warnings: RenderWarning[] } {
  const hbs = createTemplateHandlebars();
  const source = `{{${CAPTURE} ${expr}}}`;
  const program = parse(hbs, source);
  const statement = program instanceof Error ? undefined : program.body[0];
  if (!statement || statement.type !== "MustacheStatement" || program instanceof Error || program.body.length !== 1) {
    const message = program instanceof Error ? program.message : `Not an expression: ${expr}`;
    return finish(undefined, [{ code: "parse-error", message, unit: opts.unit }], opts);
  }
  const param = (statement as hbs.AST.MustacheStatement).params[0];
  if (param && !resolves(param, scope, false)) {
    const code = param.type === "SubExpression" && !HELPERS.has(helperName((param as hbs.AST.SubExpression).path)) ? "unknown-helper" : "unresolved";
    return finish(undefined, [{ code, message: `Unresolved {{${expr}}}; treated as empty`, unit: opts.unit }], opts);
  }
  let value: unknown;
  hbs.registerHelper(CAPTURE, (v: unknown) => {
    value = v;
    return "";
  });
  compile(hbs, source, scope, opts.budget ?? new RenderBudget(), opts.unit);
  return finish(value, [], opts);
}
