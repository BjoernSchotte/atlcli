/** Regression tests for the final review of the templating branch (PR #344). */
import { describe, expect, test, beforeAll } from "bun:test";
import { initJinja } from "@atlcli/jinja";
import { getBuiltinVariables } from "./builtins.js";
import { createTemplateScope, RenderBudget, RenderError, renderText } from "./render.js";
import { renderAdf } from "./adapters/adf.js";
import { renderStorage } from "./adapters/storage.js";
import { collectVariables } from "./adapters/index.js";

beforeAll(() => initJinja());

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]) => (marks.length ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text });

describe("1: expansion is bounded while rendering", () => {
  test("nested loops in text stop at the output limit", () => {
    const scope = createTemplateScope({ vars: { a: Array.from({ length: 60 }, (_, i) => i) } });
    const budget = new RenderBudget(100_000, 16_000_000, 100);
    expect(() => renderText("{% for x in a %}{% for y in a %}{% for z in a %}x{% endfor %}{% endfor %}{% endfor %}", scope, { budget })).toThrow(RenderError);
  });
  test("nested control paragraphs stop at the iteration cap", () => {
    const scope = createTemplateScope({ vars: { a: Array.from({ length: 50 }, (_, i) => i) } });
    const d = doc(p(t("{% for x in a %}")), p(t("{% for y in a %}")), p(t("{% for z in a %}")), p(t("plain")), p(t("{% endfor %}")), p(t("{% endfor %}")), p(t("{% endfor %}")));
    expect(() => renderAdf(d, scope, { unit: "d" })).toThrow(RenderError);
  });
});

describe("2: values are fully escaped in storage", () => {
  const scope = createTemplateScope({ vars: { v: "Tom&Jerry;", amp: "&amp;" } });
  test("& in a value always becomes &amp;", () => {
    expect(renderStorage("<p>{{ v }} {{ amp }}</p>", scope, { unit: "p" }).value).toBe("<p>Tom&amp;Jerry; &amp;amp;</p>");
  });
  test("an unknown named entity of the original survives a changed token", () => {
    expect(renderStorage("<p>wait&hellip; {{ amp }}</p>", scope, { unit: "p" }).value).toBe("<p>wait&hellip; &amp;amp;</p>");
  });
});

describe("3: paths and odd expressions stay literal", () => {
  const scope = createTemplateScope({ vars: { year: 1 } });
  test("../ outside a loop", () => {
    const out = renderText("see {{../config/app.yml}} and {{year}}", scope);
    expect(out.text).toBe("see {{../config/app.yml}} and 1");
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("this and . at the root", () => {
    expect(renderText("call {{this}} and {{.}} now", scope).text).toBe("call {{this}} and {{.}} now");
  });
});

describe("4: @uuid differs per seed", () => {
  test("same now, different seed", () => {
    const now = new Date("2026-10-25T00:00:00Z");
    const a = createTemplateScope({ now, seed: "SUP-1 summary" }).vars.uuid;
    expect(createTemplateScope({ now, seed: "SUP-1 summary" }).vars.uuid).toBe(a);
    expect(createTemplateScope({ now, seed: "SUP-2 summary" }).vars.uuid).not.toBe(a);
  });
});

describe("5: variable inference skips loop bodies", () => {
  test("loop variables are not root variables; outer names inside the loop are", () => {
    const d = doc(p(t("{% for s in systems %}")), p(t("{{ s.name }} by {{ s.owner }} for {{ lead }}")), p(t("{% endfor %}")), p(t("Contact {{ email }}")));
    const names = collectVariables([{ unit: "description", value: d }]).map((u) => u.name).sort();
    expect(names).toEqual(["email", "lead", "systems"]);
  });
});

describe("6: whitespace control and escapes keep marks", () => {
  const scope = createTemplateScope({ vars: { year: 2026 } });
  test("- trims without moving bold text", () => {
    expect(renderAdf(doc(p(t("Hello "), t("World", "strong"), t(" {{- year }}"))), scope, { unit: "d" }).value).toEqual(
      doc(p(t("Hello "), t("World", "strong"), t("2026"))),
    );
    expect(renderAdf(doc(p(t("{{ year -}} "), t("World", "strong"))), scope, { unit: "d" }).value).toEqual(doc(p(t("2026"), t("World", "strong"))));
  });
  test("raw keeps the bold text", () => {
    expect(renderAdf(doc(p(t("Hello "), t("World", "strong"), t(" {% raw %}{{ year }}{% endraw %} {{ year }}"))), scope, { unit: "d" }).value).toEqual(
      doc(p(t("Hello "), t("World", "strong"), t(" {{ year }} 2026"))),
    );
  });
});

describe("7: frozen dates do not depend on the machine's time zone", () => {
  test("built-ins use UTC for a frozen clock", () => {
    const b = getBuiltinVariables({ now: new Date("2025-12-31T23:30:00Z") });
    expect([b.today, b.year, b.month, b.day, b.time]).toEqual(["2025-12-31", "2025", "12", "31", "23:30"]);
  });
  test("the same in another time zone", () => {
    const code = `import { getBuiltinVariables } from ${JSON.stringify(new URL("./builtins.ts", import.meta.url).pathname)};
const b = getBuiltinVariables({ now: new Date("2026-01-01T00:00:00Z") });
console.log(JSON.stringify([b.today, b.year, b.quarter, b.week]));`;
    const proc = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TZ: "America/New_York" } });
    expect(JSON.parse(proc.stdout.toString())).toEqual(["2026-01-01", "2026", "1", "01"]);
  });
});

describe("8: a lone carriage return keeps offsets", () => {
  test("unresolved mustaches after \\r stay literal", () => {
    const scope = createTemplateScope({ vars: { year: 2026 } });
    expect(renderText("a\rb {{ nope }}\r{{ year }} {{ nope2 }}", scope).text).toBe("a\rb {{ nope }}\r2026 {{ nope2 }}");
  });
});
