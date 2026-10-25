import { describe, expect, test } from "bun:test";
import { parseVarsFile, resolveTemplateValues, unusedVariables } from "./vars-file.js";

describe("vars file", () => {
  test("full form", () => {
    const f = parseVarsFile(
      "variables:\n  year: { type: number, required: true }\n  quarter: { type: select, options: [Q1, Q2], default: Q1 }\nvalues:\n  year: 2026\n  systems: [IAM]\n",
    );
    expect(f.variables).toEqual([
      { name: "year", type: "number", required: true },
      { name: "quarter", type: "select", default: "Q1", options: ["Q1", "Q2"] },
    ]);
    expect(f.values).toEqual({ year: 2026, systems: ["IAM"] });
  });
  test("short form is values only", () => {
    expect(parseVarsFile("year: 2026\n")).toEqual({ variables: [], values: { year: 2026 } });
    expect(parseVarsFile("")).toEqual({ variables: [], values: {} });
  });
  test("rejects a non-object document and bad declarations", () => {
    expect(() => parseVarsFile("- a\n")).toThrow(/mapping/);
    expect(() => parseVarsFile("variables:\n  x: { type: color }\n")).toThrow(/x.*type/);
    expect(() => parseVarsFile("variables:\n  x: { type: select }\n")).toThrow(/options/);
  });
});

describe("resolveTemplateValues", () => {
  const declarations = [
    { name: "year", type: "number" as const, required: true },
    { name: "quarter", type: "select" as const, options: ["Q1", "Q2"], default: "Q1" },
    { name: "kickoff", type: "date" as const },
  ];
  test("precedence cli > file > default, with type conversion", () => {
    const r = resolveTemplateValues({ cli: { year: "2027" }, file: { variables: [], values: { year: 2026, quarter: "Q2" } }, declarations });
    expect(r.values).toEqual({ year: 2027, quarter: "Q2" });
    expect(r.missing).toEqual([]);
    expect(resolveTemplateValues({ cli: {}, declarations: declarations.slice(1) }).values).toEqual({ quarter: "Q1" });
  });
  test("declared required without a value is missing; a bad select is an error", () => {
    const r = resolveTemplateValues({ cli: { quarter: "Q9" }, declarations });
    expect(r.missing.map((v) => v.name)).toEqual(["year"]);
    expect(r.errors[0]).toMatch(/quarter/);
  });
  test("file declarations win over operation declarations", () => {
    const r = resolveTemplateValues({ cli: {}, file: { variables: [{ name: "year", type: "string" }], values: {} }, declarations });
    expect(r.missing).toEqual([]);
  });
  test("undeclared and structured values pass through", () => {
    expect(resolveTemplateValues({ cli: { a: "x", rows: [{ n: 1 }] } }).values).toEqual({ a: "x", rows: [{ n: 1 }] });
  });
  test("unused variables", () => {
    expect(unusedVariables({ year: 1, yaer: 2 }, [], new Set(["year"]))).toEqual(["yaer"]);
  });
});
