import { beforeAll, describe, expect, it } from "bun:test";
import { analyze, evaluateJinja, expressionRefs, initJinja, JinjaError, renderJinja, renderJinjaSegments, tokenize } from "./index.js";

beforeAll(() => initJinja());

describe("renderJinja", () => {
  it("renders the full language: filters, loops, macros, set, arithmetic, inheritance", () => {
    const vars = { name: "ada", items: [{ key: "A-1", pts: 3 }, { key: "A-2", pts: 5 }] };
    expect(renderJinja("Hi {{ name | upper }}", vars).text).toBe("Hi ADA");
    expect(renderJinja("{% for i in items %}{{ loop.index }}:{{ i.key }}{% if not loop.last %}, {% endif %}{% endfor %}", vars).text).toBe("1:A-1, 2:A-2");
    expect(renderJinja("{{ items | sum('pts') if items else 0 }}", vars).text).toBe("8");
    expect(renderJinja("{% set total = items | length %}{{ total * 2 }}", vars).text).toBe("4");
    expect(renderJinja("{% macro b(t) %}**{{ t }}**{% endmacro %}{{ b(name) }}", vars).text).toBe("**ada**");
    const templates = { "base.md": "# {% block title %}Base{% endblock %}\n{% block body %}{% endblock %}", "row.md": "- {{ i.key }}" };
    expect(
      renderJinja('{% extends "base.md" %}{% block title %}Audit{% endblock %}{% block body %}{% for i in items %}{% include "row.md" %}\n{% endfor %}{% endblock %}', vars, { templates }).text,
    ).toBe("# Audit\n- A-1\n- A-2\n");
  });

  it("keeps unresolved expressions as written and reports them", () => {
    const r = renderJinja("Release {{ version }} for {{ source.key }} by {{ who.name }}", { version: "2026.11", source: {} });
    expect(r.text).toBe("Release 2026.11 for {{ source.key }} by {{ who.name }}");
    expect(r.warnings.map((w) => [w.code, w.message, w.line, w.column])).toEqual([
      ["unresolved", "Unresolved {{ source.key }}", 1, 26],
      ["unresolved", "Unresolved {{ who.name }}", 1, 46],
    ]);
  });

  it("does not report what is meant to be missing, or what is bound locally", () => {
    const r = renderJinja("{{ x | default('none') }} {% if y is defined %}y{% endif %} {% for a in [1, 2] %}{{ a }}{% endfor %} {% set z = 1 %}{{ z }}", {});
    expect(r).toEqual({ text: "none  12 1", warnings: [] });
  });

  it("warns about unknown filters and functions and keeps the expression", () => {
    const r = renderJinja("{{ name | shout }} {{ nope(1) }}", { name: "a" });
    expect(r.text).toBe("{{ name | shout }} {{ nope(1) }}");
    expect(r.warnings.map((w) => w.code)).toEqual(["unknown-helper", "unknown-helper"]);
  });

  it("keeps Jinja comments as text (copied content, not template notes)", () => {
    const r = renderJinja("Heading {#anchor#} {{ a }}", { a: 1 });
    expect(r.text).toBe("Heading {#anchor#} 1");
    expect(r.warnings[0]!.code).toBe("unsupported");
  });

  it("leaves broken templates as they are, with a warning", () => {
    expect(renderJinja("{% if a %}open", { a: 1 })).toMatchObject({ text: "{% if a %}open", warnings: [{ code: "parse-error" }] });
    expect(renderJinja("{{ a", { a: 1 })).toMatchObject({ text: "{{ a", warnings: [{ code: "parse-error", message: "Unclosed {{" }] });
  });

  it("atlcli filters: date and dateAdd on calendar dates", () => {
    expect(renderJinja("{{ d | date('DD.MM.YYYY') }} {{ d | dateAdd(1, 'm') }} {{ e | dateAdd(2, 'w') }}", { d: "2026-01-31", e: "2026-10-25" }).text).toBe(
      "31.01.2026 2026-02-28 2026-11-08",
    );
  });

  it("is sandboxed: template code cannot reach the host", () => {
    const r = renderJinja(`{{ "".constructor.constructor("return typeof process + typeof Bun + typeof require")() }}`, {});
    expect(r.text).toBe("undefinedundefinedundefined");
  });

  it("stops runaway templates at the time limit and recovers", () => {
    expect(() => renderJinja("{% for i in range(100000000) %}{% endfor %}", {}, { limits: { timeoutMs: 200 } })).toThrow(JinjaError);
    expect(renderJinja("{{ 1 + 1 }}", {}).text).toBe("2");
  });

  it("lines: a line holding only a block tag disappears; exact mode keeps every character", () => {
    const src = "a\n{% if x %}\n  b\n{% endif %}\nc";
    expect(renderJinja(src, { x: true }, { lines: true }).text).toBe("a\n  b\nc");
    expect(renderJinja(src, { x: true }).text).toBe("a\n\n  b\n\nc");
  });

  it("renders untemplated text without touching it", () => {
    expect(renderJinja("plain { text } }}", {})).toEqual({ text: "plain { text } }}", warnings: [] });
  });
});

describe("renderJinjaSegments", () => {
  it("maps output to top-level pieces; a block is one piece", () => {
    const r = renderJinjaSegments("A {{ x }} B {% if y %}yes {{ x }}{% endif %}!", { x: 1, y: true });
    expect(r.segments.map((s) => [s.kind, s.output])).toEqual([
      ["content", "A "],
      ["expr", "1"],
      ["content", " B "],
      ["expr", "yes 1"],
      ["content", "!"],
    ]);
  });

  it("set carries across pieces", () => {
    expect(renderJinjaSegments("{% set n = 2 %}a{{ n }}", {}).segments.map((s) => s.output)).toEqual(["", "a", "2"]);
  });
});

describe("evaluateJinja", () => {
  it("returns values, and undefined with a warning when unresolved", () => {
    expect(evaluateJinja("items | length", { items: [1, 2] }).value).toBe(2);
    expect(evaluateJinja("items", { items: [{ a: 1 }] }).value).toEqual([{ a: 1 }]);
    expect(evaluateJinja("missing", {})).toMatchObject({ value: undefined, warnings: [{ code: "unresolved", message: "Unresolved {{ missing }}; treated as empty" }] });
  });
});

describe("analysis", () => {
  it("tokenizes with positions and keeps raw bodies as text", () => {
    const t = tokenize("a\n {{ b }}{% raw %}{{ c }}{% endraw %}");
    expect(t.map((x) => [x.kind, x.inner, x.line, x.column])).toEqual([
      ["text", "a\n ", 1, 0],
      ["var", "b", 2, 1],
      ["tag", "raw", 2, 8],
      ["text", "{{ c }}", 2, 17],
      ["tag", "endraw", 2, 24],
    ]);
  });

  it("finds paths, filters and calls in expressions", () => {
    expect(expressionRefs(`source.fields["summary"] | truncate(10) ~ x if y is not none else f(a=b.c)`)).toEqual({
      paths: [["source", "fields", "summary"], ["x"], ["y"], ["b", "c"]],
      filters: ["truncate"],
      calls: ["f"],
    });
  });

  it("collects free roots, not loop variables", () => {
    expect(analyze("{% for i in items %}{{ i.key }} {{ title }}{% endfor %}", {}).roots.map((r) => r.name)).toEqual(["items", "title"]);
  });
});
