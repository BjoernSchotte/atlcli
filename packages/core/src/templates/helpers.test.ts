import { describe, expect, test } from "bun:test";
import { createTemplateHandlebars, TEMPLATE_HELPER_NAMES } from "./helpers.js";
import { getBuiltinVariables } from "./builtins.js";

const run = (src: string, ctx: unknown = {}, data: Record<string, unknown> = {}) =>
  createTemplateHandlebars().compile(src, { noEscape: true })(ctx, { data });

describe("template helpers", () => {
  test("registers exactly the documented helpers", () => {
    expect([...TEMPLATE_HELPER_NAMES].sort()).toEqual(
      ["and", "dateAdd", "default", "eq", "formatDate", "lowercase", "ne", "not", "or", "replace", "uppercase"],
    );
  });
  test("dateAdd days, weeks, years", () => {
    expect(run('{{dateAdd "2026-12-30" 3 "d"}}')).toBe("2027-01-02");
    expect(run('{{dateAdd "2026-10-25" 2 "w"}}')).toBe("2026-11-08");
    expect(run('{{dateAdd "2028-02-29" 1 "y"}}')).toBe("2029-02-28");
  });
  test("dateAdd months clamps to the month end", () => {
    expect(run('{{dateAdd "2026-01-31" 1 "m"}}')).toBe("2026-02-28");
    expect(run('{{dateAdd "2026-11-30" 3 "m"}}')).toBe("2027-02-28");
  });
  test("dateAdd keeps an ISO datetime a datetime", () => {
    expect(run('{{dateAdd "2026-10-25T10:00:00.000Z" -1 "d"}}')).toBe("2026-10-24T10:00:00.000Z");
  });
  test("dateAdd on an invalid date returns the input unchanged", () => {
    expect(run('{{dateAdd "soon" 1 "d"}}')).toBe("soon");
  });
  test("default, replace", () => {
    expect(run('{{default x "fallback"}}', { x: "" })).toBe("fallback");
    expect(run('{{default x "fallback"}}', { x: "set" })).toBe("set");
    expect(run('{{replace s "2025" "2026"}}', { s: "Audit 2025 / 2025" })).toBe("Audit 2026 / 2026");
  });
  test("comparison helpers in if", () => {
    expect(run('{{#if (eq a "x")}}y{{else}}n{{/if}}', { a: "x" })).toBe("y");
    expect(run('{{#if (ne a "x")}}y{{else}}n{{/if}}', { a: "x" })).toBe("n");
    expect(run("{{#if (and a b c)}}y{{else}}n{{/if}}", { a: 1, b: 1, c: 0 })).toBe("n");
    expect(run("{{#if (or a b)}}y{{else}}n{{/if}}", { a: 0, b: "1" })).toBe("y");
    expect(run("{{#if (not a)}}y{{else}}n{{/if}}", { a: false })).toBe("y");
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
