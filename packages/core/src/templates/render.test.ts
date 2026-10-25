import { describe, expect, test } from "bun:test";
import { childScope, createTemplateScope, evaluateExpression, RenderBudget, RenderError, renderSegments, renderText } from "./render.js";

const now = new Date("2026-10-25T08:30:00.000Z");
const scope = createTemplateScope({
  vars: { year: 2026, customer: "ACME", systems: ["IAM", "Backup"] },
  now,
  source: { key: "TPL-1", summary: "Check" },
});
const r = (src: string, opts = {}) => renderText(src, scope, opts);

describe("renderText", () => {
  test("variables, operation context and built-ins", () => {
    expect(r("Audit {{year}} for {{customer}}: {{source.key}} on {{@today}}").text).toBe("Audit 2026 for ACME: TPL-1 on 2026-10-25");
    expect(r("{{#each systems}}{{@index}}={{this}} {{/each}}").text).toBe("0=IAM 1=Backup ");
    expect(r('{{dateAdd @today 7 "d"}}').text).toBe("2026-11-01");
  });
  test("adjacent numeric values are concatenated, not added", () => {
    expect(r("{{year}}{{year}}").text).toBe("20262026");
    expect(renderText("{{#each n}}{{a}}{{b}}{{/each}}", createTemplateScope({ vars: { n: [{ a: 1, b: 2 }] } })).text).toBe("12");
  });
  test("text without {{ is returned unchanged with no warnings", () => {
    expect(r("plain & <text>")).toEqual({ text: "plain & <text>", warnings: [] });
  });
  test("an unknown path stays literal with a positioned warning", () => {
    const out = r("Hi {{custmer}}!\nBye {{a.b}}", { unit: "summary" });
    expect(out.text).toBe("Hi {{custmer}}!\nBye {{a.b}}");
    expect(out.warnings.map((w) => [w.code, w.unit, w.line, w.column])).toEqual([
      ["unresolved", "summary", 1, 3],
      ["unresolved", "summary", 2, 4],
    ]);
  });
  test("an unknown helper call stays literal", () => {
    const out = r('{{shout customer "!"}}');
    expect(out.text).toBe('{{shout customer "!"}}');
    expect(out.warnings[0]!.code).toBe("unknown-helper");
  });
  test("Handlebars' own lookup and log helpers are not exposed", () => {
    expect(r("{{lookup systems 0}}").text).toBe("{{lookup systems 0}}");
  });
  test("an unknown block helper stays literal in full, including else", () => {
    const src = "{{#loop systems}}x{{else}}y{{/loop}}";
    expect(r(src).text).toBe(src);
  });
  test("if on an unknown path is falsy and warns", () => {
    const out = r("{{#if nope}}a{{else}}b{{/if}}");
    expect(out.text).toBe("b");
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("a parse error keeps the whole unit literal", () => {
    const src = "{{ x | default('a') }} and {{year}}";
    const out = r(src);
    expect(out.text).toBe(src);
    expect(out.warnings.map((w) => w.code)).toEqual(["parse-error"]);
  });
  test("keeps Jinja and Helm snippets literal", () => {
    for (const src of ["{{ item.name }}", "{{ .Values.image.tag }}", "{% if x %}{{ y }}{% endif %}"]) {
      expect(r(src).text).toBe(src);
    }
  });
  test("an escaped mustache stays literal without a backslash", () => {
    expect(r("\\{{year}} is {{year}}").text).toBe("{{year}} is 2026");
  });
  test("triple stash renders unescaped like double", () => {
    expect(renderText("{{{v}}}", createTemplateScope({ vars: { v: "<b>" } })).text).toBe("<b>");
    expect(renderText("{{v}}", createTemplateScope({ vars: { v: "<b>&" } })).text).toBe("<b>&");
  });
  test("partials are not supported", () => {
    const out = r("{{> header}}");
    expect(out.text).toBe("{{> header}}");
    expect(out.warnings[0]!.code).toBe("unsupported");
  });
  test("prototype access is blocked", () => {
    expect(r("{{constructor.constructor}}").text).toBe("{{constructor.constructor}}");
    expect(r("{{__proto__}}").text).toBe("{{__proto__}}");
    expect(r("{{year.constructor}}").text).toBe("{{year.constructor}}");
  });
  test("strict turns warnings into a RenderError", () => {
    expect(() => r("{{nope}}", { strict: true })).toThrow(RenderError);
  });
  test("output limit per unit and per run", () => {
    const big = createTemplateScope({ vars: { xs: Array.from({ length: 2000 }, () => "x".repeat(1000)) } });
    expect(() => renderText("{{#each xs}}{{this}}{{/each}}", big)).toThrow(/output limit/);
    const budget = new RenderBudget(1_000_000, 1500);
    renderText("{{year}}".repeat(200), scope, { budget });
    expect(() => renderText("x".repeat(1000) + "{{year}}", scope, { budget })).toThrow(/output limit/);
  });
  test("paths inside each and with resolve against the item", () => {
    const s = createTemplateScope({ vars: { rows: [{ name: "a" }, { name: "b" }], year: 1 } });
    expect(renderText("{{#each rows}}{{name}}{{@root.year}}{{/each}}", s).text).toBe("a1b1");
  });
});

describe("renderSegments", () => {
  test("one segment per top-level statement with source offsets", () => {
    const { segments } = renderSegments("a {{year}} b", scope);
    expect(segments).toEqual([
      { start: 0, end: 2, output: "a " },
      { start: 2, end: 10, output: "2026" },
      { start: 10, end: 12, output: " b" },
    ]);
  });
});

describe("evaluateExpression", () => {
  test("returns typed values", () => {
    expect(evaluateExpression("systems", scope).value).toEqual(["IAM", "Backup"]);
    expect(evaluateExpression('(eq customer "ACME")', scope).value).toBe(true);
  });
  test("unknown path is undefined with a warning", () => {
    const out = evaluateExpression("nope", scope);
    expect(out.value).toBeUndefined();
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("childScope exposes @root and loop data", () => {
    const c = childScope(scope, "IAM", { index: 0, first: true, last: false });
    expect(renderText("{{this}}/{{@index}}/{{@root.customer}}", c).text).toBe("IAM/0/ACME");
  });
});
