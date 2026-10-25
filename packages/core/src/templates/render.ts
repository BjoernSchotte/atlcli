/**
 * Tolerant template rendering shared by every atlcli operation that writes
 * content. Templates are Jinja (Nunjucks, rendered inside QuickJS by
 * @atlcli/jinja). Jinja renders a missing value as empty, which would silently
 * cut text out of a copied issue or page; a static pass first finds every
 * expression that cannot resolve and keeps it as written, with a warning.
 *
 * Rendering is synchronous but needs `await initJinja()` once (re-exported here).
 * Browser-safe: no node: imports (exported from index.browser.ts).
 */
import { evaluateJinja, hasJinjaSyntax, JinjaError, renderJinja, renderJinjaSegments, type JinjaWarning } from "@atlcli/jinja";
import { getBuiltinVariables } from "./builtins.js";

export { hasJinjaSyntax, initJinja, jinjaReady } from "@atlcli/jinja";

/** What templates see: one flat set of names (built-ins, then variables and operation context, which win). */
export interface TemplateScope {
  vars: Record<string, unknown>;
}

export type RenderWarningCode =
  | "unresolved"
  | "parse-error"
  | "render-error"
  | "unknown-helper"
  | "unsupported"
  | "unbalanced-block"
  | "crosses-inline-node"
  | "invalid-url"
  | "unused-variable"
  | "not-rendered-field"
  | "dropped-content";

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

  /** One item of a `{% for %}` control paragraph; counted while expanding, so nesting cannot run away. */
  iterate(unit?: string): void {
    if (++this.iterations > this.maxIterations) {
      throw new RenderError(`Template loop limit exceeded in ${unit ?? "a value"} (more than ${this.maxIterations} {% for %} items in this run)`);
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
    /** Makes `uuid` differ between units under one frozen clock. */
    seed?: string;
  } = {},
): TemplateScope {
  const builtins = getBuiltinVariables({
    now: input.now,
    user: input.user,
    profile: input.profile,
    space: input.space,
    project: input.project,
    seed: input.seed,
  });
  const vars: Record<string, unknown> = { ...builtins, ...(input.vars ?? {}) };
  if (input.source !== undefined) vars.source = input.source;
  if (input.parent !== undefined) vars.parent = input.parent;
  return { vars };
}

/** Scope for a control-paragraph block body: loop variables and `loop` on top of the outer names. */
export function childScope(scope: TemplateScope, bindings: Record<string, unknown>): TemplateScope {
  return { vars: { ...scope.vars, ...bindings } };
}

const toWarnings = (warnings: JinjaWarning[], unit: string | undefined): RenderWarning[] =>
  warnings.map((w) => ({ code: w.code, message: w.message, ...(unit ? { unit } : {}), ...(w.line !== undefined ? { line: w.line, column: w.column ?? 0 } : {}) }));

/** Engine limits (time, memory) end the render like the output budget does. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof JinjaError && error.kind === "limit") throw new RenderError(error.message);
    throw error;
  }
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
  if (!hasJinjaSyntax(source)) {
    budget.charge(source.length, opts.unit);
    return { text: source, warnings: [] };
  }
  const r = guarded(() => renderJinja(source, scope.vars));
  const warnings = toWarnings(r.warnings, opts.unit);
  finish(null, warnings, opts);
  budget.charge(r.text.length, opts.unit);
  return { text: r.text, warnings };
}

/**
 * Like renderText, but per top-level piece, so adapters can map output back
 * onto the pieces (ADF text nodes, storage text tokens) the unit came from.
 */
export function renderSegments(source: string, scope: TemplateScope, opts: RenderOptions = {}): { segments: Segment[]; warnings: RenderWarning[] } {
  const budget = opts.budget ?? new RenderBudget();
  if (!hasJinjaSyntax(source)) {
    budget.charge(source.length, opts.unit);
    return { segments: [{ start: 0, end: source.length, output: source, kind: "content" }], warnings: [] };
  }
  const r = guarded(() => renderJinjaSegments(source, scope.vars));
  const warnings = toWarnings(r.warnings, opts.unit);
  finish(null, warnings, opts);
  budget.charge(
    r.segments.reduce((n, s) => n + s.output.length, 0),
    opts.unit,
  );
  return { segments: r.segments, warnings };
}

/** Evaluates a control subject (`systems`, `a == "x"`) to its value; unknown → undefined with a warning. */
export function evaluateExpression(expr: string, scope: TemplateScope, opts: RenderOptions = {}): { value: unknown; warnings: RenderWarning[] } {
  const r = guarded(() => evaluateJinja(expr, scope.vars));
  return finish(r.value, toWarnings(r.warnings, opts.unit), opts);
}
