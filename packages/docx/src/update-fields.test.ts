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
import { composeChapters } from "@atlcli/confluence";
import type {
  ConfluencePageDetails,
  ExportBlock,
  ExportNode,
  TableCell,
} from "@atlcli/confluence";
import { exportDocx } from "./export.js";
import {
  collectFieldKeywords,
  collectSeqSequenceNames,
  DocxError,
  needsFieldRefresh,
  seqSequenceName,
  unzipDocx,
} from "./scan.js";
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

/**
 * Every caption SEQ field's sequence name and CACHED RESULT, in document order —
 * the numbers a reader sees before pressing F9, and the only ones a consumer
 * that reads `<w:t>` without evaluating fields (pandoc, python-docx, a search
 * indexer) ever sees.
 */
function seqCachedResults(xml: string): [sequence: string, cached: string][] {
  // The gap-crossing guards matter: without them a field whose cached result is
  // formatted differently (`<w:t xml:space="preserve">`) lets the scan run on
  // into the NEXT field's number and report a pairing that is not in the file.
  const gap = String.raw`(?:(?!fldCharType="end")[\s\S])*?`;
  const re = new RegExp(
    String.raw`SEQ (\w+) \\\* ARABIC${gap}fldCharType="separate"${gap}<w:t[^>]*>(\d+)</w:t>`,
    "g"
  );
  return [...xml.matchAll(re)].map((m) => [m[1], m[2]]);
}

/** A one-cell table carrying a `table` caption. */
function captionedTable(title: string): ExportBlock {
  return {
    type: "table",
    rows: [{ cells: [cell(title)] }],
    caption: { kind: "table", content: [{ type: "text", text: title }] },
  };
}

/** An (unembeddable) image carrying a `figure` caption — still numbered. */
function captionedFigure(title: string): ExportBlock {
  return {
    type: "image",
    source: { kind: "attachment", filename: "arch.png" },
    caption: { kind: "figure", content: [{ type: "text", text: title }] },
  };
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

describe("seqSequenceName / collectSeqSequenceNames (pure)", () => {
  it("reads a bare and a quoted sequence identifier, lower-cased", () => {
    expect(seqSequenceName(" SEQ Figure \\* ARABIC ")).toBe("figure");
    expect(seqSequenceName(' SEQ "Sales Table" \\* ARABIC ')).toBe("sales table");
    // Case folding is the point: Word treats these as ONE sequence.
    expect(seqSequenceName(" SEQ TABLE ")).toBe(seqSequenceName(" SEQ table "));
  });

  it("names nothing for a non-SEQ field or a SEQ with no identifier", () => {
    expect(seqSequenceName(' TOC \\o "1-3" ')).toBeUndefined();
    expect(seqSequenceName(" SEQ \\* ARABIC ")).toBeUndefined();
    expect(seqSequenceName(" SEQ ")).toBeUndefined();
  });

  it("collects distinct sequence names in first-seen order, ignoring other fields", () => {
    const xml =
      splitInstrField([" SEQ Table \\* ARABIC "], "1") +
      splitInstrField([' HYPERLINK "https://example.com/seq/Figure" '], "x") +
      splitInstrField([" SEQ Figure \\* ARABIC "], "1") +
      fldSimpleField(" SEQ Table ", "2");
    expect(collectSeqSequenceNames(xml)).toEqual(["table", "figure"]);
  });

  it("reassembles a SEQ instruction split across runs", () => {
    expect(collectSeqSequenceNames(splitInstrField([" SE", "Q Fig", "ure \\* ARABIC "], "1"))).toEqual([
      "figure",
    ]);
  });

  it("folds case so a template's ` SEQ table ` and our ` SEQ Table ` are one sequence", () => {
    // This is the subtraction `exportDocx` performs to build its trust set,
    // isolated. Verbatim name comparison would leave `Table` in the result —
    // i.e. would trust ordinals a colliding template counter has already shifted.
    const templateSeq = collectSeqSequenceNames(splitInstrField([" SEQ table \\* ARABIC "], "1"));
    const bodySeq = collectSeqSequenceNames(splitInstrField([" SEQ Table \\* ARABIC "], "1"));
    expect(bodySeq.filter((name) => !templateSeq.includes(name))).toEqual([]);
  });
});

describe("needsFieldRefresh — trusted SEQ sequences", () => {
  const withBody = (body: string) => unzipDocx(buildDocx({ body, styles }));

  it("skips a SEQ whose sequence the caller vouched for", () => {
    const zip = withBody(splitInstrField([" SEQ Table \\* ARABIC "], "1"));
    expect(needsFieldRefresh(zip)).toBe(true);
    expect(needsFieldRefresh(zip, { trustedSeqSequences: new Set(["table"]) })).toBe(false);
  });

  it("still reports a SEQ of a DIFFERENT sequence in the same document", () => {
    const zip = withBody(
      splitInstrField([" SEQ Table \\* ARABIC "], "1") + splitInstrField([" SEQ Figure "], "1")
    );
    expect(needsFieldRefresh(zip, { trustedSeqSequences: new Set(["table"]) })).toBe(true);
  });

  it("never trusts a SEQ whose sequence name cannot be read", () => {
    const zip = withBody(splitInstrField([" SEQ \\* ARABIC "], "1"));
    expect(needsFieldRefresh(zip, { trustedSeqSequences: new Set(["table", ""]) })).toBe(true);
  });

  it("does not let a trusted sequence excuse any OTHER refresh-sensitive field", () => {
    const zip = withBody(
      splitInstrField([" SEQ Table \\* ARABIC "], "1") + splitInstrField([' TOC \\o "1-3" '], "x")
    );
    expect(needsFieldRefresh(zip, { trustedSeqSequences: new Set(["table"]) })).toBe(true);
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

  it("sets NO flag for caption SEQs the serializer numbered itself", async () => {
    // This test used to assert the OPPOSITE, and was right to: the serializer
    // cached every caption's SEQ result as literally `1`, so two tables both
    // read "Table 1" and only a refresh fixed them. Now the ordinals are
    // computed in document order and cached correctly, so a refresh would
    // change nothing and the prompt is unearned. The assertion on the cached
    // results is load-bearing — without it this test would also pass if
    // captions had simply stopped emitting a SEQ field.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content"), styles }),
      details: page(""),
      blocks: [captionedTable("First"), captionedTable("Second")],
      template,
      deps,
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("SEQ Table");
    expect(seqCachedResults(doc)).toEqual([
      ["Table", "1"],
      ["Table", "2"],
    ]);
    expect(updateFieldsValue(bytes)).toBeUndefined();
  });

  it("sets the flag when the TEMPLATE numbers the same sequence itself", async () => {
    // Word counts every `SEQ Table` in the document as ONE sequence, so a
    // caption the template author inserted before the insertion point makes our
    // first table "Table 2". The ordinals we cached are then wrong and only a
    // refresh fixes them — the whole reason `SEQ` stays refresh-sensitive by
    // default. The finished archive cannot tell the two apart; the TEMPLATE
    // scan, taken before injection, can.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([" SEQ Table \\* ARABIC "], "1") + para("$scroll.content"),
        styles,
      }),
      details: page(""),
      blocks: [captionedTable("First"), captionedTable("Second")],
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("sets the flag for a template SEQ that differs from ours only in case", async () => {
    // ` SEQ table ` and ` SEQ Table ` are ONE sequence to Word, so this template
    // shifts our caption numbers just as an exact-case one would. NOTE what this
    // test does and does not pin: it exercises the template-subtraction path
    // end to end, but it would also pass with case-SENSITIVE matching, because
    // the template's own field is then simply an untrusted third sequence. The
    // case folding itself is pinned by the two pure tests above
    // ("folds case…" and "skips a SEQ whose sequence the caller vouched for").
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([" SEQ table \\* ARABIC "], "1") + para("$scroll.content"),
        styles,
      }),
      details: page(""),
      blocks: [captionedTable("First")],
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("still sets the flag for a template SEQ of a sequence we do NOT number", async () => {
    // `SEQ Chart` cannot interleave with our `SEQ Table`, so OUR ordinals stay
    // right — but the flag is about the whole document, and nothing here knows
    // whether the TEMPLATE's cached `Chart` number is right. It may be a header
    // counter (instantiated per page, against a pagination that no longer
    // exists), or hand-written XML Word never computed. The trust set is
    // deliberately limited to numbers this engine produced itself; this is the
    // pre-existing behaviour, unchanged, and the reason the fix is narrow.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([" SEQ Chart \\* ARABIC "], "1") + para("$scroll.content"),
        styles,
      }),
      details: page(""),
      blocks: [captionedTable("First"), captionedTable("Second")],
      template,
      deps,
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("SEQ Chart");
    // Our own captions are numbered correctly regardless — the prompt is about
    // the template's field, not ours.
    expect(seqCachedResults(doc)).toEqual([
      ["Chart", "1"],
      ["Table", "1"],
      ["Table", "2"],
    ]);
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("sets the flag for a template SEQ whose sequence name cannot be read", async () => {
    // ` SEQ \* ARABIC ` names nothing this scan can match against a trusted
    // name, so it is never trusted — an unparseable field must not be silently
    // waved through as "probably one of ours".
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: splitInstrField([" SEQ \\* ARABIC "], "1") + para("$scroll.content"),
        styles,
      }),
      details: page(""),
      blocks: [captionedTable("First")],
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("finds a colliding template SEQ that lives in a footnote, not the body", async () => {
    // The template-origin sweep runs over EVERY WordprocessingML part, like
    // `needsFieldRefresh` — a caption in a footnote numbers the same sequence
    // as one in the body, and the `$scroll.*` scan's narrower part list covers
    // neither footnotes nor endnotes.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content"),
        styles,
        extraParts: {
          "word/footnotes.xml":
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
            `<w:footnote w:id="2">${splitInstrField([" SEQ Figure \\* ARABIC "], "1")}</w:footnote>` +
            `</w:footnotes>`,
        },
      }),
      details: page(""),
      blocks: [captionedFigure("Architecture")],
      template,
      deps,
    });
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("continues caption numbering across a composed tree document, and stays quiet", async () => {
    // A tree/space export is ONE document of many pages — page 2's first table
    // is "Table 2". This is the 62-page shape the whole conditional-flag change
    // exists for: correct numbers, therefore nothing to refresh, therefore no
    // prompt.
    const pageNode = (id: string, title: string): ExportNode => ({
      kind: "page",
      pageId: id,
      title,
      depth: 0,
      effectiveDepth: 0,
      parentId: null,
      position: null,
      blocks: [captionedTable(`${title} table`)],
      notes: [],
      meta: { labels: [], spaceKey: "ENG" },
    });
    const composed = composeChapters([
      pageNode("1", "Alpha"),
      pageNode("2", "Beta"),
      pageNode("3", "Gamma"),
    ]);
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content"), styles }),
      details: page(""),
      blocks: composed.blocks,
      template,
      deps,
    });
    expect(seqCachedResults(readPart(bytes, "word/document.xml"))).toEqual([
      ["Table", "1"],
      ["Table", "2"],
      ["Table", "3"],
    ]);
    expect(updateFieldsValue(bytes)).toBeUndefined();
  });

  it("sets the flag when the body was injected into a HEADER, where SEQ repeats", async () => {
    // `$scroll.content` is looked for in headers/footers too. A body rendered
    // into a header repeats on every page, and each repetition re-instantiates
    // its SEQ fields — ordinals counted once in document order are not what Word
    // computes there, so no sequence is trusted.
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: para("body text"),
        styles,
        header: para("$scroll.content"),
      }),
      details: page(""),
      blocks: [captionedTable("First"), captionedTable("Second")],
      template,
      deps,
    });
    expect(readPart(bytes, "word/header1.xml")).toContain("SEQ Table");
    expect(updateFieldsValue(bytes)).toBe("true");
  });

  it("sets the flag when an INCLUDED page contributes captions of its own", async () => {
    // `$scroll.includepage` occurrences are serialized through their own
    // `serializeBlocks` call, so each restarts its captions at 1 and lands at an
    // arbitrary position relative to the body. Two "Table 1"s in one document is
    // exactly the defect this change removes, so the sequence is not trusted.
    const included: ConfluencePageDetails = {
      id: "999",
      title: "Imprint",
      spaceKey: "ENG",
      storage:
        '<ac:structured-macro ac:name="scroll-title">' +
        '<ac:parameter ac:name="title">Included table</ac:parameter>' +
        "<ac:rich-text-body><table><tbody><tr><td>c</td></tr></tbody></table></ac:rich-text-body>" +
        "</ac:structured-macro>",
    };
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + para("$scroll.includepage.(ENG:Imprint)"),
        styles,
      }),
      details: page(""),
      blocks: [captionedTable("Body table")],
      template,
      deps: { ...deps, getIncludedPage: async () => ({ kind: "resolved" as const, page: included }) },
    });
    const doc = readPart(bytes, "word/document.xml");
    // Both captions really are in there — otherwise this proves nothing.
    expect(seqCachedResults(doc)).toEqual([
      ["Table", "1"],
      ["Table", "1"],
    ]);
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
