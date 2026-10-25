/**
 * Plain-text values: summaries, labels, names and custom fields. A value is
 * checked against its field type only after rendering changed it, so an
 * untemplated value never fails here.
 */
import { hasJinjaSyntax } from "@atlcli/jinja";
import { RenderError, renderText, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";

export type FieldKind = "summary" | "label" | "string" | "number" | "date" | "option" | "name";

export function checkFieldValue(kind: FieldKind, value: string, unit: string): void {
  const bad = (why: string): never => {
    throw new RenderError(`${unit}: ${why} (got "${value}")`);
  };
  if ((kind === "summary" || kind === "name" || kind === "option") && value.trim() === "") bad("must not be empty after rendering");
  if (kind === "label" && (value === "" || /\s/.test(value))) bad("labels cannot be empty or contain whitespace");
  if (kind === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) bad("is not a number");
  if (kind === "date") {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
      bad("is not a YYYY-MM-DD date");
    }
  }
}

export function renderTextField(
  value: string,
  kind: FieldKind,
  scope: TemplateScope,
  opts: RenderOptions & { unit: string },
): { value: string; warnings: RenderWarning[] } {
  const { text, warnings } = renderText(value, scope, opts);
  if (text !== value) checkFieldValue(kind, text, opts.unit);
  return { value: text, warnings };
}

/**
 * A Jira field value of any shape: strings, `{ value }` options, `{ name }`
 * versions/components, arrays of those. Other objects (users, cascading
 * selects) are kept as they are, with a note when they hold a placeholder.
 */
export function renderJiraFieldValue(
  value: unknown,
  schemaType: string | undefined,
  scope: TemplateScope,
  opts: RenderOptions & { unit: string },
): { value: unknown; warnings: RenderWarning[] } {
  const warnings: RenderWarning[] = [];
  const text = (v: string, kind: FieldKind) => {
    const r = renderTextField(v, kind, scope, opts);
    warnings.push(...r.warnings);
    return r.value;
  };
  const one = (v: unknown): unknown => {
    if (typeof v === "string") return text(v, schemaType === "date" ? "date" : "string");
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(one);
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.value === "string") return { value: text(o.value, "option") };
    if (keys.length === 1 && typeof o.name === "string") return { name: text(o.name, "name") };
    if (hasJinjaSyntax(JSON.stringify(v))) {
      warnings.push({ code: "not-rendered-field", message: `${opts.unit}: this field type is not rendered; copied as is`, unit: opts.unit });
    }
    return v;
  };
  return { value: one(value), warnings };
}
