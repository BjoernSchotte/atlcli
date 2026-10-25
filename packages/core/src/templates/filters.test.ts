import { beforeAll, describe, expect, test } from "bun:test";
import { getBuiltinVariables } from "./builtins.js";
import { createTemplateScope, initJinja, renderText } from "./render.js";

beforeAll(() => initJinja());

const run = (src: string, vars: Record<string, unknown> = {}) => renderText(src, createTemplateScope({ vars, now: new Date("2026-10-25T08:30:00.000Z") })).text;

describe("template filters (Jinja)", () => {
  test("dateAdd days, weeks, years", () => {
    expect(run("{{ '2026-12-30' | dateAdd(3, 'd') }}")).toBe("2027-01-02");
    expect(run("{{ '2026-10-25' | dateAdd(2, 'w') }}")).toBe("2026-11-08");
    expect(run("{{ '2028-02-29' | dateAdd(1, 'y') }}")).toBe("2029-02-28");
  });
  test("dateAdd months clamps to the month end; keeps datetimes; leaves invalid input", () => {
    expect(run("{{ '2026-01-31' | dateAdd(1, 'm') }}")).toBe("2026-02-28");
    expect(run("{{ '2026-11-30' | dateAdd(3, 'm') }}")).toBe("2027-02-28");
    expect(run("{{ '2026-10-25T10:00:00.000Z' | dateAdd(-1, 'd') }}")).toBe("2026-10-24T10:00:00.000Z");
    expect(run("{{ 'soon' | dateAdd(1, 'd') }}")).toBe("soon");
  });
  test("date formats calendar dates; today and now are built-ins", () => {
    expect(run("{{ today | date('DD.MM.YYYY') }} {{ today | dateAdd(14, 'd') }}")).toBe("25.10.2026 2026-11-08");
  });
  test("default, replace, lower/upper, comparisons", () => {
    expect(run("{{ x | default('fallback', true) }}", { x: "" })).toBe("fallback");
    expect(run("{{ x | default('fallback') }}", { x: "set" })).toBe("set");
    expect(run("{{ s | replace('2025', '2026') }}", { s: "Audit 2025 / 2025" })).toBe("Audit 2026 / 2026");
    expect(run("{{ s | upper }} {{ s | lower }}", { s: "Ab" })).toBe("AB ab");
    expect(run("{% if a == 'x' and not b %}y{% else %}n{% endif %}", { a: "x", b: false })).toBe("y");
  });
  test("variables win over built-ins of the same name", () => {
    expect(run("{{ year }}", { year: "1999" })).toBe("1999");
    expect(run("{{ year }}")).toBe("2026");
  });
});

describe("built-ins", () => {
  const now = new Date("2026-10-25T08:30:00.000Z");
  test("new built-ins with a fixed now", () => {
    const b = getBuiltinVariables({ now, project: "AUD" });
    expect(b.today).toBe(b.date);
    expect(b.now).toBe("2026-10-25T08:30:00.000Z");
    expect(b.datetime).toBe(b.now);
    expect(b.quarter).toBe("4");
    expect(b.week).toBe("43");
    expect(b.project).toBe("AUD");
  });
  test("ISO week at the year boundary", () => {
    expect(getBuiltinVariables({ now: new Date("2027-01-01T12:00:00Z") }).week).toBe("53");
  });
  test("uuid is stable for the same now and differs for another", () => {
    const a = getBuiltinVariables({ now }).uuid;
    expect(getBuiltinVariables({ now }).uuid).toBe(a);
    expect(getBuiltinVariables({ now: new Date("2026-10-26T00:00:00Z") }).uuid).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
