import { describe, expect, test } from "bun:test";
import { createTemplateScope } from "../render.js";
import { renderAdf } from "./adf.js";
import { distribute } from "./runs.js";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]) =>
  marks.length ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text };
const scope = createTemplateScope({
  vars: { customer: "ACME", year: 2026, empty: "", html: "<b>&</b>" },
  source: { key: "TPL-7" },
});
const opts = { unit: "TPL-1 description" };
const render = (d: unknown) => renderAdf(d, scope, opts);

describe("distribute", () => {
  test("unchanged segments stay in place, changed ones go to their start piece", () => {
    expect(
      distribute(
        ["a {{cus", "tomer}} b"],
        [
          { start: 0, end: 2, output: "a " },
          { start: 2, end: 13, output: "ACME" },
          { start: 13, end: 15, output: " b" },
        ],
      ),
    ).toEqual(["a ACME", " b"]);
  });
});

describe("renderAdf", () => {
  test("returns the same object when nothing is templated", () => {
    const d = doc(p(t("plain")));
    expect(render(d).value).toBe(d);
  });
  test("renders a placeholder split across marks", () => {
    const out = render(doc(p(t("for {{cus"), t("tomer}}", "strong"), t(" now"))));
    expect(out.value).toEqual(doc(p(t("for ACME"), t(" now"))));
  });
  test("keeps marks of a placeholder inside one node", () => {
    expect(render(doc(p(t("{{customer}}", "em")))).value).toEqual(doc(p(t("ACME", "em"))));
  });
  test("renders headings, nested lists and table cells", () => {
    const h = { type: "heading", attrs: { level: 2 }, content: [t("Audit {{year}}")] };
    const list = { type: "bulletList", content: [{ type: "listItem", content: [p(t("{{customer}}"))] }] };
    expect(render(doc(h, list)).value).toEqual(
      doc({ ...h, content: [t("Audit 2026")] }, { type: "bulletList", content: [{ type: "listItem", content: [p(t("ACME"))] }] }),
    );
  });
  test("inserts markup as plain text", () => {
    expect(render(doc(p(t("{{html}}")))).value).toEqual(doc(p(t("<b>&</b>"))));
  });
  test("drops text nodes that render empty", () => {
    expect(render(doc(p(t("x"), t("{{empty}}", "strong")))).value).toEqual(doc(p(t("x"))));
  });
  test("never renders code marks or code blocks", () => {
    const d = doc(p(t("{{customer}}", "code")), { type: "codeBlock", content: [t("{{customer}}")] });
    expect(render(d).value).toEqual(d);
  });
  test("mentions are boundaries; a crossing expression stays literal", () => {
    const mention = { type: "mention", attrs: { id: "1", text: "@Ann" } };
    const d = doc(p(t("hi {{custo"), mention, t("mer}}")));
    const out = render(d);
    expect(out.value).toEqual(d);
    expect(out.warnings.some((w) => w.code === "crosses-inline-node")).toBe(true);
  });
  test("renders around a mention", () => {
    const mention = { type: "mention", attrs: { id: "1", text: "@Ann" } };
    expect(render(doc(p(t("{{customer}} "), mention, t(" {{year}}")))).value).toEqual(doc(p(t("ACME "), mention, t(" 2026"))));
  });
  test("renders link hrefs and keeps invalid results", () => {
    const link = (href: string) => ({ type: "text", text: "issue", marks: [{ type: "link", attrs: { href } }] });
    expect(render(doc(p(link("https://x.atlassian.net/browse/{{source.key}}")))).value).toEqual(
      doc(p(link("https://x.atlassian.net/browse/TPL-7"))),
    );
    const bad = render(doc(p(link("{{customer}}"))));
    expect(bad.value).toEqual(doc(p(link("{{customer}}"))));
    expect(bad.warnings[0]!.code).toBe("invalid-url");
  });
  test("round-trips a Jinja description unchanged apart from warnings", () => {
    const d = doc(p(t("Run with {{ item.name }} and {{ x | default('a') }}")));
    const out = render(d);
    expect(out.value).toEqual(d);
    expect(out.warnings.length).toBeGreaterThan(0);
  });
  test("strict fails on any warning", () => {
    expect(() => renderAdf(doc(p(t("{{nope}}"))), scope, { ...opts, strict: true })).toThrow(/strict/);
  });
});
