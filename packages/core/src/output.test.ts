import { describe, expect, test } from "bun:test";
import { ERROR_CODES, describeError, stripControlChars } from "./utils.js";

describe("describeError", () => {
  test("an API error's status picks the code: from `status` or from the message", () => {
    expect(describeError(Object.assign(new Error("x"), { status: 403 }))).toEqual({ code: ERROR_CODES.FORBIDDEN, message: "x", details: { status: 403 } });
    expect(describeError(new Error("Jira API error (404): Not Found")).code).toBe(ERROR_CODES.NOT_FOUND);
    expect(describeError(new Error("Confluence API error (401): no")).code).toBe(ERROR_CODES.AUTH);
    expect(describeError(new Error("Jira API error (429): slow down")).code).toBe(ERROR_CODES.RATE_LIMIT);
    expect(describeError(new Error("Jira API error (500): boom")).details).toEqual({ status: 500 });
  });
  test("anything else is a plain API error without details", () => {
    expect(describeError("boom")).toEqual({ code: ERROR_CODES.API, message: "boom", details: {} });
  });
});

describe("stripControlChars", () => {
  test("drops escape sequences' control bytes, keeps tab, newline and text", () => {
    expect(stripControlChars("a\u001b]0;pwned\u0007b\tc\nd\re\u009bf ü")).toBe("a]0;pwnedb\tc\ndef ü");
  });

  test("keeps SGR color sequences, drops cursor movement", () => {
    expect(stripControlChars("\u001b[31mred\u001b[0m\u001b[2Ax")).toBe("\u001b[31mred\u001b[0m[2Ax");
  });
});
