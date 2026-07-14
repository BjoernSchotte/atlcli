import { describe, expect, it } from "bun:test";
import {
  DocxError,
  MAX_TEMPLATE_BYTES,
  scanTemplate,
  unzipDocx,
} from "../../utils/docx/scan.js";
import { buildDocx, para, runSplitPara } from "./fixtures.js";

describe("scanTemplate", () => {
  it("classifies supported / unsupported / never placeholders", () => {
    const bytes = buildDocx({
      body:
        para("$scroll.title") +
        para("$scroll.space.name") +
        para("$scroll.pageowner.fullName") +
        para("$scroll.custom.(k15t-scroll-document-versions-for-confluence,document-id)") +
        para("$adhocState") +
        para("$scroll.content"),
    });
    const scan = scanTemplate(bytes);

    const supported = scan.supported.map((h) => h.base).sort();
    const unsupported = scan.unsupported.map((h) => h.base).sort();
    const never = scan.never.map((h) => h.base).sort();

    expect(supported).toEqual(["$scroll.space.name", "$scroll.title"]);
    expect(unsupported).toEqual(["$scroll.pageowner.fullName"]);
    expect(never).toEqual(["$adhocState", "$scroll.custom"]);
    expect(scan.hasContentPlaceholder).toBe(true);
    // $scroll.content is not listed as a placeholder hit.
    expect([...supported, ...unsupported, ...never]).not.toContain("$scroll.content");
  });

  it("detects a placeholder split across multiple runs (run normalization)", () => {
    const bytes = buildDocx({
      // Word split "$scroll.title" across three runs.
      body: runSplitPara(["$scr", "oll.", "title"]),
    });
    const scan = scanTemplate(bytes);
    expect(scan.supported.map((h) => h.base)).toContain("$scroll.title");
  });

  it("scans header and footer parts", () => {
    const bytes = buildDocx({
      body: para("body"),
      header: para("$scroll.title"),
      footer: runSplitPara(["$scroll.exporter", ".fullName"]),
    });
    const scan = scanTemplate(bytes);
    const bases = scan.supported.map((h) => h.base).sort();
    expect(bases).toContain("$scroll.title");
    expect(bases).toContain("$scroll.exporter.fullName");
    expect(scan.parts).toContain("word/header1.xml");
    expect(scan.parts).toContain("word/footer1.xml");
  });

  it("captures the raw form incl. date argument and counts occurrences", () => {
    const bytes = buildDocx({
      body: para('$scroll.exportdate.("dd.MM.yyyy")') + para("$scroll.exportdate"),
    });
    const scan = scanTemplate(bytes);
    const hit = scan.supported.find((h) => h.base === "$scroll.exportdate");
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(2);
    expect(hit!.raw).toContain('$scroll.exportdate.("dd.MM.yyyy")');
  });

  it("rejects a non-zip buffer (corrupt upload)", () => {
    const notZip = new TextEncoder().encode("this is definitely not a zip file");
    expect(() => unzipDocx(notZip)).toThrow(DocxError);
    try {
      unzipDocx(notZip);
    } catch (err) {
      expect((err as DocxError).kind).toBe("not-zip");
    }
  });

  it("rejects a zip that is not a Word document", () => {
    // A valid zip lacking word/document.xml.
    const PizZip = require("pizzip");
    const zip = new PizZip();
    zip.file("hello.txt", "hi");
    const bytes = zip.generate({ type: "uint8array" });
    try {
      unzipDocx(bytes);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DocxError);
      expect((err as DocxError).kind).toBe("not-docx");
    }
  });

  it("rejects an oversized upload without unzipping", () => {
    const big = new Uint8Array(MAX_TEMPLATE_BYTES + 1);
    try {
      unzipDocx(big);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DocxError).kind).toBe("too-large");
    }
  });
});
