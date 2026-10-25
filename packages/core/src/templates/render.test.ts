import { beforeAll, describe, expect, test } from "bun:test";
import { initJinja } from "@atlcli/jinja";
import { childScope, createTemplateScope, evaluateExpression, RenderBudget, RenderError, renderSegments, renderText } from "./render.js";

beforeAll(() => initJinja());

const now = new Date("2026-10-25T08:30:00.000Z");
const scope = createTemplateScope({
  vars: { year: 2026, customer: "ACME", systems: ["IAM", "Backup"] },
  now,
  source: { key: "TPL-1", summary: "Check" },
});
const r = (src: string, opts = {}) => renderText(src, scope, opts);

describe("renderText", () => {
  test("variables, operation context and built-ins", () => {
    expect(r("Audit {{ year }} for {{ customer }}: {{ source.key }} on {{ today }}").text).toBe("Audit 2026 for ACME: TPL-1 on 2026-10-25");
    expect(r("{% for s in systems %}{{ loop.index0 }}={{ s }} {% endfor %}").text).toBe("0=IAM 1=Backup ");
    expect(r("{{ today | dateAdd(7, 'd') }}").text).toBe("2026-11-01");
  });
  test("adjacent numeric values are concatenated, not added", () => {
    expect(r("{{ year }}{{ year }}").text).toBe("20262026");
    expect(renderText("{% for x in n %}{{ x.a }}{{ x.b }}{% endfor %}", createTemplateScope({ vars: { n: [{ a: 1, b: 2 }] } })).text).toBe("12");
  });
  test("text without template syntax is returned unchanged with no warnings", () => {
    expect(r("plain & <text> { braces }")).toEqual({ text: "plain & <text> { braces }", warnings: [] });
  });
  test("an unknown path stays literal with a positioned warning", () => {
    const out = r("Hi {{ custmer }}!\nBye {{ a.b }}", { unit: "summary" });
    expect(out.text).toBe("Hi {{ custmer }}!\nBye {{ a.b }}");
    expect(out.warnings.map((w) => [w.code, w.unit, w.line, w.column])).toEqual([
      ["unresolved", "summary", 1, 3],
      ["unresolved", "summary", 2, 4],
    ]);
  });
  test("an unknown filter or function stays literal", () => {
    const out = r("{{ customer | shout }} {{ lookup(systems, 0) }}");
    expect(out.text).toBe("{{ customer | shout }} {{ lookup(systems, 0) }}");
    expect(out.warnings.map((w) => w.code)).toEqual(["unknown-helper", "unknown-helper"]);
  });
  test("a block on an unknown subject stays literal in full, with a warning", () => {
    const src = "{% if nope %}a{% else %}b{% endif %} and {% for i in items %}{{ i }}{% endfor %}";
    const out = r(src);
    expect(out.text).toBe(src);
    expect(out.warnings.map((w) => w.code)).toEqual(["unresolved", "unresolved"]);
  });
  test("a parse error keeps the whole unit literal", () => {
    const src = "{% if year %}open and {{ year }}";
    const out = r(src);
    expect(out.text).toBe(src);
    expect(out.warnings.map((w) => w.code)).toEqual(["parse-error"]);
  });
  test("keeps someone else's templates in copied text (Ansible, Helm) literal", () => {
    for (const src of ["{{ item.name }}", "{{ .Values.image.tag }}", "{% if x %}{{ y }}{% endif %}", "{% for h in groups['web'] %}{{ h }}{% endfor %}"]) {
      expect(r(src).text).toBe(src);
    }
  });
  test("raw keeps template syntax as written", () => {
    expect(r("{% raw %}{{ year }}{% endraw %} is {{ year }}").text).toBe("{{ year }} is 2026");
  });
  test("output is never HTML-escaped", () => {
    expect(renderText("{{ v }}", createTemplateScope({ vars: { v: "<b>&" } })).text).toBe("<b>&");
  });
  test("comments are kept as written, with a warning", () => {
    const out = r("Title {#anchor#}");
    expect(out.text).toBe("Title {#anchor#}");
    expect(out.warnings[0]!.code).toBe("unsupported");
  });
  test("prototype access is blocked", () => {
    expect(r("{{ constructor.constructor }}").text).toBe("{{ constructor.constructor }}");
    expect(r("{{ __proto__ }}").text).toBe("{{ __proto__ }}");
  });
  test("strict turns warnings into a RenderError", () => {
    expect(() => r("{{ nope }}", { strict: true })).toThrow(RenderError);
  });
  test("output limit per unit and per run", () => {
    const big = createTemplateScope({ vars: { xs: Array.from({ length: 2000 }, () => "x".repeat(1000)) } });
    expect(() => renderText("{% for x in xs %}{{ x }}{% endfor %}", big)).toThrow(/output limit/);
    const budget = new RenderBudget(1_000_000, 1500);
    renderText("{{ year }}".repeat(200), scope, { budget });
    expect(() => renderText("x".repeat(1000) + "{{ year }}", scope, { budget })).toThrow(/output limit/);
  });
  test("a runaway template ends with a RenderError", () => {
    expect(() => r("{% for i in range(1000000000) %}{% endfor %}")).toThrow(RenderError);
  });
  test("loop variables and outer names resolve inside loops", () => {
    const s = createTemplateScope({ vars: { rows: [{ name: "a" }, { name: "b" }], year: 1 } });
    expect(renderText("{% for row in rows %}{{ row.name }}{{ year }}{% endfor %}", s).text).toBe("a1b1");
  });
});

describe("renderSegments", () => {
  test("one segment per top-level piece with source offsets", () => {
    const { segments } = renderSegments("a {{ year }} b", scope);
    expect(segments).toEqual([
      { start: 0, end: 2, output: "a ", kind: "content" },
      { start: 2, end: 12, output: "2026", kind: "expr" },
      { start: 12, end: 14, output: " b", kind: "content" },
    ]);
  });
});

describe("evaluateExpression", () => {
  test("returns typed values", () => {
    expect(evaluateExpression("systems", scope).value).toEqual(["IAM", "Backup"]);
    expect(evaluateExpression('customer == "ACME"', scope).value).toBe(true);
  });
  test("unknown path is undefined with a warning", () => {
    const out = evaluateExpression("nope", scope);
    expect(out.value).toBeUndefined();
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("childScope adds loop variables on top of the outer names", () => {
    const c = childScope(scope, { system: "IAM", loop: { index: 1, first: true } });
    expect(renderText("{{ system }}/{{ loop.index }}/{{ customer }}", c).text).toBe("IAM/1/ACME");
  });
});
