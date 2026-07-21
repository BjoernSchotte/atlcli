/**
 * `w:updateFields` is set only when a refresh would change something.
 *
 * The defect: `ensureUpdateFields` ran unconditionally, so a real 62-page tree
 * export with NO table of contents, 116 static `HYPERLINK` fields and one
 * caption `SEQ` asked its reader — on every single open, forever — to refresh
 * fields that mostly cannot change. The engine now decides per document, from
 * the fields the FINISHED archive actually carries.
 *
 * Real archives throughout: every case builds a `.docx` with the in-process
 * fixture builder, runs the real export, and reads `word/settings.xml` back out
 * of the produced bytes. No HTTP anywhere — `deps` are plain local functions.
 */
import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import type { ConfluencePageDetails, TableCell } from "@atlcli/confluence";
import { exportDocx } from "./export.js";
import { collectFieldKeywords, DocxError, needsFieldRefresh, unzipDocx } from "./scan.js";
import { buildDocx, headingStyle, para, readPart, stylesXml } from "./fixtures.js";

const template = { name: "fixture.docx", modificationDate: new Date(2026, 6, 14) };
const deps = {
  getSpace: async () => ({ id: "s", key: "ENG", name: "Engineering", type: "global" as const }),
  getCurrentUser: async () => ({ accountId: "u", displayName: "Björn Schotte" }),
  getPageOwner: async () => ({ accountId: "u-9", displayName: "Olga Owner" }),
};

function page(storage: string): ConfluencePageDetails {
  return {
    id: "123",
    title: "Field Refresh Fixture",
    url: "https://x.atlassian.net/wiki/spaces/ENG/pages/123",
    version: 1,
    spaceKey: "ENG",
    storage,
    created: "2026-01-02T10:00:00.000Z",
    modified: "2026-06-30T12:30:00.000Z",
    createdBy: { displayName: "Alice Author" },
    modifiedBy: { displayName: "Mel Modifier" },
    labels: [],
  };
}

/** The shape of the reported defect: prose whose only fields are hyperlinks. */
const LINKS_ONLY =
  "<h1>Overview</h1>" +
  "<p>See <a href='https://example.com/a'>a</a>, <a href='https://example.com/b'>b</a>.</p>";

const styles = stylesXml(headingStyle("Heading1", "Heading 1"));

/**
 * A complex field whose INSTRUCTION is split across several `<w:instrText>`
 * runs — Word's ordinary rsid-driven output, and the shape a naive
 * per-element regex misses. Kept local to this file: the fixture module's
 * `complexFieldResult` deliberately emits one instruction run.
 */
function splitInstrField(segments: string[], result: string): string {
  const runs = segments
    .map((s) => `<w:r><w:instrText xml:space="preserve">${s}</w:instrText></w:r>`)
    .join("");
  return (
    `<w:p>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    runs +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t xml:space="preserve">${result}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `</w:p>`
  );
}

/** A `<w:fldSimple>` field — the other field encoding besides fldChar/instrText. */
function fldSimpleField(instr: string, result: string): string {
  return (
    `<w:p><w:fldSimple w:instr="${instr}">` +
    `<w:r><w:t xml:space="preserve">${result}</w:t></w:r>` +
    `</w:fldSimple></w:p>`
  );
}

/** A one-paragraph table cell. */
function cell(text: string): TableCell {
  return {
    header: false,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** The `w:val` of `word/settings.xml`'s `<w:updateFields>`, or `undefined`. */
function updateFieldsValue(bytes: Uint8Array): string | undefined {
  const settings = readPart(bytes, "word/settings.xml");
  return /<w:updateFields\b[^>]*\bw:val="([^"]*)"/.exec(settings)?.[1];
}

describe("collectFieldKeywords (pure)", () => {
  it("reads the keyword of a fldSimple and of a complex field", () => {
    const xml =
      fldSimpleField(' PAGE \\* MERGEFORMAT ', "1") +
      splitInstrField([' SEQ Figure \\* ARABIC '], "1");
    expect(collectFieldKeywords(xml)).toEqual(["PAGE", "SEQ"]);
  });

  it("reassembles an instruction split across runs (` TO` + `C \\o \"1-3\"`)", () => {
    const xml = splitInstrField([" TO", 'C \\o "1-3" ', "\\h \\z \\u "], "TOC placeholder");
    expect(collectFieldKeywords(xml)).toEqual(["TOC"]);
  });

  it("does NOT match a keyword that appears inside another field's ARGUMENT", () => {
    // The failure mode of a whole-part keyword sweep: `\bSEQ\b` matches the URL,
    // `\bINDEX\b` matches `index.html`, and a document of pure hyperlinks would
    // keep prompting — the defect, re-created through the matcher.
    const xml =
      splitInstrField([' HYPERLINK "https://example.com/seq/123" '], "seq") +
      splitInstrField([' HYPERLINK "https://example.com/docs/index.html" '], "docs") +
      splitInstrField([' HYPERLINK "https://example.com/ref/date/time" '], "ref");
    expect(collectFieldKeywords(xml)).toEqual(["HYPERLINK", "HYPERLINK", "HYPERLINK"]);
  });

  it("does not spell a keyword across the seam between two adjacent fields", () => {
    // Concatenating every instrText in a part with no separator lets one field's
    // tail and the next field's head form a third keyword.
    const xml =
      splitInstrField([' HYPERLINK "https://example.com/x/TO" '], "x") +
      splitInstrField(["C_UNRELATED "], "y");
    expect(collectFieldKeywords(xml)).not.toContain("TOC");
  });

  it("reports both fields of a nested construction, outer instruction intact", () => {
    const inner =
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r><w:t>1</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const xml =
      `<w:p>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> IF </w:instrText></w:r>` +
      inner +
      `<w:r><w:instrText xml:space="preserve"> = 1 "a" "b" </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r><w:t>a</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `</w:p>`;
    expect(collectFieldKeywords(xml)).toEqual(["PAGE", "IF"]);
  });

  it("classifies an unterminated field rather than dropping it", () => {
    const xml =
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r></w:p>`;
    expect(collectFieldKeywords(xml)).toEqual(["TOC"]);
  });

  it("names no keyword for a formula field (documented gap)", () => {
    expect(collectFieldKeywords(splitInstrField([" =SUM(ABOVE) "], "0"))).toEqual([]);
  });
});

describe("needsFieldRefresh scans every WordprocessingML part", () => {
  it("finds a TOC that lives in a header, not in word/document.xml", () => {
    const zip = unzipDocx(
      buildDocx({
        body: para("body"),
        styles,
        header: splitInstrField([' TOC \\o "1-2" \\h '], "Press F9"),
      })
    );
    expect(needsFieldRefresh(zip)).toBe(true);
    // …and the document part alone says nothing, which is the point.
    expect(collectFieldKeywords(readPartText(zip, "word/document.xml"))).toEqual([]);
  });

  it("finds a STYLEREF running head in a footer", () => {
    const zip = unzipDocx(
      buildDocx({
        body: para("body"),
        styles,
        footer: splitInstrField([' STYLEREF "Heading 1" \\* MERGEFORMAT '], "Chapter"),
      })
    );
    expect(needsFieldRefresh(zip)).toBe(true);
  });

  it("is false for a package whose only fields are hyperlinks", () => {
    const zip = unzipDocx(
      buildDocx({
        body: splitInstrField([' HYPERLINK "https://example.com/" '], "link"),
        styles,
        header: fldSimpleField(" PAGE ", "1"),
        footer: fldSimpleField(" NUMPAGES ", "3"),
      })
    );
    expect(needsFieldRefresh(zip)).toBe(false);
  });
});

/** Local re-read helper (scan.ts's readPartText, used only by the header case). */
function readPartText(zip: PizZip, part: string): string {
  return zip.file(part)?.asText() ?? "";
}

describe("exportDocx — the field-refresh flag", () => {
  it("sets NO flag for a document whose only fields are hyperlinks", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content"), styles }),
      details: page(LINKS_ONLY),
      template,
      deps,
    });
    const doc = readPart(bytes, "word/document.xml");
    // The hyperlinks really are there — otherwise this test proves nothing.
    expect(doc).toContain("HYPERLINK");
    expect(updateFieldsValue(bytes)).toBeUndefined();
    expect(report.notes.some((n) => n.code === "field-refresh-suppressed")).toBe(false);
  });

  it("sets the flag when the template carries a TOC (the important default)", async () => {
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([' TOC \\o "1-3" \\h \\z \\u '], "Update this field") + para("$scroll.content"),
        styles,
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("sets the flag for a TOC whose instruction is split across runs", async () => {
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([" TO", 'C \\o "1-3"', " \\h "], "Update this field") + para("$scroll.content"),
        styles,
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("sets the flag for a TOC in a header", async () => {
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content"),
        styles,
        header: splitInstrField([' TOC \\o "1-1" \\h '], "Update this field"),
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("sets the flag for a w:fldSimple TOC", async () => {
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: fldSimpleField(" TOC \\h ", "Update this field") + para("$scroll.content"),
        styles,
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("sets the flag for a caption SEQ the serializer itself emitted", async () => {
    // The serializer caches every caption's SEQ result as literally `1`
    // (`captionParagraph`), so without a refresh three figures all read
    // "Figure 1". Two captions here, to make the wrongness real.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content"), styles }),
      details: page(""),
      blocks: [
        {
          type: "table",
          rows: [{ cells: [cell("a")] }],
          caption: { kind: "table", content: [{ type: "text", text: "First" }] },
        },
        {
          type: "table",
          rows: [{ cells: [cell("b")] }],
          caption: { kind: "table", content: [{ type: "text", text: "Second" }] },
        },
      ],
      template,
      deps,
    });
    expect(readPart(bytes, "word/document.xml")).toContain("SEQ Table");
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("normalizes a template's `false` to `true` when the document does need a refresh", async () => {
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([' TOC \\o "1-3" '], "Update this field") + para("$scroll.content"),
        styles,
        settings:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:updateFields w:val="false"></w:updateFields></w:settings>`,
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("honours a template that sets the flag itself, even with nothing to refresh", async () => {
    // The template author may know about a field type this engine does not
    // classify. `"auto"` manages the flag the exporter would INJECT; it does not
    // delete a setting someone typed on purpose.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content"),
        styles,
        settings:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:updateFields w:val="true"/></w:settings>`,
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it('"always" restores the unconditional pre-fix behaviour', async () => {
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content"), styles }),
      details: page(LINKS_ONLY),
      template,
      deps,
      updateFields: "always",
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });
});

describe('exportDocx — updateFields: "never" (the --no-field-update-prompt contract)', () => {
  it("clears the flag even when a TOC is present, and says what that costs", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([' TOC \\o "1-3" \\h '], "Update this field") + para("$scroll.content"),
        styles,
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
      updateFields: "never",
    });
    expect(updateFieldsValue(bytes)).not.toBe("true");
    const note = report.notes.find((n) => n.code === "field-refresh-suppressed");
    expect(note, `notes: ${report.notes.map((n) => n.code).join(", ")}`).toBeDefined();
    expect(note!.level).toBe("info");
  });

  it("overrides a template that pinned the flag to true", async () => {
    // An explicit host flag is a stronger, more recent signal than a template
    // default — otherwise the help text ("Word won't prompt") is false again.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([' TOC \\o "1-3" '], "Update this field") + para("$scroll.content"),
        styles,
        settings:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:updateFields w:val="true"/></w:settings>`,
      }),
      details: page(LINKS_ONLY),
      template,
      deps,
      updateFields: "never",
    });
    expect(updateFieldsValue(bytes)).toBe("false");
  });

  it("stays quiet on a document that had nothing to refresh anyway", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content"), styles }),
      details: page(LINKS_ONLY),
      template,
      deps,
      updateFields: "never",
    });
    expect(updateFieldsValue(bytes)).toBeUndefined();
    expect(report.notes.some((n) => n.code === "field-refresh-suppressed")).toBe(false);
  });
});

describe("the DDE rejection does not depend on the flag", () => {
  it("still refuses a DDE template, whose fields would not have set the flag", async () => {
    // `DDE` is not refresh-sensitive, so under the conditional policy such a
    // template would otherwise export with NO flag at all — a quieter delivery
    // of the same remote-code-execution chain, not a safer one.
    const templateBytes = buildDocx({
      body: splitInstrField([' DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/c calc" '], "x") + para("$scroll.content"),
      styles,
    });
    expect(() => unzipDocx(templateBytes)).toThrow(DocxError);
    await expect(
      exportDocx({ templateBytes, details: page(LINKS_ONLY), template, deps })
    ).rejects.toThrow(/DDE/);
  });
});
