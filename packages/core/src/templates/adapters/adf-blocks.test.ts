import { describe, expect, test, beforeAll } from "bun:test";
import { initJinja } from "@atlcli/jinja";
import { createTemplateScope } from "../render.js";
import { renderAdf } from "./adf.js";
import { controlOf } from "./adf-blocks.js";

beforeAll(() => initJinja());

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const li = (text: string) => ({ type: "listItem", content: [p(text)] });
const ul = (...items: unknown[]) => ({ type: "bulletList", content: items });
const cell = (text: string) => ({ type: "tableCell", content: [p(text)] });
const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
const table = (...rows: unknown[]) => ({ type: "table", content: rows });
const scope = createTemplateScope({ vars: { internal: true, systems: ["IAM", "Backup"], owners: { IAM: "Ann" }, none: [] } });
const render = (d: unknown) => renderAdf(d, scope, { unit: "d" });

describe("controlOf", () => {
  test("recognises block controls only", () => {
    expect(controlOf(" {% for s in systems %} ")).toEqual({ kind: "open", name: "for", expr: "systems", names: ["s"] });
    expect(controlOf("{% for k, v in owners %}")).toEqual({ kind: "open", name: "for", expr: "owners", names: ["k", "v"] });
    expect(controlOf('{%- if a == "b" -%}')).toEqual({ kind: "open", name: "if", expr: 'a == "b"' });
    expect(controlOf("{% elif b %}")).toEqual({ kind: "elif", expr: "b" });
    expect(controlOf("{% else %}")).toEqual({ kind: "else" });
    expect(controlOf("{% endfor %}")).toEqual({ kind: "close", name: "for" });
    expect(controlOf("{% if a %}x{% endif %}")).toBeUndefined();
    expect(controlOf("{{ year }}")).toBeUndefined();
  });
});

describe("ADF control paragraphs", () => {
  test("if/else over sibling paragraphs at doc level", () => {
    expect(render(doc(p("{% if internal %}"), p("A"), p("{% else %}"), p("B"), p("{% endif %}"), p("C"))).value).toEqual(doc(p("A"), p("C")));
  });
  test("elif chains", () => {
    const d = (v: string) => renderAdf(doc(p("{% if v == 'a' %}"), p("A"), p("{% elif v == 'b' %}"), p("B"), p("{% else %}"), p("C"), p("{% endif %}")), createTemplateScope({ vars: { v } }), { unit: "d" }).value;
    expect([d("a"), d("b"), d("z")]).toEqual([doc(p("A")), doc(p("B")), doc(p("C"))]);
  });
  test("not and if on missing values", () => {
    expect(render(doc(p("{% if not internal %}"), p("A"), p("{% endif %}"))).value).toEqual(doc());
    const out = render(doc(p("{% if missing %}"), p("A"), p("{% endif %}")));
    expect(out.value).toEqual(doc());
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("for repeats siblings with the loop variable and loop", () => {
    expect(render(doc(p("{% for s in systems %}"), p("{{ loop.index0 }} {{ s }}{% if loop.last %}!{% endif %}"), p("{% endfor %}"))).value).toEqual(
      doc(p("0 IAM"), p("1 Backup!")),
    );
  });
  test("for over an empty list renders else", () => {
    expect(render(doc(p("{% for s in none %}"), p("x"), p("{% else %}"), p("nothing"), p("{% endfor %}"))).value).toEqual(doc(p("nothing")));
  });
  test("for over list items", () => {
    expect(render(doc(ul(li("{% for s in systems %}"), li("{{ s }}"), li("{% endfor %}")))).value).toEqual(doc(ul(li("IAM"), li("Backup"))));
  });
  test("for over table rows, and over a dict", () => {
    const d = doc(
      table(
        row(cell("System"), cell("Owner")),
        row(cell("{% for s in systems %}"), cell("")),
        row(cell("{{ s }}"), cell("{{ owners.IAM }}")),
        row(cell("{% endfor %}"), cell("")),
      ),
    );
    expect(render(d).value).toEqual(
      doc(table(row(cell("System"), cell("Owner")), row(cell("IAM"), cell("Ann")), row(cell("Backup"), cell("Ann")))),
    );
    expect(render(doc(p("{% for system, owner in owners %}"), p("{{ system }}: {{ owner }}"), p("{% endfor %}"))).value).toEqual(doc(p("IAM: Ann")));
  });
  test("controls inside a panel and nested for in if", () => {
    const panel = (...content: unknown[]) => ({ type: "panel", attrs: { panelType: "info" }, content });
    expect(
      render(doc(panel(p("{% if internal %}"), p("{% for s in systems %}"), p("{{ s }}"), p("{% endfor %}"), p("{% endif %}")))).value,
    ).toEqual(doc(panel(p("IAM"), p("Backup"))));
  });
  test("unbalanced blocks stay literal with a warning", () => {
    const d = doc(p("{% if internal %}"), p("A"));
    const out = render(d);
    expect(out.value).toEqual(d);
    expect(out.warnings.some((w) => w.code === "unbalanced-block")).toBe(true);
  });
  test("crossing blocks stay literal", () => {
    const d = doc(p("{% if internal %}"), p("{% for s in systems %}"), p("{% endif %}"), p("{% endfor %}"));
    expect(render(d).value).toEqual(d);
  });
});
