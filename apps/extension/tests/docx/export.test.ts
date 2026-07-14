import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import type { ConfluencePageDetails, ConfluenceSpace } from "@atlcli/confluence/browser";
import { exportDocx } from "../../utils/docx/export.js";
import type { CurrentUser } from "../../utils/docx/resolver.js";
import { buildDocx, documentXml, headingStyle, para, readPart, runSplitPara, stylesXml } from "./fixtures.js";

const STORAGE = `
<h1>Overview</h1>
<p>Intro <strong>bold</strong> and <a href="https://x.com">link</a>.</p>
<h2>Details</h2>
<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Heads up</ac:parameter><ac:rich-text-body><p>note body</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>
<table><tbody><tr><th>H</th></tr><tr><td>cell</td></tr></tbody></table>
<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>
`;

const details: ConfluencePageDetails = {
  id: "123",
  title: "Q3: Architecture / Overview",
  url: "https://x.atlassian.net/wiki/spaces/ENG/pages/123",
  version: 7,
  spaceKey: "ENG",
  storage: STORAGE,
  tinyUrl: "https://x.atlassian.net/wiki/x/AbC",
  created: "2026-01-02T10:00:00.000Z",
  modified: "2026-06-30T12:30:00.000Z",
  createdBy: { displayName: "Alice Author" },
  modifiedBy: { displayName: "Mel Modifier" },
  labels: ["architecture"],
};

const space: ConfluenceSpace = { id: "s", key: "ENG", name: "Engineering", type: "global" };
const currentUser: CurrentUser = { accountId: "u", displayName: "Björn Schotte" };

const template = { name: "mayflower.docx", modificationDate: new Date(2026, 6, 14) };
const deps = { getSpace: async () => space, getCurrentUser: async () => currentUser };

/** A realistic template: cover placeholders, header/footer, TOC-ready styles. */
function fullTemplate(withScrollHeadings: boolean): Uint8Array {
  const styles = stylesXml(
    withScrollHeadings
      ? headingStyle("SH1", "Scroll Heading 1") + headingStyle("SH2", "Scroll Heading 2")
      : headingStyle("Heading1", "Heading 1") + headingStyle("Heading2", "Heading 2")
  );
  return buildDocx({
    body:
      para("$scroll.title") +
      para("$scroll.space.name") +
      para("$scroll.content") +
      para("$scroll.pageowner.fullName"),
    styles,
    header: para("$scroll.title"),
    footer: runSplitPara(["$scroll.exporter", ".fullName"]),
  });
}

describe("exportDocx — full pipeline", () => {
  it("produces a docx with no $scroll literals and expected style refs", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: fullTemplate(true),
      details,
      template,
      exportDate: new Date(2026, 6, 14, 9, 5),
      deps,
    });

    const doc = readPart(bytes, "word/document.xml");
    const header = readPart(bytes, "word/header1.xml");
    const footer = readPart(bytes, "word/footer1.xml");

    // Pinning: no literal placeholder survives anywhere.
    for (const part of [doc, header, footer]) {
      expect(part).not.toContain("$scroll.");
      expect(part).not.toContain("$adhocState");
    }

    // Resolved text landed in body + header + footer (run-split footer merged).
    expect(header).toContain("Q3: Architecture / Overview");
    expect(footer).toContain("Björn Schotte");
    expect(doc).toContain("Engineering");

    // Body content injected with Scroll Heading styles (TOC-ready).
    expect(doc).toContain('<w:pStyle w:val="SH1"/>');
    expect(doc).toContain('<w:pStyle w:val="SH2"/>');
    // Callout table + code style present.
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain("Heads up");
    expect(doc).toContain('<w:pStyle w:val="AtlcliCode"/>');

    // Image skipped: no drawing, report lists it.
    expect(doc).not.toContain("<w:drawing");
    expect(report.skippedImages).toBe(1);
    expect(report.notes.some((n) => n.code === "image-skipped")).toBe(true);

    // Report summary fields.
    expect(report.resolvedCount).toBeGreaterThan(0);
    expect(report.unsupportedNames).toContain("$scroll.pageowner.fullName");
    expect(report.filename).toBe("Q3_ Architecture _ Overview.docx");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sets w:updateFields so the TOC repaginates on open", async () => {
    const { bytes } = await exportDocx({ templateBytes: fullTemplate(true), details, template, deps });
    const settings = readPart(bytes, "word/settings.xml");
    expect(settings).toContain('<w:updateFields w:val="true"/>');
  });

  it("falls back to builtin heading ids when the template lacks Scroll Heading styles", async () => {
    const { bytes } = await exportDocx({ templateBytes: fullTemplate(false), details, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('<w:pStyle w:val="Heading2"/>');
  });

  it("inserts the body before the section break when the template has no $scroll.content", async () => {
    const templateBytes = buildDocx({
      body: para("$scroll.title"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { bytes, report } = await exportDocx({ templateBytes, details, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("$scroll.");
    expect(doc).toContain("Overview"); // body content present
    expect(report.notes.some((n) => n.code === "no-content-placeholder")).toBe(true);
  });

  it("preserves page-authored $scroll.* text in the body verbatim (#7)", async () => {
    // The page DOCUMENTS a placeholder in its content; only the header/template
    // uses a real one. The body must pass through untouched.
    const pageDetails: ConfluencePageDetails = {
      ...details,
      storage: "<h1>Docs</h1><p>Write $scroll.title in your template to insert the title.</p>",
    };
    const templateBytes = buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      header: para("$scroll.title"),
    });
    const { bytes } = await exportDocx({ templateBytes, details: pageDetails, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    const header = readPart(bytes, "word/header1.xml");
    // Page body keeps the literal placeholder text.
    expect(doc).toContain("$scroll.title");
    // Header's real placeholder is resolved (no literal).
    expect(header).not.toContain("$scroll.");
    expect(header).toContain("Q3: Architecture / Overview");
  });

  it("preserves literal braces in a customer template (#11)", async () => {
    const templateBytes = buildDocx({
      body: para("$scroll.content") + para("Config: {foo} and a lone { brace"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    // Must not throw on the lone brace and must keep the braces intact.
    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("{foo}");
    expect(doc).toContain("lone { brace");
  });

  it("resolves $scroll.title. and keeps the trailing period (#9)", async () => {
    const templateBytes = buildDocx({
      body: para("$scroll.content") + para("Heading: $scroll.title. Labels: $scroll.pagelabels.capitalised"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    // Title resolved, sentence period preserved, dotted sub-token resolved.
    expect(doc).toContain("Heading: Q3: Architecture / Overview.");
    expect(doc).toContain("Labels: Architecture");
    expect(doc).not.toContain("$scroll.");
  });

  it("normalizes a paired w:updateFields=false to true (#3)", async () => {
    const templateBytes = buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      settings:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:updateFields w:val="false"></w:updateFields></w:settings>`,
    });
    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const settings = readPart(bytes, "word/settings.xml");
    expect(settings).toContain('<w:updateFields w:val="true"/>');
    expect(settings).not.toContain('w:val="false"');
  });

  it("allocates a fresh settings rId when existing ids are single-quoted (#4)", async () => {
    // A template WITHOUT settings.xml whose document rels use single-quoted ids.
    const zip = new PizZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `</Types>`
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`
    );
    zip.file("word/document.xml", documentXml(para("$scroll.content")));
    zip.file("word/styles.xml", stylesXml(headingStyle("Heading1", "Heading 1")));
    // Existing document rel uses SINGLE quotes.
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles' Target='styles.xml'/>` +
        `</Relationships>`
    );
    const templateBytes = zip.generate({ type: "uint8array" }) as unknown as Uint8Array;

    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const rels = readPart(bytes, "word/_rels/document.xml.rels");
    // The settings relationship got a fresh id (rId2), not a duplicate rId1.
    expect(rels).toContain("Target=\"settings.xml\"");
    expect(rels).toContain('Id="rId2"');
    expect((rels.match(/rId1/g) ?? []).length).toBe(1);
  });

  it("counts walker image-skip notes toward skippedImages (#16)", async () => {
    // An <ac:image> with neither attachment nor url → walker image-unresolved.
    const pageDetails: ConfluencePageDetails = {
      ...details,
      storage: '<p>text</p><ac:image ac:alt="orphan"/>',
    };
    const templateBytes = buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { report } = await exportDocx({ templateBytes, details: pageDetails, template, deps });
    expect(report.skippedImages).toBeGreaterThanOrEqual(1);
    expect(report.notes.some((n) => n.code === "image-unresolved")).toBe(true);
  });

  it("does not fetch space/user when the template uses neither", async () => {
    let spaceCalls = 0;
    let userCalls = 0;
    const templateBytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });
    await exportDocx({
      templateBytes,
      details,
      template,
      deps: {
        getSpace: async () => {
          spaceCalls++;
          return space;
        },
        getCurrentUser: async () => {
          userCalls++;
          return currentUser;
        },
      },
    });
    expect(spaceCalls).toBe(0);
    expect(userCalls).toBe(0);
  });
});
