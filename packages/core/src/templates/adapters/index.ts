import Handlebars from "handlebars";
import { TEMPLATE_HELPER_NAMES } from "../helpers.js";
import { finish, renderText, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";
import { adfTextUnits, renderAdf } from "./adf.js";
import { controlOf } from "./adf-blocks.js";
import { renderStorage, storageTextUnits } from "./storage.js";
import { renderWikiMarkup } from "./wikimarkup.js";

export type BodyFormat = "text" | "adf" | "storage" | "wikimarkup";

export interface VariableUse {
  name: string;
  unit: string;
  line?: number;
}

/** A string is plain text unless `format` says otherwise; an object is ADF. */
export function renderBody(
  value: unknown,
  scope: TemplateScope,
  opts: RenderOptions & { unit: string; format?: BodyFormat },
): { value: unknown; warnings: RenderWarning[] } {
  if (value === null || value === undefined) return { value, warnings: [] };
  const format = opts.format ?? (typeof value === "string" ? "text" : "adf");
  if (format === "adf") return renderAdf(value, scope, opts);
  if (typeof value !== "string") throw new TypeError(`${opts.unit}: a ${format} body must be a string`);
  if (format === "storage") return renderStorage(value, scope, opts);
  if (format === "wikimarkup") return renderWikiMarkup(value, scope, opts);
  const r = renderText(value, scope, { ...opts, strict: false });
  return finish(r.text, r.warnings, opts);
}

const HELPERS = new Set(TEMPLATE_HELPER_NAMES);
/** Operation context, not user variables. */
const CONTEXT = new Set(["source", "parent"]);

/**
 * Root variables a template uses, per unit: plain paths outside each/with
 * bodies, helper arguments and block subjects. Built-ins (`@…`), helpers and
 * operation context are not variables. Units that don't parse are skipped.
 */
export function collectVariables(units: Array<{ unit: string; value: unknown; format?: BodyFormat }>): VariableUse[] {
  const uses: VariableUse[] = [];
  const seen = new Set<string>();
  /** Inside a loop (`scoped`) only `@root.x` names a run variable; plain paths are item fields. */
  const add = (expr: hbs.AST.Expression | undefined, unit: string, line: number, scoped = false) => {
    if (!expr) return;
    if (expr.type === "SubExpression") {
      for (const p of (expr as hbs.AST.SubExpression).params) add(p, unit, line, scoped);
      return;
    }
    if (expr.type !== "PathExpression") return;
    const path = expr as hbs.AST.PathExpression;
    const name = path.parts[0];
    // `@root.x` names a run variable from inside a loop.
    if (path.data && name === "root" && path.parts[1]) return addName(path.parts[1], unit, line);
    if (scoped || path.data || path.depth > 0 || !name || CONTEXT.has(name)) return;
    addName(name, unit, line);
  };
  const addName = (name: string, unit: string, line: number) => {
    if (CONTEXT.has(name)) return;
    const key = `${unit}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    uses.push({ name, unit, line });
  };
  const walk = (body: hbs.AST.Statement[], unit: string, scoped: boolean) => {
    for (const s of body) {
      const line = s.loc.start.line;
      if (s.type === "MustacheStatement") {
        const m = s as hbs.AST.MustacheStatement;
        if (m.params.length > 0) m.params.forEach((p) => add(p, unit, line, scoped));
        else if (m.path.type === "SubExpression") add(m.path, unit, line, scoped);
        else if (!HELPERS.has((m.path as hbs.AST.PathExpression).original)) add(m.path, unit, line, scoped);
      } else if (s.type === "BlockStatement") {
        const b = s as hbs.AST.BlockStatement;
        b.params.forEach((p) => add(p, unit, line, scoped));
        walk(b.program.body, unit, scoped || ["each", "with"].includes((b.path as hbs.AST.PathExpression).original));
        if (b.inverse) walk(b.inverse.body, unit, scoped);
      }
    }
  };
  for (const u of units) {
    const format = u.format ?? (typeof u.value === "string" ? "text" : "adf");
    const texts =
      u.value === null || u.value === undefined
        ? []
        : format === "adf"
          ? adfTextUnits(u.value)
          : format === "storage"
            ? storageTextUnits(String(u.value))
            : [String(u.value)];
    // Control paragraphs open and close blocks across units, in document order.
    const blocks: string[] = [];
    for (const raw of texts) {
      if (!raw.includes("{{")) continue;
      const inLoop = blocks.some((b) => b === "each" || b === "with");
      const control = controlOf(raw);
      if (control?.kind === "close") {
        if (blocks.at(-1) === control.name) blocks.pop();
        continue;
      }
      if (control?.kind === "else") continue;
      // A control paragraph alone ("{{#each systems}}") doesn't parse; read its subject.
      const text = control?.kind === "open" ? `{{__subject ${control.expr}}}` : raw;
      if (control?.kind === "open") blocks.push(control.name);
      let program: hbs.AST.Program;
      try {
        program = Handlebars.parse(text);
      } catch {
        continue;
      }
      walk(program.body, u.unit, inLoop);
    }
  }
  return uses;
}
