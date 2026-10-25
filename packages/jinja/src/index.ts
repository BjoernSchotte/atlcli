/**
 * Jinja templates for atlcli (Nunjucks, rendered inside QuickJS).
 *
 *   await initJinja();
 *   renderJinja("Hello {{ name | upper }}", { name: "ada" }).text  // "Hello ADA"
 *
 * Rendering is tolerant by default: an expression that cannot resolve stays
 * as written and is reported, instead of turning into empty text.
 */
import { analyze, applyLiteral, hasJinjaSyntax, JinjaSyntaxError, type AnalysisWarning } from "./analyze.js";
import { callGuest, DEFAULT_JINJA_LIMITS, type JinjaLimits } from "./sandbox.js";

export * from "./analyze.js";
export { DEFAULT_JINJA_LIMITS, initJinja, JinjaError, jinjaReady } from "./sandbox.js";
export type { JinjaLimits } from "./sandbox.js";

export type JinjaWarningCode = AnalysisWarning["code"] | "render-error";

export interface JinjaWarning {
  code: JinjaWarningCode;
  message: string;
  line?: number;
  column?: number;
}

export interface RenderJinjaOptions {
  /** Templates `{% include %}`/`{% extends %}`/`{% import %}` can load, by name. */
  templates?: Record<string, string>;
  /** Print unresolved expressions as written (default). False renders them as Nunjucks does: empty. */
  tolerant?: boolean;
  /**
   * Document templates: a line holding only a block tag (`{% if %}`, `{% endfor %}`)
   * disappears with its line break (Jinja's trim_blocks + lstrip_blocks). Off for
   * copied content, which must keep every character.
   */
  lines?: boolean;
  limits?: Partial<JinjaLimits>;
}

interface GuestAnswer {
  ok: boolean;
  text?: string;
  value?: unknown;
  defined?: boolean;
  error?: { message: string; line?: number; column?: number };
}

const limitsOf = (o: RenderJinjaOptions) => ({ ...DEFAULT_JINJA_LIMITS, ...o.limits });

/**
 * Renders `source` with `vars`. Syntax or runtime errors leave the source as
 * it is and come back as a warning; limits (time, memory) throw a JinjaError.
 */
export function renderJinja(source: string, vars: Record<string, unknown>, options: RenderJinjaOptions = {}): { text: string; warnings: JinjaWarning[] } {
  if (!hasJinjaSyntax(source)) return { text: source, warnings: [] };
  let template = source;
  const warnings: JinjaWarning[] = [];
  if (options.tolerant !== false) {
    try {
      const a = analyze(source, vars);
      warnings.push(...a.warnings);
      template = applyLiteral(source, a.literal);
    } catch (error) {
      return { text: source, warnings: [syntaxWarning(error)] };
    }
  }
  const answer = callGuest<GuestAnswer>({ mode: "render", source: template, vars, templates: options.templates ?? {}, lines: options.lines === true }, limitsOf(options));
  if (!answer.ok) return { text: source, warnings: [...warnings, renderWarning(answer.error)] };
  return { text: answer.text ?? "", warnings };
}

/**
 * Renders top-level pieces of `source` separately in one pass, so callers can
 * map output back onto where it came from (ADF text nodes, storage text). A
 * block (`{% if %}…{% endif %}`) is one piece.
 */
export function renderJinjaSegments(
  source: string,
  vars: Record<string, unknown>,
  options: RenderJinjaOptions = {},
): { segments: Array<{ start: number; end: number; output: string; kind: "content" | "expr" }>; warnings: JinjaWarning[] } {
  const whole = (output: string, warnings: JinjaWarning[]) => ({ segments: [{ start: 0, end: source.length, output, kind: "expr" as const }], warnings });
  if (!hasJinjaSyntax(source)) return { segments: [{ start: 0, end: source.length, output: source, kind: "content" }], warnings: [] };
  let a;
  try {
    a = analyze(source, vars);
  } catch (error) {
    return whole(source, [syntaxWarning(error)]);
  }
  const literal = options.tolerant === false ? [] : a.literal;
  const marker = (i: number) => `\u0001\u0002${i}\u0002\u0001`;
  const texts = a.segments.map((s) =>
    applyLiteral(source.slice(s.start, s.end), literal.filter(([ls, le]) => ls >= s.start && le <= s.end), s.start),
  );
  // Whitespace control (`{{-`, `-}}`) strips whitespace next to a tag. The
  // marker between two pieces would stop it, so that whitespace moves to the
  // tag's side of the marker: it is trimmed there, and the text piece keeps
  // its other characters where they were.
  const before = texts.map(() => "");
  const after = texts.map(() => "");
  const startTok = new Map(a.tokens.map((t) => [t.start, t]));
  const endTok = new Map(a.tokens.map((t) => [t.end, t]));
  for (let i = 0; i + 1 < a.segments.length; i++) {
    const cur = a.segments[i]!;
    const next = a.segments[i + 1]!;
    if (cur.kind === "content" && startTok.get(next.start)?.trimLeft) {
      const ws = /\s*$/.exec(texts[i]!)![0];
      texts[i] = texts[i]!.slice(0, texts[i]!.length - ws.length);
      before[i + 1] = ws;
    }
    if (next.kind === "content" && endTok.get(cur.end)?.trimRight) {
      const ws = /^\s*/.exec(texts[i + 1]!)![0];
      texts[i + 1] = texts[i + 1]!.slice(ws.length);
      after[i] = ws;
    }
  }
  const template = texts.map((t, i) => marker(i) + before[i] + t + after[i]).join("");
  const answer = callGuest<GuestAnswer>({ mode: "render", source: template, vars, templates: options.templates ?? {}, lines: options.lines === true }, limitsOf(options));
  const warnings: JinjaWarning[] = [...a.warnings];
  if (!answer.ok) return whole(source, [...warnings, renderWarning(answer.error)]);
  const text = answer.text ?? "";
  const segments = a.segments.map((s, i) => {
    const from = text.indexOf(marker(i)) + marker(i).length;
    const next = i + 1 < a.segments.length ? text.indexOf(marker(i + 1), from) : text.length;
    return { ...s, output: text.slice(from, next) };
  });
  // A marker went missing (a block printed nothing around it is fine; this is not): one piece.
  if (a.segments.some((_, i) => !text.includes(marker(i)))) {
    const r = renderJinja(source, vars, options);
    return whole(r.text, r.warnings);
  }
  return { segments, warnings };
}

/** Evaluates one expression (`items | length`, `a == "x"`) to its value; undefined with a warning when it cannot resolve. */
export function evaluateJinja(expr: string, vars: Record<string, unknown>, options: RenderJinjaOptions = {}): { value: unknown; warnings: JinjaWarning[] } {
  let warnings: JinjaWarning[] = [];
  try {
    const a = analyze(`{{ ${expr} }}`, vars);
    warnings = a.warnings.map((w) => (w.code === "unresolved" ? { ...w, message: `Unresolved {{ ${expr} }}; treated as empty` } : w));
    if (a.literal.length > 0) return { value: undefined, warnings };
  } catch (error) {
    return { value: undefined, warnings: [syntaxWarning(error)] };
  }
  const answer = callGuest<GuestAnswer>({ mode: "evaluate", source: expr, vars, templates: options.templates ?? {} }, limitsOf(options));
  if (!answer.ok) return { value: undefined, warnings: [...warnings, renderWarning(answer.error)] };
  return { value: answer.defined ? answer.value : undefined, warnings };
}

function syntaxWarning(error: unknown): JinjaWarning {
  if (error instanceof JinjaSyntaxError) return { code: "parse-error", message: error.message, line: error.line, column: error.column };
  return { code: "parse-error", message: error instanceof Error ? error.message : String(error) };
}

function renderWarning(error: GuestAnswer["error"]): JinjaWarning {
  return {
    code: /parse|expected|unexpected|unknown block tag|unclosed/i.test(error?.message ?? "") ? "parse-error" : "render-error",
    message: error?.message ?? "Template error",
    ...(error?.line !== undefined ? { line: error.line, column: error.column ?? 0 } : {}),
  };
}
