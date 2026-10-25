/** Regression tests for the minor findings deferred from the templating review (PR #344). */
import { describe, expect, test, beforeAll } from "bun:test";
import { initJinja } from "@atlcli/jinja";
import { createTemplateScope, renderSegments, renderText } from "./render.js";
import { renderAdf } from "./adapters/adf.js";
import { renderStorage } from "./adapters/storage.js";
import { renderWikiMarkup } from "./adapters/wikimarkup.js";

beforeAll(() => initJinja());

const scope = createTemplateScope({ vars: { year: 2026, items: ["a", "b"] } });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]) => (marks.length ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text });
const cell = (...content: unknown[]) => ({ type: "tableCell", content });

describe("backslashes have no special meaning", () => {
  test("a backslash before an expression stays, the expression renders", () => {
    expect(renderText("C:\\{{ year }}", scope).text).toBe("C:\\2026");
    expect(renderText("C:\\{{ nope }}", scope).text).toBe("C:\\{{ nope }}");
  });
  test("segments keep an unresolved expression literal too", () => {
    expect(renderSegments("C:\\{{ nope }}", scope).segments.map((s) => s.output).join("")).toBe("C:\\{{ nope }}");
  });
});

describe("Jinja comments", () => {
  test("stay as written, with a warning", () => {
    const out = renderText("keep {# x #} {#- y -#} end {{ year }}", scope);
    expect(out.text).toBe("keep {# x #} {#- y -#} end 2026");
    expect(out.warnings.map((w) => w.code)).toEqual(["unsupported", "unsupported"]);
  });
  test("stay in rich text", () => {
    const r = renderAdf(doc(p(t("keep {# x #} "), t("end", "strong"))), scope, { unit: "d" });
    expect(JSON.stringify(r.value)).toContain("keep {# x #} ");
    expect(r.warnings[0]!.code).toBe("unsupported");
  });
  test("a comment alone on a line keeps the line", () => {
    expect(renderText("a\n{# x #}\nb", scope).text).toBe("a\n{# x #}\nb");
    expect(renderSegments("a\n{# x #}\nb", scope).segments.map((s) => s.output).join("")).toBe("a\n{# x #}\nb");
  });
});

describe("control rows with content in other cells", () => {
  test("ADF warns when a removed control row held content", () => {
    const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
    const d = doc({
      type: "table",
      content: [row(cell(p(t("{% for i in items %}"))), cell(p(t("LOST")))), row(cell(p(t("{{ i }}")))), row(cell(p(t("{% endfor %}"))), cell({ type: "paragraph" }))],
    });
    const r = renderAdf(d, scope, { unit: "d" });
    expect(r.warnings.map((w) => w.code)).toEqual(["dropped-content"]);
    expect(r.warnings[0]!.message).toContain("LOST");
  });
  test("storage warns when a removed control row held content", () => {
    const s = "<table><tbody><tr><td><p>{% for i in items %}</p></td><td>LOST</td></tr><tr><td>{{ i }}</td></tr><tr><td>{% endfor %}</td><td><p> </p></td></tr></tbody></table>";
    const r = renderStorage(s, scope, { unit: "page" });
    expect(r.value).toBe("<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>");
    expect(r.warnings.map((w) => w.code)).toEqual(["dropped-content"]);
  });
});

describe("warning positions", () => {
  test("wiki markup warnings count lines and columns in the whole text", () => {
    const r = renderWikiMarkup("line one\n{code}x{code} {{ nope }}\n{{ nah }}", scope, { unit: "d" });
    expect(r.warnings.map((w) => [w.line, w.column])).toEqual([
      [2, 14],
      [3, 0],
    ]);
  });
  test("rich text warnings carry no run-relative position", () => {
    const r = renderAdf(doc(p(t("first")), p(t("x {{ nope }}"))), scope, { unit: "d" });
    expect(r.warnings[0]!.line).toBeUndefined();
    expect(renderStorage("<p>a</p><p>x {{ nope }}</p>", scope, { unit: "p" }).warnings[0]!.column).toBeUndefined();
  });
});
