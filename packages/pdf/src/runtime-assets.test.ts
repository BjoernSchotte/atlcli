import { describe, expect, it } from "bun:test";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";

describe("PDF_RUNTIME_ASSETS", () => {
  it("contains the canonical unique fonts and licenses", () => {
    expect(PDF_RUNTIME_ASSETS.fonts).toHaveLength(12);
    expect(new Set(PDF_RUNTIME_ASSETS.fonts.map((font) => font.fileName)).size).toBe(12);
    expect(PDF_RUNTIME_ASSETS.fonts.every((font) => /^[a-f0-9]{64}$/.test(font.sha256))).toBe(true);
    expect(PDF_RUNTIME_ASSETS.licenses.map((license) => license.fileName)).toEqual([
      "LICENSE-Source-Sans-3.txt",
      "LICENSE-Source-Serif-4.txt",
      "LICENSE-Source-Code-Pro.txt",
      "LICENSE-Noto-Sans-Symbols-2.txt",
      "LICENSE-Noto-Emoji.txt",
    ]);
    expect(PDF_RUNTIME_ASSETS.compilerLicense.fileName).toBe("LICENSE");
  });
});
