/**
 * Jira wiki markup (Data Center descriptions and comments). Plain text, with
 * {code} and {noformat} regions left alone. `{{monospace}}` collides with the
 * template syntax; tolerant mode keeps unknown names literal, and
 * `{% raw %}…{% endraw %}` keeps anything else as written.
 */
import { hasJinjaSyntax } from "@atlcli/jinja";
import { finish, RenderBudget, renderText, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";

const CODE = /\{(code|noformat)(?::[^}]*)?\}[\s\S]*?\{\1\}/g;

export function renderWikiMarkup(text: string, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] } {
  if (!hasJinjaSyntax(text)) return { value: text, warnings: [] };
  const inner = { ...opts, strict: false, budget: opts.budget ?? new RenderBudget() };
  const warnings: RenderWarning[] = [];
  let out = "";
  let last = 0;
  const render = (part: string) => {
    const r = renderText(part, scope, inner);
    // Positions count from the part; shift them to the whole text.
    const before = text.slice(0, last).split(/\r\n?|\n/);
    const line = before.length - 1;
    const column = before.at(-1)!.length;
    for (const w of r.warnings) {
      warnings.push(w.line === undefined ? w : { ...w, line: w.line + line, column: (w.column ?? 0) + (w.line === 1 ? column : 0) });
    }
    return r.text;
  };
  for (const m of text.matchAll(CODE)) {
    out += render(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  out += render(text.slice(last));
  return finish(out, warnings, opts);
}
