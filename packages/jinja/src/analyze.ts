/**
 * Static analysis of Jinja templates on the host, before anything renders:
 * where the tags are, which variables an expression reads, and which of them
 * do not resolve. atlcli renders tolerantly: an expression that cannot
 * resolve is printed as written (wrapped in `{% raw %}`) and reported, instead
 * of silently becoming empty. Pure; no Nunjucks needed.
 */

export interface Token {
  kind: "text" | "var" | "tag" | "comment";
  /** Offsets in the source, `end` exclusive. */
  start: number;
  end: number;
  /** Between the delimiters, without `-` whitespace markers, trimmed. */
  inner: string;
  /** `{{-` / `{%-` and `-}}` / `-%}` */
  trimLeft: boolean;
  trimRight: boolean;
  /** 1-based line, 0-based column of `start`. */
  line: number;
  column: number;
}

export class JinjaSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "JinjaSyntaxError";
  }
}

/** True when `s` contains anything Jinja would treat as template syntax. */
export function hasJinjaSyntax(s: string): boolean {
  return s.includes("{{") || s.includes("{%") || s.includes("{#");
}

const CLOSE = { "{{": "}}", "{%": "%}", "{#": "#}" } as const;
const KIND = { "{{": "var", "{%": "tag", "{#": "comment" } as const;

function position(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/** Splits a template into text, `{{ }}`, `{% %}` and `{# #}` tokens. `{% raw %}` bodies stay text. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;
  const pushText = (end: number) => {
    if (end > textStart) {
      const p = position(source, textStart);
      tokens.push({ kind: "text", start: textStart, end, inner: source.slice(textStart, end), trimLeft: false, trimRight: false, ...p });
    }
  };
  while (i < source.length) {
    const open = source.slice(i, i + 2) as keyof typeof CLOSE;
    if (!(open in CLOSE)) {
      i++;
      continue;
    }
    pushText(i);
    const close = CLOSE[open];
    let j = i + 2;
    let quote: string | undefined;
    let end = -1;
    while (j < source.length) {
      const ch = source[j]!;
      if (open !== "{#" && quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = undefined;
      } else if (open !== "{#" && (ch === '"' || ch === "'")) {
        quote = ch;
      } else if (source.startsWith(close, j)) {
        end = j + 2;
        break;
      }
      j++;
    }
    const p = position(source, i);
    if (end < 0) throw new JinjaSyntaxError(`Unclosed ${open}`, p.line, p.column);
    let inner = source.slice(i + 2, end - 2);
    const trimLeft = inner.startsWith("-");
    const trimRight = inner.endsWith("-") && inner.length > 0;
    if (trimLeft) inner = inner.slice(1);
    if (trimRight) inner = inner.slice(0, -1);
    const token: Token = { kind: KIND[open], start: i, end, inner: inner.trim(), trimLeft, trimRight, ...p };
    tokens.push(token);
    i = end;
    textStart = end;
    // {% raw %} … {% endraw %}: the body is text.
    if (token.kind === "tag" && /^(raw|verbatim)$/.test(tagName(token))) {
      const endName = tagName(token) === "raw" ? "endraw" : "endverbatim";
      const re = new RegExp(`\\{%-?\\s*${endName}\\s*-?%\\}`, "g");
      re.lastIndex = i;
      const m = re.exec(source);
      if (!m) throw new JinjaSyntaxError(`Unclosed {% ${tagName(token)} %}`, p.line, p.column);
      pushText(m.index);
      const q = position(source, m.index);
      tokens.push({ kind: "tag", start: m.index, end: m.index + m[0].length, inner: endName, trimLeft: m[0].startsWith("{%-"), trimRight: m[0].endsWith("-%}"), ...q });
      i = m.index + m[0].length;
      textStart = i;
    }
  }
  pushText(source.length);
  return tokens;
}

/** First word of a tag: `if`, `for`, `endfor`, … */
export function tagName(token: Token): string {
  return /^[A-Za-z_]+/.exec(token.inner)?.[0] ?? "";
}

/** Tags that open a block, and the tag that closes it. */
const BLOCKS: Record<string, string> = {
  if: "endif",
  for: "endfor",
  macro: "endmacro",
  call: "endcall",
  filter: "endfilter",
  block: "endblock",
  raw: "endraw",
  verbatim: "endverbatim",
};

// ============ Expressions ============

const KEYWORDS = new Set(["and", "or", "not", "in", "is", "if", "else", "true", "false", "none", "null", "True", "False", "None", "loop"]);
/** Nunjucks 3.2 globals. */
export const JINJA_GLOBALS = new Set(["range", "cycler", "joiner", "caller", "super", "self", "varargs", "kwargs"]);
/** Nunjucks 3.2 filters plus atlcli's. */
export const JINJA_FILTERS = new Set([
  "abs", "batch", "capitalize", "center", "default", "d", "dictsort", "dump", "escape", "e", "first", "float", "forceescape",
  "groupby", "indent", "int", "join", "last", "length", "list", "lower", "nl2br", "random", "reject", "rejectattr", "replace",
  "reverse", "round", "safe", "select", "selectattr", "slice", "sort", "string", "striptags", "sum", "title", "trim", "truncate",
  "upper", "urlencode", "urlize", "wordcount",
  "date", "dateAdd",
]);

interface ExprToken {
  type: "name" | "string" | "number" | "punct";
  value: string;
}

function lexExpression(expr: string): ExprToken[] {
  const out: ExprToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== ch) j += expr[j] === "\\" ? 2 : 1;
      out.push({ type: "string", value: expr.slice(i + 1, j) });
      i = j + 1;
    } else if (/[0-9]/.test(ch)) {
      const m = /^[0-9][0-9._]*/.exec(expr.slice(i))!;
      out.push({ type: "number", value: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i))!;
      out.push({ type: "name", value: m[0] });
      i += m[0].length;
    } else {
      const two = expr.slice(i, i + 2);
      const op = ["==", "!=", "<=", ">=", "//", "**"].includes(two) ? two : ch;
      out.push({ type: "punct", value: op });
      i += op.length;
    }
  }
  return out;
}

export interface ExpressionRefs {
  /** Free variable paths read, e.g. ["source", "fields", "summary"]. */
  paths: string[][];
  /** Filters applied. */
  filters: string[];
  /** Names called as functions. */
  calls: string[];
}

/** Variables, filters and function names an expression refers to. */
export function expressionRefs(expr: string): ExpressionRefs {
  const t = lexExpression(expr);
  const refs: ExpressionRefs = { paths: [], filters: [], calls: [] };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.type !== "name") continue;
    const prev = t[i - 1];
    const next = t[i + 1];
    if (prev?.type === "punct" && prev.value === ".") continue; // attribute
    if (prev?.type === "punct" && prev.value === "|") {
      refs.filters.push(tok.value);
      continue;
    }
    // Test after `is` / `is not`: `x is defined`.
    if (prev?.type === "name" && prev.value === "is") continue;
    if (prev?.type === "name" && prev.value === "not" && t[i - 2]?.type === "name" && t[i - 2]!.value === "is") continue;
    // Keyword argument name: `f(a=1)`.
    if (next?.type === "punct" && next.value === "=") continue;
    if (KEYWORDS.has(tok.value) && tok.value !== "loop") continue;
    if (next?.type === "punct" && next.value === "(") {
      refs.calls.push(tok.value);
      continue;
    }
    const path = [tok.value];
    for (let j = i + 1; j + 1 < t.length; j += 2) {
      const dot = t[j]!;
      const name = t[j + 1]!;
      if (dot.type === "punct" && dot.value === "." && name.type === "name") path.push(name.value);
      else if (dot.type === "punct" && dot.value === "[" && name.type === "string" && t[j + 2]?.value === "]") {
        path.push(name.value);
        j++;
      } else break;
    }
    refs.paths.push(path);
  }
  return refs;
}

// ============ Template analysis ============

export type WarningCode = "unresolved" | "unknown-helper" | "unsupported" | "parse-error";

export interface AnalysisWarning {
  code: WarningCode;
  message: string;
  line: number;
  column: number;
}

export interface Analysis {
  tokens: Token[];
  /** Source ranges to print literally (unresolved expressions, comments). */
  literal: Array<[number, number]>;
  warnings: AnalysisWarning[];
  /** Top-level pieces: text, an expression, or a whole block from its opening to its closing tag. */
  segments: Array<{ start: number; end: number; kind: "content" | "expr" }>;
  /** Free root names read outside of local bindings (for variable collection). */
  roots: Array<{ name: string; line: number }>;
}

/** Lookup in the variables: own properties only, never the prototype chain. */
export function resolvesIn(vars: unknown, path: string[]): boolean {
  let value = vars;
  for (const part of path) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return false;
    value = (value as Record<string, unknown>)[part];
  }
  return true;
}

/** Names a tag binds: `for a, b in …`, `set x = …`, `macro m(p, q=1)`, `import … as y`, `from … import a as b`. */
function bindings(token: Token): { here: string[]; inner: string[] } {
  const name = tagName(token);
  const rest = token.inner.slice(name.length);
  const names = (s: string) => s.split(",").map((n) => n.trim()).filter((n) => /^[A-Za-z_]\w*$/.test(n));
  switch (name) {
    case "for": {
      const m = /^\s*(.+?)\s+in\s+/.exec(rest);
      return { here: [], inner: m ? [...names(m[1]!), "loop"] : ["loop"] };
    }
    case "set": {
      const m = /^\s*([^=]+?)\s*(=|$)/.exec(rest);
      return { here: m ? names(m[1]!) : [], inner: [] };
    }
    case "macro": {
      const m = /^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(rest);
      return { here: m ? [m[1]!] : [], inner: m ? [...m[2]!.split(",").map((p) => p.split("=")[0]!.trim()).filter(Boolean), "caller", "varargs", "kwargs"] : [] };
    }
    case "call":
      return { here: [], inner: ["caller"] };
    case "import": {
      const m = /\bas\s+([A-Za-z_]\w*)\s*$/.exec(rest);
      return { here: m ? [m[1]!] : [], inner: [] };
    }
    case "from": {
      const m = /\bimport\s+(.+)$/.exec(rest);
      const list = m ? m[1]!.split(",").map((p) => (/\bas\s+(\w+)/.exec(p)?.[1] ?? p.trim().split(/\s+/)[0]!)) : [];
      return { here: list.filter(Boolean), inner: [] };
    }
    default:
      return { here: [], inner: [] };
  }
}

/** The expression a tag evaluates: `if X`, `elif X`, `for … in X`, `set y = X`, `include X`. */
function tagExpression(token: Token): string | undefined {
  const name = tagName(token);
  const rest = token.inner.slice(name.length).trim();
  switch (name) {
    case "if":
    case "elif":
      return rest;
    case "for": {
      const m = /\s+in\s+(.+?)(\s+if\s+.+)?$/.exec(` ${rest}`);
      return m?.[1];
    }
    case "set": {
      const i = rest.indexOf("=");
      return i >= 0 ? rest.slice(i + 1) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Analyzes a template against the variables it will see. `vars` is what a
 * root name resolves in; local bindings (loop variables, `set`, macro
 * parameters) always resolve.
 */
export function analyze(source: string, vars: unknown): Analysis {
  const tokens = tokenize(source);
  const out: Analysis = { tokens, literal: [], warnings: [], segments: [], roots: [] };
  const scopes: Array<Set<string>> = [new Set()];
  const bound = (name: string) => scopes.some((s) => s.has(name)) || JINJA_GLOBALS.has(name);
  const warn = (code: WarningCode, token: Token, message: string) => out.warnings.push({ code, message, line: token.line, column: token.column });
  const text = (token: Token) => source.slice(token.start, token.end);

  /** Checks an expression; false when something in it cannot resolve. */
  const check = (expr: string, token: Token, kind: "output" | "subject"): boolean => {
    let refs: ExpressionRefs;
    try {
      refs = expressionRefs(expr);
    } catch {
      return true;
    }
    let ok = true;
    for (const f of refs.filters) {
      if (!JINJA_FILTERS.has(f)) {
        warn("unknown-helper", token, `Unknown filter "${f}" in ${text(token)}`);
        ok = false;
      }
    }
    for (const c of refs.calls) {
      if (!bound(c) && !resolvesIn(vars, [c])) {
        warn("unknown-helper", token, `Unknown function "${c}" in ${text(token)}`);
        ok = false;
      }
    }
    for (const path of refs.paths) {
      if (bound(path[0]!)) continue;
      out.roots.push({ name: path[0]!, line: token.line });
      // `x | default(…)` and `x is defined` are made for missing values.
      if (refs.filters.includes("default") || refs.filters.includes("d") || /\bis\s+(not\s+)?(defined|undefined|none)\b/.test(expr)) continue;
      if (!resolvesIn(vars, path)) {
        if (kind === "output") warn("unresolved", token, `Unresolved ${text(token)}`);
        else warn("unresolved", token, `Unresolved ${path.join(".")} in ${text(token)}; treated as empty`);
        ok = false;
      }
    }
    return ok;
  };

  const stack: Array<{ name: string; start: number }> = [];
  for (const token of tokens) {
    const top = stack.length === 0;
    if (token.kind === "text") {
      if (top) out.segments.push({ start: token.start, end: token.end, kind: "content" });
      continue;
    }
    if (token.kind === "comment") {
      // In copied text a comment is the author's text, not a template note.
      warn("unsupported", token, `Comments are kept as written: ${text(token)}`);
      out.literal.push([token.start, token.end]);
      if (top) out.segments.push({ start: token.start, end: token.end, kind: "content" });
      continue;
    }
    if (token.kind === "var") {
      if (!check(token.inner, token, "output")) out.literal.push([token.start, token.end]);
      if (top) out.segments.push({ start: token.start, end: token.end, kind: "expr" });
      continue;
    }
    const name = tagName(token);
    const expr = tagExpression(token);
    if (expr !== undefined) check(expr, token, "subject");
    const { here, inner } = bindings(token);
    for (const n of here) scopes.at(-1)!.add(n);
    const closes = Object.entries(BLOCKS).find(([, end]) => end === name)?.[0];
    if (name === "set" && !token.inner.includes("=")) {
      // {% set x %} … {% endset %}
      stack.push({ name: "set", start: token.start });
      scopes.push(new Set());
    } else if (name in BLOCKS) {
      stack.push({ name, start: token.start });
      scopes.push(new Set(inner));
    } else if (closes || name === "endset") {
      const open = stack.pop();
      scopes.pop();
      if (open && stack.length === 0) out.segments.push({ start: open.start, end: token.end, kind: "expr" });
    } else if (top) {
      out.segments.push({ start: token.start, end: token.end, kind: "expr" });
    }
  }
  // Unbalanced blocks: Nunjucks reports them when rendering; segments then cover everything.
  if (stack.length > 0) out.segments = [{ start: 0, end: source.length, kind: "expr" }];
  return out;
}

/** Wraps the literal ranges in `{% raw %}`, so Nunjucks prints them as written. */
export function applyLiteral(source: string, ranges: Array<[number, number]>, shift = 0): string {
  let out = "";
  let last = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const start = s - shift;
    const end = e - shift;
    if (start < last || start < 0 || end > source.length) continue;
    out += source.slice(last, start) + "{% raw %}" + source.slice(start, end) + "{% endraw %}";
    last = end;
  }
  return out + source.slice(last);
}
