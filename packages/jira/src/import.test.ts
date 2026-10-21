import { describe, expect, test } from "bun:test";
import { parseCsv } from "./import.js";

describe("parseCsv", () => {
  test("quoted cells may span lines (regression: split on newline broke markdown descriptions)", () => {
    const csv = 'summary,description\n"First","# Heading\n\n- one\n- two"\nSecond,plain\n';
    const issues = parseCsv(csv);
    expect(issues.map((i) => i.fields.summary)).toEqual(["First", "Second"]);
    expect(issues[0]!.fields.description).toBe("# Heading\n\n- one\n- two");
  });

  test("doubled quotes, CRLF and blank lines", () => {
    const issues = parseCsv('summary,labels\r\n"Say ""hi""","a, b"\r\n\r\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.fields.summary).toBe('Say "hi"');
    expect(issues[0]!.fields.labels).toEqual(["a", "b"]);
  });

  test("--map-field renames columns before mapping", () => {
    const issues = parseCsv("Title,Kind\nFix it,Bug\n", { fieldMap: { Title: "summary", Kind: "issuetype" } });
    expect(issues[0]!.fields).toMatchObject({ summary: "Fix it", issuetype: { name: "Bug" } });
  });

  test("--map-field with an unknown column fails loudly", () => {
    expect(() => parseCsv("summary\nx\n", { fieldMap: { Nope: "summary" } })).toThrow(/Nope/);
  });
});
