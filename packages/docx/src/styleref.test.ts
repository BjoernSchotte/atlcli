/**
 * STYLEREF verification (spec 006 G1) — Stage 1 unit invariants.
 *
 * Templates put the current chapter heading into the running header via a
 * `STYLEREF` field. These tests prove the three compatibility invariants that
 * make that work — the field instruction survives byte-exactly, headings carry
 * the exact style id whose NAME the field references, and Word is told to
 * refresh fields on open — plus the two diagnostics that distinguish a style
 * that is missing from the template from one that is defined but unused after
 * heading promotion in this particular export. Real zips, real XML, no mocks.
 */
import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import { exportDocx } from "./export.js";
import { collectStylerefFields, scanTemplate } from "./scan.js";
import { buildDocx, fldSimpleResult, headingStyle, para, readPart, stylesXml } from "./fixtures.js";
import type { ConfluencePageDetails } from "@atlcli/confluence";

const details = (storage: string): ConfluencePageDetails => ({
  id: "1",
  title: "StyleRef",
  url: "u",
  version: 1,
  spaceKey: "DOCSY",
  storage,
  tinyUrl: "t",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  createdBy: { displayName: "A" },
  modifiedBy: { displayName: "B" },
  labels: [],
});
const template = { name: "t.docx", modificationDate: new Date(2026, 0, 1) };
const deps = {
  getSpace: async () => ({ id: "s", key: "DOCSY", name: "S", type: "global" as const }),
  getCurrentUser: async () => ({ accountId: "u", displayName: "U" }),
  getPageOwner: async () => ({ accountId: "o", displayName: "O" }),
};

/** A template whose header carries a STYLEREF field referencing `styleName`. */
function stylerefTemplate(styleName: string, extraStyles = ""): Uint8Array {
  const instr = ` STYLEREF &quot;${styleName}&quot; \\* MERGEFORMAT `;
  return buildDocx({
    body: para("$scroll.content"),
    styles: stylesXml(
      headingStyle("SH1", "Scroll Heading 1") + headingStyle("SH2", "Scroll Heading 2") + extraStyles
    ),
    header: fldSimpleResult(instr, "STALE CHAPTER"),
  });
}

describe("collectStylerefFields (spec 006 G1 inventory)", () => {
  it("reads a fldSimple STYLEREF (escaped quotes)", () => {
    const xml = `<w:p><w:fldSimple w:instr=" STYLEREF &quot;Scroll Heading 1&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>`;
    expect(collectStylerefFields(xml)).toEqual(["Scroll Heading 1"]);
  });

  it("reassembles a complex field split across multiple instrText runs", () => {
    const xml =
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> STYL</w:instrText></w:r>` +
      `<w:r><w:instrText xml:space="preserve">EREF "Scroll Heading 2" \\* MERGEFORMAT </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r><w:t>stale</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    expect(collectStylerefFields(xml)).toEqual(["Scroll Heading 2"]);
  });

  it("surfaces referenced names on the scan result", () => {
    const scan = scanTemplate(stylerefTemplate("Scroll Heading 1"));
    expect(scan.stylerefStyleNames).toEqual(["Scroll Heading 1"]);
  });
});

describe("exportDocx — STYLEREF invariants (spec 006 G1)", () => {
  it("preserves the field instruction byte-exactly and refreshes fields", async () => {
    const { bytes } = await exportDocx({
      templateBytes: stylerefTemplate("Scroll Heading 1"),
      details: details("<h1>Real Chapter</h1><p>body</p>"),
      template,
      deps,
    });
    const header = readPart(bytes, "word/header1.xml");
    // Invariant 1: instruction survives preprocessing + docxtemplater untouched.
    expect(header).toContain(` STYLEREF &quot;Scroll Heading 1&quot; \\* MERGEFORMAT `);
    // Invariant 2: the H1 heading carries the exact style id whose NAME the field
    // references (Scroll Heading 1 → SH1).
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain('<w:headerReference w:type="default" r:id="rIdH1"/>');
    expect(doc).toContain('<w:pStyle w:val="SH1"/>');
    // Invariant 3: settings.xml forces a field refresh on open.
    expect(readPart(bytes, "word/settings.xml")).toContain('<w:updateFields w:val="true"/>');
  });

  it("emits no STYLEREF warning when the referenced style is actually used", async () => {
    const { report } = await exportDocx({
      templateBytes: stylerefTemplate("Scroll Heading 1"),
      details: details("<h1>Chapter</h1>"),
      template,
      deps,
    });
    expect(report.notes.some((n) => n.code.startsWith("styleref-"))).toBe(false);
  });

  it("flags styleref-style-unused-in-export when promotion leaves the named style unused", async () => {
    // Content has only H2 source headings → minLevel 2 → promotion collapses all
    // to effective level 1 (SH1). A STYLEREF on "Scroll Heading 2" therefore
    // references a style no heading in this export uses.
    const { report } = await exportDocx({
      templateBytes: stylerefTemplate("Scroll Heading 2"),
      details: details("<h2>A</h2><p>x</p><h2>B</h2>"),
      template,
      deps,
    });
    const note = report.notes.find((n) => n.code === "styleref-style-unused-in-export");
    expect(note?.level).toBe("warning");
    expect(note?.message).toContain("Scroll Heading 2");
  });

  it("flags styleref-style-not-in-template when the named style is undefined", async () => {
    const { report } = await exportDocx({
      templateBytes: stylerefTemplate("Nonexistent Heading"),
      details: details("<h1>Chapter</h1>"),
      template,
      deps,
    });
    const note = report.notes.find((n) => n.code === "styleref-style-not-in-template");
    expect(note?.level).toBe("info");
    expect(note?.message).toContain("Nonexistent Heading");
  });

  it("matches a complex-field STYLEREF split across instrText runs end-to-end", async () => {
    const splitHeader =
      `<w:p>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> STYLE</w:instrText></w:r>` +
      `<w:r><w:instrText xml:space="preserve">REF "Scroll Heading 2" </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r><w:t>stale</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `</w:p>`;
    const tmpl = buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("SH1", "Scroll Heading 1") + headingStyle("SH2", "Scroll Heading 2")),
      header: splitHeader,
    });
    const { report, bytes } = await exportDocx({
      templateBytes: tmpl,
      details: details("<h2>A</h2><h2>B</h2>"),
      template,
      deps,
    });
    // The split instruction survives byte-exactly (both runs).
    const header = readPart(bytes, "word/header1.xml");
    expect(header).toContain("> STYLE</w:instrText>");
    expect(header).toContain(`>REF "Scroll Heading 2" </w:instrText>`);
    // And the inventory reassembled + validated it (promotion leaves SH2 unused).
    expect(report.notes.some((n) => n.code === "styleref-style-unused-in-export")).toBe(true);
    // Sanity: the split instruction round-trips to a well-formed field the zip keeps.
    expect(new PizZip(bytes).file("word/header1.xml")).not.toBeNull();
  });
});
