import { describe, expect, test } from "bun:test";
import { createTemplateScope } from "../render.js";
import { renderAdf } from "./adf.js";
import { controlOf } from "./adf-blocks.js";

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
    expect(controlOf(" {{#each systems}} ")).toEqual({ kind: "open", name: "each", expr: "systems" });
    expect(controlOf("{{#if (eq a \"b\")}}")).toEqual({ kind: "open", name: "if", expr: '(eq a "b")' });
    expect(controlOf("{{else}}")).toEqual({ kind: "else" });
    expect(controlOf("{{/with}}")).toEqual({ kind: "close", name: "with" });
    expect(controlOf("{{#if a}}x{{/if}}")).toBeUndefined();
    expect(controlOf("{{year}}")).toBeUndefined();
  });
});

describe("ADF control paragraphs", () => {
  test("if/else over sibling paragraphs at doc level", () => {
    expect(render(doc(p("{{#if internal}}"), p("A"), p("{{else}}"), p("B"), p("{{/if}}"), p("C"))).value).toEqual(doc(p("A"), p("C")));
  });
  test("unless and if on missing values", () => {
    expect(render(doc(p("{{#unless internal}}"), p("A"), p("{{/unless}}"))).value).toEqual(doc());
    const out = render(doc(p("{{#if missing}}"), p("A"), p("{{/if}}")));
    expect(out.value).toEqual(doc());
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("each repeats siblings with this, @index, @first, @last", () => {
    expect(render(doc(p("{{#each systems}}"), p("{{@index}} {{this}}{{#if @last}}!{{/if}}"), p("{{/each}}"))).value).toEqual(
      doc(p("0 IAM"), p("1 Backup!")),
    );
  });
  test("each over an empty list renders else", () => {
    expect(render(doc(p("{{#each none}}"), p("x"), p("{{else}}"), p("nothing"), p("{{/each}}"))).value).toEqual(doc(p("nothing")));
  });
  test("each over list items", () => {
    expect(render(doc(ul(li("{{#each systems}}"), li("{{this}}"), li("{{/each}}")))).value).toEqual(doc(ul(li("IAM"), li("Backup"))));
  });
  test("each over table rows", () => {
    const d = doc(
      table(
        row(cell("System"), cell("Owner")),
        row(cell("{{#each systems}}"), cell("")),
        row(cell("{{this}}"), cell("{{@root.owners.IAM}}")),
        row(cell("{{/each}}"), cell("")),
      ),
    );
    expect(render(d).value).toEqual(
      doc(table(row(cell("System"), cell("Owner")), row(cell("IAM"), cell("Ann")), row(cell("Backup"), cell("Ann")))),
    );
  });
  test("controls inside a panel and nested each in if", () => {
    const panel = (...content: unknown[]) => ({ type: "panel", attrs: { panelType: "info" }, content });
    expect(
      render(doc(panel(p("{{#if internal}}"), p("{{#each systems}}"), p("{{this}}"), p("{{/each}}"), p("{{/if}}")))).value,
    ).toEqual(doc(panel(p("IAM"), p("Backup"))));
  });
  test("with switches this", () => {
    const s = createTemplateScope({ vars: { lead: { name: "Ann" } } });
    expect(renderAdf(doc(p("{{#with lead}}"), p("{{name}}"), p("{{/with}}")), s, { unit: "d" }).value).toEqual(doc(p("Ann")));
  });
  test("unbalanced blocks stay literal with a warning", () => {
    const d = doc(p("{{#if internal}}"), p("A"));
    const out = render(d);
    expect(out.value).toEqual(d);
    expect(out.warnings.some((w) => w.code === "unbalanced-block")).toBe(true);
  });
  test("crossing blocks stay literal", () => {
    const d = doc(p("{{#if internal}}"), p("{{#each systems}}"), p("{{/if}}"), p("{{/each}}"));
    expect(render(d).value).toEqual(d);
  });
});
