import { describe, expect, it } from "bun:test";
import { escapeTypstContent, escapeTypstString, typstLabel } from "./escape.js";

describe("Typst escaping", () => {
  it("escapes markup metacharacters", () => {
    expect(escapeTypstContent("# * _ $ @ < > [ ] ` \\")).toBe(
      "\\# \\* \\_ \\$ \\@ \\< \\> \\[ \\] \\` \\\\"
    );
  });

  it("escapes string literals and control characters", () => {
    expect(escapeTypstString('a\\b\n"c"')).toBe('a\\\\b\\n\\"c\\"');
  });

  it("creates stable non-empty labels", () => {
    expect(typstLabel("Überblick & Ziele")).toBe("uberblick-ziele");
    expect(typstLabel("!!!")).toBe("section");
  });
});
