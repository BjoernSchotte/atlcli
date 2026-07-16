import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import type { ConfluencePageDetails, ConfluenceSpace } from "@atlcli/confluence";
import { DocxRenderError, exportDocx } from "./export.js";
import type { CurrentUser } from "./resolver.js";
import {
  assertBalancedXml,
  buildDocx,
  chartTitlePart,
  complexFieldResult,
  documentXml,
  drawingAdjacentPara,
  fldSimpleResult,
  headingStyle,
  para,
  readPart,
  runSplitPara,
  smartArtDataPart,
  stylesXml,
  textBoxTitlePara,
} from "./fixtures.js";

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
// The owner is deliberately NOT the page's creator (Cloud ownership is
// transferable), so a createdBy fallback would fail the assertion below.
const owner = { accountId: "u-9", displayName: "Olga Owner" };
const deps = {
  getSpace: async () => space,
  getCurrentUser: async () => currentUser,
  getPageOwner: async () => owner,
};

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
      para("$scroll.pageowner.fullName") +
      para("$scroll.spacelogo"),
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
    // The owner resolves through the full pipeline (G1) — and is the OWNER,
    // not the creator.
    expect(doc).toContain("Olga Owner");
    // The space logo stays unsupported (it is an image — spec 005).
    expect(report.unsupportedNames).toContain("$scroll.spacelogo");
    expect(report.filename).toBe("Q3_ Architecture _ Overview.docx");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stamps outline levels on injected headings so a TOC \\o collects them on a custom-heading-style template", async () => {
    // Regression (spec 004 E2E): a customer template whose only heading style is
    // a custom name (`Heading1TOC`, no `Heading 1/2/3`) yielded an empty
    // `TOC \o "1-3"` because headings carried no outline level. The injected
    // H1/H2 must now carry <w:outlineLvl w:val="0"/> / "1" regardless of style.
    const templateBytes = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1TOC", "Heading1TOC")),
    });
    const { bytes } = await exportDocx({
      templateBytes,
      details,
      template,
      exportDate: new Date(2026, 6, 14, 9, 5),
      deps,
    });
    const doc = readPart(bytes, "word/document.xml");
    // STORAGE has an <h1>Overview</h1> and an <h2>Details</h2>.
    expect(doc).toContain('<w:outlineLvl w:val="0"/>');
    expect(doc).toContain('<w:outlineLvl w:val="1"/>');
    assertBalancedXml(doc);
  });

  it("resolves $scroll.title in a text box and a drawing-adjacent footer run (real template, shapes a+b)", async () => {
    // Reproduces the live E2E finding against the Mayflower letterhead: the title
    // in a cover text box (mc:AlternateContent Choice+Fallback), the title again
    // in a header text box, and the title in a clean run trailing a footer
    // picture — all previously left as literal `$scroll.title`.
    const templateBytes = buildDocx({
      body:
        textBoxTitlePara("$scroll.title") +
        para("$scroll.content") +
        para("$scroll.space.name"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      header: textBoxTitlePara("$scroll.title"),
      footer: drawingAdjacentPara("$scroll.title"),
    });

    const { bytes } = await exportDocx({ templateBytes, details, template, deps });

    const doc = readPart(bytes, "word/document.xml");
    const header = readPart(bytes, "word/header1.xml");
    const footer = readPart(bytes, "word/footer1.xml");

    // AC: ZERO literal $scroll.* survives in ANY part.
    for (const part of [doc, header, footer]) {
      expect(part).not.toContain("$scroll.");
      expect(part).not.toContain("$adhocState");
      assertBalancedXml(part);
    }

    // Cover text box: both Choice and Fallback copies show the resolved title.
    expect((doc.match(/Q3: Architecture \/ Overview/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Header text box + footer run resolved.
    expect(header).toContain("Q3: Architecture / Overview");
    expect(footer).toContain("Q3: Architecture / Overview");
    // The footer picture is preserved (drawing run untouched).
    expect(footer).toContain("logo");
    // Body content injected at $scroll.content.
    expect(doc).toContain("Overview");
    expect(doc).toContain("Engineering"); // $scroll.space.name resolved
    // No text-box sentinel leaked into any part.
    for (const part of [doc, header, footer]) {
      expect(part).not.toContain("txbx0");
      expect(part).not.toContain("txbx1");
    }
  });

  it("resolves $scroll.* in chart and SmartArt DrawingML parts (shape ①)", async () => {
    const templateBytes = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      extraParts: {
        "word/charts/chart1.xml": chartTitlePart("$scroll.title"),
        "word/diagrams/data1.xml": smartArtDataPart("$scroll.title"),
      },
    });

    const { bytes } = await exportDocx({ templateBytes, details, template, deps });

    const chart = readPart(bytes, "word/charts/chart1.xml");
    const diagram = readPart(bytes, "word/diagrams/data1.xml");
    for (const part of [chart, diagram]) {
      // Placeholder resolved, zero literal survives, part still well-formed.
      expect(part).not.toContain("$scroll.");
      expect(part).toContain("Q3: Architecture / Overview");
      assertBalancedXml(part);
    }
    // Structural DrawingML preserved.
    expect(chart).toContain("<c:plotArea>");
  });

  it("resolves a $scroll.* field result but never the field instruction (shape ②)", async () => {
    const templateBytes = buildDocx({
      body:
        para("$scroll.content") +
        fldSimpleResult(" DOCPROPERTY $scroll.title ", "$scroll.title") +
        complexFieldResult(" REF $scroll.title ", "$scroll.title"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });

    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const doc = readPart(bytes, "word/document.xml");

    // The DISPLAYED results resolved (both field forms).
    expect((doc.match(/Q3: Architecture \/ Overview/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The field INSTRUCTIONS are left literal — a $scroll.* in field logic is NOT
    // a text placeholder, and rewriting it would corrupt the field.
    expect(doc).toContain('w:instr=" DOCPROPERTY $scroll.title "');
    expect(doc).toContain("<w:instrText xml:space=\"preserve\"> REF $scroll.title </w:instrText>");
    // Field frame intact + well-formed.
    expect(doc).toContain('<w:fldChar w:fldCharType="begin"/>');
    expect(doc).toContain('<w:fldChar w:fldCharType="end"/>');
    assertBalancedXml(doc);
  });

  it("does not fuse a placeholder across a text-box story boundary (shape ③)", async () => {
    // `$scr` in the main flow + `oll.title` inside a floating text box must stay
    // literal — merging across the story boundary would corrupt output. (There is
    // no $scroll.content here, so the body is appended before the section break.)
    const templateBytes = buildDocx({
      body:
        `<w:p>` +
        `<w:r><w:t xml:space="preserve">$scr</w:t></w:r>` +
        `<w:r><w:drawing><wps:txbx><w:txbxContent>` +
        `<w:p><w:r><w:t xml:space="preserve">oll.title</w:t></w:r></w:p>` +
        `</w:txbxContent></wps:txbx></w:drawing></w:r>` +
        `</w:p>` +
        para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });

    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    // Both fragments survive literally; no resolved title formed from the fusion.
    expect(doc).toContain(">$scr<");
    expect(doc).toContain(">oll.title<");
    // The only "$scroll." occurrences that could remain are the page-body verbatim
    // ones; the split fragments themselves never formed `$scroll.title`.
    expect(doc).not.toContain("$scroll.title<");
    assertBalancedXml(doc);
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

  it("does not throw on guillemets or double braces in a customer template (#11, PUA delimiters)", async () => {
    // Guillemets appear in real German/French prose; `{{…}}` is another engine's
    // default delimiter. With PUA delimiters none of these are tags → no parse,
    // no throw, verbatim survival.
    const templateBytes = buildDocx({
      body:
        para("$scroll.content") +
        para("Anführung: «Zitat» und {{mustache}} und }unbalanced{"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("«Zitat»");
    expect(doc).toContain("{{mustache}}");
    expect(doc).toContain("}unbalanced{");
  });

  it("injects the body via docxtemplater rawxml — page braces/$scroll survive verbatim (#7/#11)", async () => {
    // The page body itself contains BOTH a documented $scroll placeholder AND
    // braces. Because the body is a rawxml DATA value (not template text), none
    // of it is parsed by the engine.
    const pageDetails: ConfluencePageDetails = {
      ...details,
      storage: "<p>Use $scroll.title and {config} in your template.</p>",
    };
    const templateBytes = buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { bytes } = await exportDocx({ templateBytes, details: pageDetails, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("$scroll.title");
    expect(doc).toContain("{config}");
    // No Private-Use-Area delimiter or rawxml tag leaks into the output.
    expect(doc).not.toContain("scrollContent");
    expect(doc).not.toContain(String.fromCodePoint(0xe000));
    expect(doc).not.toContain(String.fromCodePoint(0xe001));
  });

  it("classifies a docxtemplater render failure as DocxRenderError, not a generic throw", async () => {
    // Force the engine to choke: place a stray Private-Use-Area start delimiter
    // (which the customer's own content could never contain) with no closing
    // delimiter. docxtemplater sees an unclosed tag and throws; export must
    // surface it as a specific, structured error.
    const strayOpen = String.fromCodePoint(0xe000);
    const templateBytes = buildDocx({
      body: para("$scroll.content") + para(`stray ${strayOpen}unclosed tag`),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    let caught: unknown;
    try {
      await exportDocx({ templateBytes, details, template, deps });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DocxRenderError);
    expect((caught as DocxRenderError).details.length).toBeGreaterThan(0);
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
