import { describe, expect, test, beforeAll } from "bun:test";
import { initJinja } from "@atlcli/jinja";
import { createTemplateScope, RenderError } from "../render.js";
import { checkFieldValue, renderJiraFieldValue, renderTextField } from "./text.js";

beforeAll(() => initJinja());

const scope = createTemplateScope({ vars: { year: 2026, empty: "", team: "ops team" } });
const opts = { unit: "TPL-1 summary" };

describe("text adapter", () => {
  test("renders a summary", () => {
    expect(renderTextField("Audit {{year}}", "summary", scope, opts).value).toBe("Audit 2026");
  });
  test("rejects an empty summary", () => {
    expect(() => renderTextField("{{empty}}", "summary", scope, opts)).toThrow(RenderError);
  });
  test("rejects a label with whitespace", () => {
    expect(() => renderTextField("{{team}}", "label", scope, { unit: "labels" })).toThrow(/whitespace/);
  });
  test("an untemplated value is not re-checked", () => {
    expect(renderTextField("has space", "label", scope, { unit: "labels" }).value).toBe("has space");
  });
  test("number and date fields are checked after rendering", () => {
    expect(() => checkFieldValue("number", "12x", "f")).toThrow(RenderError);
    expect(() => checkFieldValue("date", "2026-13-01", "f")).toThrow(RenderError);
    expect(() => checkFieldValue("date", "2026-10-25", "f")).not.toThrow();
  });
  test("custom field shapes", () => {
    expect(renderJiraFieldValue({ value: "Q{{year}}" }, "option", scope, opts).value).toEqual({ value: "Q2026" });
    expect(renderJiraFieldValue([{ name: "R{{year}}" }], "array", scope, opts).value).toEqual([{ name: "R2026" }]);
    expect(renderJiraFieldValue(5, "number", scope, opts).value).toBe(5);
    expect(renderJiraFieldValue("{{nope}}", "string", scope, opts).warnings[0]!.code).toBe("unresolved");
  });
  test("unsupported shapes with placeholders are kept and noted", () => {
    const out = renderJiraFieldValue({ accountId: "{{x}}" }, "user", scope, opts);
    expect(out.value).toEqual({ accountId: "{{x}}" });
    expect(out.warnings[0]!.code).toBe("not-rendered-field");
  });
});
