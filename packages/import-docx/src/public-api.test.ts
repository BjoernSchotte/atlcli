import { describe, expect, it } from "bun:test";
import * as docxImport from "./index.js";

describe("@atlcli/import-docx public boundary", () => {
  it("owns DOCX parsing without re-exporting the source-neutral core", () => {
    expect(typeof docxImport.parseDocx).toBe("function");
    for (const movedExport of [
      "canonicalJson",
      "documentToAdf",
      "documentToStorage",
      "buildImportPreview",
      "renderImportPreview",
      "assessEditability",
    ]) {
      expect(docxImport).not.toHaveProperty(movedExport);
    }
  });
});
