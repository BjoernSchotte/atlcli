import { describe, expect, test } from "bun:test";
import { stripControlChars } from "./utils.js";

describe("stripControlChars", () => {
  test("drops escape sequences' control bytes, keeps tab, newline and text", () => {
    expect(stripControlChars("a\u001b]0;pwned\u0007b\tc\nd\re\u009bf ü")).toBe("a]0;pwnedb\tc\ndef ü");
  });

  test("keeps SGR color sequences, drops cursor movement", () => {
    expect(stripControlChars("\u001b[31mred\u001b[0m\u001b[2Ax")).toBe("\u001b[31mred\u001b[0m[2Ax");
  });
});
