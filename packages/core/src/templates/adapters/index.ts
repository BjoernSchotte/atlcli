import { analyze, hasJinjaSyntax } from "@atlcli/jinja";
import { BUILTIN_VARIABLE_NAMES } from "../builtins.js";
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

/** Operation context and built-ins, not user variables. */
const NOT_VARIABLES = new Set<string>(["source", "parent", ...BUILTIN_VARIABLE_NAMES]);

/**
 * Root variables a template uses, per unit: free names in expressions and
 * block subjects. Loop variables (also from control paragraphs that span
 * units), built-ins and operation context are not variables. Units that don't
 * parse are skipped.
 */
export function collectVariables(units: Array<{ unit: string; value: unknown; format?: BodyFormat }>): VariableUse[] {
  const uses: VariableUse[] = [];
  const seen = new Set<string>();
  const add = (name: string, unit: string, line: number) => {
    if (NOT_VARIABLES.has(name)) return;
    const key = `${unit}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    uses.push({ name, unit, line });
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
    // Control paragraphs open and close loops across units, in document order.
    const loops: string[][] = [];
    for (const raw of texts) {
      if (!hasJinjaSyntax(raw)) continue;
      const control = controlOf(raw);
      if (control?.kind === "close") {
        if (control.name === "for") loops.pop();
        continue;
      }
      if (control?.kind === "else") continue;
      const local = new Set(loops.flat());
      // A control paragraph alone doesn't parse; read its subject.
      const text = control?.kind === "open" || control?.kind === "elif" ? `{{ ${control.expr} }}` : raw;
      if (control?.kind === "open" && control.name === "for") loops.push([...control.names, "loop"]);
      let roots;
      try {
        roots = analyze(text, {}).roots;
      } catch {
        continue;
      }
      for (const r of roots) if (!local.has(r.name)) add(r.name, u.unit, r.line);
    }
  }
  return uses;
}
