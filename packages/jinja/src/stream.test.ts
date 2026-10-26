import { beforeAll, describe, expect, it } from "bun:test";
import { initJinja, JinjaError, renderJinja, streamJinja, type RenderJinjaOptions } from "./index.js";

beforeAll(() => initJinja());

const vars = {
  name: "ada",
  items: Array.from({ length: 30 }, (_, i) => ({ key: `A-${i + 1}`, pts: i % 4, tags: i % 3 ? ["x", "y"] : [] })),
  empty: [],
  nested: { a: { b: "deep" } },
};

const templates: Record<string, string> = {
  "base.md": "# {% block title %}Base{% endblock %}\n{% block body %}base body{% endblock %}\n-- {% block foot %}foot{% endblock %}\n",
  "mid.md": '{% extends "base.md" %}{% block title %}Mid {{ super() }}{% endblock %}{% block foot %}{% for i in items %}{{ i.key }} {% endfor %}{% endblock %}',
  "row.md": "- {{ i.key }} ({{ i.pts }}){% if i.tags %} {{ i.tags | join(',') }}{% endif %}\n",
  "rows.md": '{% for i in items %}{% include "row.md" %}{% endfor %}',
  "deep.md": '<{% include "rows.md" %}>',
  "macros.md": "{% macro badge(t) %}[{{ t | upper }}]{% endmacro %}",
  "child-of-includer.md": '{% extends "base.md" %}{% block body %}{% include "rows.md" %}{% endblock %}',
};

// Every template piece that writes output differently: statements, blocks,
// inheritance, includes, macros, captures, filter blocks, whitespace control.
const corpus: Array<[string, string]> = [
  ["plain text", "just text, no syntax"],
  ["expression", "Hi {{ name | upper }}!"],
  ["for/else and loop vars", "{% for i in items %}{{ loop.index }}/{{ loop.length }}:{{ i.key }}{% if not loop.last %}, {% endif %}{% else %}none{% endfor %}"],
  ["for over empty", "{% for i in empty %}x{% else %}none{% endfor %}"],
  ["if/elif/else", "{% for i in items %}{% if i.pts == 0 %}zero{% elif i.pts == 1 %}one{% else %}many{% endif %}\n{% endfor %}"],
  ["nested loops", "{% for i in items %}{% for t in i.tags %}{{ i.key }}.{{ t }};{% endfor %}{% endfor %}"],
  ["extends with blocks", '{% extends "base.md" %}{% block body %}{% for i in items %}{{ i.key }}\n{% endfor %}{% endblock %}'],
  ["text before extends is dropped", 'ignored {% extends "base.md" %}also ignored{% block title %}T{% endblock %}'],
  ["extends two levels with super", '{% extends "mid.md" %}{% block title %}Top / {{ super() }}{% endblock %}{% block body %}{{ super() }} + more{% endblock %}'],
  ["block without extends", "a{% block x %}{% for i in items %}{{ i.key }}{% endfor %}{% endblock %}b"],
  ["nested blocks", '{% extends "base.md" %}{% block body %}[{% block inner %}{% for i in items %}{{ i.pts }}{% endfor %}{% endblock %}]{% endblock %}'],
  ["include in a loop", '{% for i in items %}{% include "row.md" %}{% endfor %}'],
  ["nested include", 'start {% include "deep.md" %} end'],
  ["include of a template that extends", '({% include "child-of-includer.md" %})'],
  ["include in a block", '{% extends "base.md" %}{% block body %}{% include "rows.md" %}{% endblock %}'],
  ["import and macro", '{% import "macros.md" as m %}{% for i in items %}{{ m.badge(i.key) }}{% endfor %}'],
  ["macro with loop output", "{% macro list(xs) %}{% for x in xs %}<{{ x.key }}>{% endfor %}{% endmacro %}{{ list(items) }}|{{ list(items) | length }}"],
  ["caller", "{% macro wrap() %}[{{ caller() }}]{% endmacro %}{% call wrap() %}{% for i in items %}{{ i.key }}{% endfor %}{% endcall %}"],
  ["set capture", "{% set block %}{% for i in items %}{{ i.key }},{% endfor %}{% endset %}len={{ block | length }} {{ block }}"],
  ["filter block", "{% filter upper %}{% for i in items %}{{ i.key }} {% endfor %}{% endfilter %}"],
  ["whitespace control", "{% for i in items -%}\n  {{ i.key }}\n{%- endfor %}"],
  ["raw", "{% raw %}{{ not rendered }}{% endraw %} {{ name }}"],
  ["unresolved stays as written", "{{ name }} {{ missing.thing }} {{ nested.a.b }}"],
  ["document lines", "# Title\n{% for i in items %}\n- {{ i.key }}\n{% endfor %}\n{% if empty | length %}\nnever\n{% endif %}\nend\n"],
];

function streamed(source: string, options: RenderJinjaOptions & { flushBytes?: number }): { text: string; chunks: number } {
  const chunks: string[] = [];
  streamJinja(source, vars, (c) => chunks.push(c), { templates, ...options });
  return { text: chunks.join(""), chunks: chunks.length };
}

describe("streamJinja", () => {
  for (const lines of [false, true]) {
    for (const [name, source] of corpus) {
      it(`${name}${lines ? " (lines)" : ""}: chunks join to renderJinja's text`, () => {
        const expected = renderJinja(source, vars, { templates, lines }).text;
        for (const flushBytes of [1, 7, undefined]) expect(streamed(source, { lines, flushBytes }).text).toBe(expected);
      });
    }
  }

  it("writes while rendering instead of once at the end", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => `row ${i}`) };
    const chunks: string[] = [];
    streamJinja("{% for r in rows %}{{ r }}\n{% endfor %}", big, (c) => chunks.push(c));
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(16384 + 100);
    expect(chunks.join("")).toBe(big.rows.map((r) => `${r}\n`).join(""));
  });

  it("streams a block of an extending template and an include", () => {
    const counts = ['{% extends "base.md" %}{% block body %}{% for i in items %}{{ i.key }}{% endfor %}{% endblock %}', '{% include "rows.md" %}'].map(
      (source) => streamed(source, { flushBytes: 1 }).chunks,
    );
    for (const n of counts) expect(n).toBeGreaterThan(10);
  });

  it("throws on a template error after the text before it was written", () => {
    const chunks: string[] = [];
    expect(() => streamJinja('{% for i in items %}{{ i.key }}{% endfor %}{% include "missing.md" %}', vars, (c) => chunks.push(c), { templates, flushBytes: 1 })).toThrow(JinjaError);
    expect(chunks.join("")).toStartWith("A-1A-2");
  });

  it("passes on what the writer throws and stops", () => {
    let calls = 0;
    const full = new Error("disk full");
    expect(() =>
      streamJinja("{% for i in items %}{{ i.key }}{% endfor %}", vars, () => {
        calls++;
        throw full;
      }, { flushBytes: 1 }),
    ).toThrow(full);
    expect(calls).toBe(1);
  });

  it("leaves non-streaming renders untouched afterwards", () => {
    streamed('{% include "rows.md" %}', { flushBytes: 1 });
    expect(renderJinja('{% include "rows.md" %}', vars, { templates }).text).toStartWith("- A-1 (0) \n- A-2 (1) x,y\n");
  });

  it("gives a large model room: memory scales with its size", () => {
    const model = { findings: Array.from({ length: 20_000 }, (_, i) => ({ key: `P-${i}`, detail: "x".repeat(200) })) };
    let bytes = 0;
    streamJinja("{% for f in findings %}{{ f.key }} {{ f.detail }}\n{% endfor %}", model, (c) => (bytes += c.length));
    expect(bytes).toBe(20_000 * (2 + 1 + 200 + 1) + model.findings.reduce((n, f) => n + f.key.length - 2, 0));
  }, 60_000);
});
