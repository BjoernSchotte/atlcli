import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import type { ConfluencePageDetails, ConfluenceSpace } from "@atlcli/confluence";
import { DocxRenderError, exportDocx } from "./export.js";
import type { CurrentUser, IncludePageDetails } from "./resolver.js";
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
  pngFixtureBytes,
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

/**
 * A Word TOC field, the archetypal reason to set `w:updateFields`: without a
 * refresh Word shows the cached (usually empty) table of contents.
 */
function tocField(): string {
  return (
    `<w:p>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t xml:space="preserve">Right-click to update</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `</w:p>`
  );
}

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

    // Image + logo skipped (no asset fetcher): no drawing, report lists both.
    expect(doc).not.toContain("<w:drawing");
    expect(report.skippedImages).toBe(2);
    expect(report.notes.some((n) => n.code === "image-skipped")).toBe(true);
    expect(report.notes.some((n) => n.code === "logo-skipped")).toBe(true);

    // Report summary fields.
    expect(report.resolvedCount).toBeGreaterThan(0);
    // The owner resolves through the full pipeline (G1) — and is the OWNER,
    // not the creator.
    expect(doc).toContain("Olga Owner");
    // The space logo is supported since spec 005 (G3) — it degrades to a
    // logo-skipped note here (no asset fetcher), never to "unsupported".
    expect(report.unsupportedNames).not.toContain("$scroll.spacelogo");
    expect(report.filename).toBe("Q3_ Architecture _ Overview.docx");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("turns a Confluence ac:link / ri:url from page storage into a Word HYPERLINK field", async () => {
    const href = "https://obi.atlassian.net/wiki/x/CACFFg";
    const linkedDetails: ConfluencePageDetails = {
      ...details,
      storage:
        '<table><tbody><tr><td><p>Documentation: <ac:link>' +
        `<ri:url ri:value="${href}"/>` +
        '<ac:plain-text-link-body><![CDATA[Platform documentation]]></ac:plain-text-link-body>' +
        "</ac:link></p></td></tr></tbody></table>",
    };
    const { bytes } = await exportDocx({
      templateBytes: fullTemplate(true),
      details: linkedDetails,
      template,
      exportDate: new Date(2026, 6, 14, 9, 5),
      deps,
    });

    // `fullTemplate` contains no link fields: this field instruction and its
    // visible result can only have come from the ri:url page body above.
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain(` HYPERLINK "${href}" `);
    expect(doc).toContain("Platform documentation");
    expect(doc).toContain('<w:fldChar w:fldCharType="begin"/>');
    expect(doc).toContain('<w:fldChar w:fldCharType="separate"/>');
    expect(doc).toContain('<w:fldChar w:fldCharType="end"/>');
    assertBalancedXml(doc);
  });

  it("preserves Confluence inline background colors as arbitrary Word run shading", async () => {
    const highlightedDetails: ConfluencePageDetails = {
      ...details,
      storage:
        '<p><span style="background-color: rgb(186, 243, 219);">Green highlight</span> ' +
        '<span style="color: #403294; background-color: #EED7FC"><strong>Purple highlight</strong></span></p>',
    };
    const { bytes } = await exportDocx({
      templateBytes: fullTemplate(true),
      details: highlightedDetails,
      template,
      exportDate: new Date(2026, 6, 14, 9, 5),
      deps,
    });

    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain(
      '<w:shd w:val="clear" w:color="auto" w:fill="BAF3DB"/>'
    );
    expect(doc).toContain(
      '<w:shd w:val="clear" w:color="auto" w:fill="EED7FC"/>'
    );
    expect(doc).toContain('<w:color w:val="403294"/>');
    expect(doc).toContain("Green highlight");
    expect(doc).toContain("Purple highlight");
    assertBalancedXml(doc);
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

  it("sets w:updateFields so a TOC repaginates on open", async () => {
    // The flag is CONDITIONAL since the field-refresh policy landed: it is set
    // when the finished document carries a field whose refresh changes what the
    // reader sees. A TOC is the archetype, and stays the default. The full
    // policy — including the hyperlink-only case this template used to be
    // wrongly flagged for — lives in `update-fields.test.ts`.
    const templateBytes = buildDocx({
      body: tocField() + para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { bytes } = await exportDocx({ templateBytes, details, template, deps });
    const settings = readPart(bytes, "word/settings.xml");
    expect(settings).toContain('<w:updateFields w:val="true"/>');
  });

  it("leaves w:updateFields alone when the document has nothing to refresh", async () => {
    // The same realistic template WITHOUT a TOC: its only fields are the body's
    // static HYPERLINKs, so asking the reader to refresh on every open would
    // accomplish nothing.
    const { bytes } = await exportDocx({ templateBytes: fullTemplate(true), details, template, deps });
    expect(readPart(bytes, "word/document.xml")).toContain("HYPERLINK");
    expect(readPart(bytes, "word/settings.xml")).not.toContain("<w:updateFields");
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
    // The TOC is what makes the refresh worth requesting; the template's pinned
    // `false` is then about a document that no longer exists (its body has been
    // replaced), and honouring it would ship a visibly empty table of contents.
    const templateBytes = buildDocx({
      body: tocField() + para("$scroll.content"),
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
    // A TOC, so the export genuinely needs to SYNTHESIZE settings.xml — which is
    // what this test is about.
    zip.file("word/document.xml", documentXml(tocField() + para("$scroll.content")));
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

// ---------------------------------------------------------------------------
// Image embedding through the full pipeline (spec 005)
// ---------------------------------------------------------------------------

describe("exportDocx — image embedding (spec 005)", () => {
  const imageTemplate = () =>
    buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });

  /** An AssetFetcher recording every ref, serving PNG fixture bytes. */
  function recordingFetcher(bytes = pngFixtureBytes(200, 100)) {
    const refs: { url: string; pageId?: string; filename?: string }[] = [];
    return {
      refs,
      fetcher: {
        async fetch(ref: { url: string; pageId?: string; filename?: string }) {
          refs.push(ref);
          return bytes;
        },
      },
    };
  }

  it("embeds an attachment image: drawing + media + rel + content type, report counts it", async () => {
    const { refs, fetcher } = recordingFetcher();
    const { bytes, report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<p>before</p><ac:image ac:alt="the diagram"><ri:attachment ri:filename="diagram.png"/></ac:image>',
      },
      template,
      deps,
      assets: fetcher,
    });

    // The fetch used the canonical wiki-base-relative download URL.
    expect(refs).toEqual([
      { url: "/download/attachments/123/diagram.png", pageId: "123", filename: "diagram.png" },
    ]);

    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("<w:drawing>");
    expect(doc).toContain('descr="the diagram"');
    expect(doc).toContain(`<wp:extent cx="${200 * 9525}" cy="${100 * 9525}"/>`);
    const relId = doc.match(/r:embed="(rId\d+)"/)?.[1];
    expect(relId).toBeDefined();

    const rels = readPart(bytes, "word/_rels/document.xml.rels");
    expect(rels).toContain(`Id="${relId}"`);
    expect(rels).toContain('Target="media/atlcli-image1.png"');
    expect(readPart(bytes, "[Content_Types].xml")).toContain('Extension="png"');
    // The media part survived the docxtemplater render byte-identically.
    const zip = new PizZip(bytes);
    expect([...zip.file("word/media/atlcli-image1.png")!.asUint8Array()]).toEqual([
      ...pngFixtureBytes(200, 100),
    ]);

    expect(report.embeddedImages).toBe(1);
    expect(report.skippedImages).toBe(0);
    expect(report.notes.some((n) => n.code.startsWith("image"))).toBe(false);
  });

  it("embeds correlated ADF inline media inside its paragraph with authored geometry and link", async () => {
    const { refs, fetcher } = recordingFetcher(pngFixtureBytes(200, 100));
    const { bytes, report } = await exportDocx({
      templateBytes: imageTemplate(),
      details,
      blocks: [{
        type: "paragraph",
        content: [
          { type: "text", text: "before" },
          {
            type: "media",
            media: { mediaType: "image", id: "inline-1", filename: "inline.png" },
            source: { kind: "attachment", filename: "inline.png", pageId: "123" },
            alt: "Inline architecture",
            width: 40,
            height: 20,
            border: { color: "#0052CC", size: 2 },
            link: { target: { kind: "external", href: "https://example.invalid/inline" } },
          },
          { type: "text", text: "after" },
        ],
      }],
      template,
      deps,
      assets: fetcher,
    });

    expect(refs).toEqual([
      { url: "/download/attachments/123/inline.png", pageId: "123", filename: "inline.png" },
    ]);
    const doc = readPart(bytes, "word/document.xml");
    const paragraphXml = doc.match(/<w:p>[\s\S]*?before[\s\S]*?after[\s\S]*?<\/w:p>/)?.[0];
    expect(paragraphXml).toBeDefined();
    expect(paragraphXml!.indexOf("before")).toBeLessThan(paragraphXml!.indexOf("<w:drawing>"));
    expect(paragraphXml!.indexOf("<w:drawing>")).toBeLessThan(paragraphXml!.indexOf("after"));
    expect(paragraphXml).toContain(`<wp:extent cx="${40 * 9525}" cy="${20 * 9525}"/>`);
    expect(paragraphXml).toContain('<a:ln w="25400">');
    expect(paragraphXml).toContain('<a:srgbClr val="0052CC">');
    expect(paragraphXml).toContain('HYPERLINK "https://example.invalid/inline"');
    expect(paragraphXml).not.toContain("[Inline architecture]");
    expect(report.embeddedImages).toBe(1);
    expect(report.skippedImages).toBe(0);
  });

  it("applies ADF mediaSingle percentage width and native Word text wrapping", async () => {
    const { fetcher } = recordingFetcher();
    const { bytes } = await exportDocx({
      templateBytes: imageTemplate(),
      details,
      blocks: [{
        type: "image",
        source: {
          kind: "attachment",
          filename: "diagram.png",
          pageId: "123",
        },
        alt: "Wrapped diagram",
        mediaPresentation: {
          layout: "wrap-right",
          width: 40,
          widthType: "percentage",
        },
      }],
      template,
      deps,
      assets: fetcher,
    });

    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain(`<wp:extent cx="${240 * 9525}" cy="${120 * 9525}"/>`);
    expect(doc).toContain("<wp:anchor ");
    expect(doc).toContain(
      '<wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH>',
    );
    expect(doc).toContain('<wp:wrapSquare wrapText="left"/>');
  });

  it("passes external image URLs through to the fetcher unchanged", async () => {
    const { refs, fetcher } = recordingFetcher();
    const { report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<ac:image><ri:url ri:value="https://cdn.example.com/pic.png"/></ac:image>',
      },
      template,
      deps,
      assets: fetcher,
    });
    expect(refs[0]?.url).toBe("https://cdn.example.com/pic.png");
    expect(report.embeddedImages).toBe(1);
  });

  it("degrades a failed fetch to a warning note with NO dangling relationship (F3 invariant)", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<p>t</p><ac:image><ri:attachment ri:filename="broken.png"/></ac:image>',
      },
      template,
      deps,
      assets: {
        async fetch() {
          throw new Error("boom (401)");
        },
      },
    });

    const note = report.notes.find((n) => n.code === "image-embed-failed");
    expect(note?.level).toBe("warning");
    expect(note?.message).toContain("broken.png");
    expect(note?.message).toContain("boom (401)");
    expect(report.embeddedImages).toBe(0);
    expect(report.skippedImages).toBe(1);

    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("<w:drawing");
    const rels = readPart(bytes, "word/_rels/document.xml.rels");
    expect(rels).not.toContain("relationships/image");
    const zip = new PizZip(bytes);
    expect(Object.keys(zip.files).some((p) => p.startsWith("word/media/"))).toBe(false);
  });

  it("degrades an SVG attachment with no rasterizer to image-svg-no-rasterizer (spec 006 G4)", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<ac:image><ri:attachment ri:filename="logo.svg"/></ac:image>',
      },
      template,
      deps,
      assets: { fetch: async () => svg },
      // No rasterizer: the SVG cannot be rasterized, so it degrades with the
      // precise code instead of the generic image-embed-failed.
    });
    const note = report.notes.find((n) => n.code === "image-svg-no-rasterizer");
    expect(note?.level).toBe("warning");
    expect(report.skippedImages).toBe(1);
    expect(report.embeddedImages).toBe(0);
  });

  it("embedImages: false skips embedding without touching the fetcher", async () => {
    const { refs, fetcher } = recordingFetcher();
    const { bytes, report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>',
      },
      template,
      deps,
      assets: fetcher,
      embedImages: false,
    });
    expect(refs).toHaveLength(0);
    expect(report.embeddedImages).toBe(0);
    expect(report.skippedImages).toBe(1);
    expect(report.notes.some((n) => n.code === "image-skipped")).toBe(true);
    expect(readPart(bytes, "word/document.xml")).not.toContain("<w:drawing");
  });

  // Logo tests run on an image-free page so drawings/notes are logo-only.
  const logoDetails: ConfluencePageDetails = { ...details, storage: "<p>plain body</p>" };

  it("embeds the space logo for $scroll.spacelogo AND $scroll.globallogo — body drawing, header drawing with its own rels, one shared media part", async () => {
    const { refs, fetcher } = recordingFetcher(pngFixtureBytes(300, 100));
    let logoCalls = 0;
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + para("$scroll.spacelogo"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
        header: para("$scroll.globallogo"),
      }),
      details: logoDetails,
      template,
      deps: {
        ...deps,
        getSpaceLogo: async (key: string) => {
          logoCalls++;
          expect(key).toBe("ENG");
          return { url: "/download/attachments/999/space-logo.png" };
        },
      },
      assets: fetcher,
    });

    // One icon-ref round-trip, one byte fetch — shared across both drawings.
    expect(logoCalls).toBe(1);
    expect(refs).toEqual([{ url: "/download/attachments/999/space-logo.png" }]);

    const doc = readPart(bytes, "word/document.xml");
    const header = readPart(bytes, "word/header1.xml");
    for (const part of [doc, header]) {
      expect(part).toContain("<w:drawing>");
      expect(part).not.toContain("$scroll.");
      assertBalancedXml(part);
    }
    expect(doc).toContain('descr="ENG space logo"');

    // The header drawing's relationship lives in the HEADER's own rels part.
    const headerRels = readPart(bytes, "word/_rels/header1.xml.rels");
    const headerRelId = header.match(/r:embed="(rId\d+)"/)?.[1];
    expect(headerRels).toContain(`Id="${headerRelId}"`);
    expect(headerRels).toContain('Target="media/atlcli-image1.png"');
    const docRels = readPart(bytes, "word/_rels/document.xml.rels");
    expect(docRels).toContain('Target="media/atlcli-image1.png"');

    // One media part serves both occurrences (byte-identical dedup).
    const zip = new PizZip(bytes);
    const media = Object.keys(zip.files).filter((p) => p.startsWith("word/media/"));
    expect(media).toEqual(["word/media/atlcli-image1.png"]);

    expect(report.embeddedImages).toBe(2);
    expect(report.skippedImages).toBe(0);
    expect(report.unsupportedNames).not.toContain("$scroll.spacelogo");
    expect(report.unsupportedNames).not.toContain("$scroll.globallogo");
    // The globallogo → space-logo substitution is said out loud, once.
    const subs = report.notes.filter(
      (n) => n.code === "placeholder-substituted" && n.message.includes("$scroll.globallogo")
    );
    expect(subs).toHaveLength(1);
  });

  it("honors the .(H,W) logo size args (height first, per the Scroll grammar)", async () => {
    const { fetcher } = recordingFetcher(pngFixtureBytes(300, 100));
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + para("$scroll.spacelogo.(50,120)"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: logoDetails,
      template,
      deps: { ...deps, getSpaceLogo: async () => ({ url: "/download/attachments/999/logo.png" }) },
      assets: fetcher,
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain(`<wp:extent cx="${120 * 9525}" cy="${50 * 9525}"/>`);
  });

  it("preserves the placeholder paragraph's pPr (alignment) on the drawing paragraph", async () => {
    const { fetcher } = recordingFetcher(pngFixtureBytes(300, 100));
    const centered =
      `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
      `<w:r><w:t xml:space="preserve">$scroll.spacelogo</w:t></w:r></w:p>`;
    const { bytes } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + centered,
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: logoDetails,
      template,
      deps: { ...deps, getSpaceLogo: async () => ({ url: "/download/attachments/999/logo.png" }) },
      assets: fetcher,
    });
    const doc = readPart(bytes, "word/document.xml");
    const drawingPara = doc.slice(doc.indexOf("<w:p><w:pPr><w:jc"), doc.indexOf("</w:drawing>"));
    expect(drawingPara).toContain('<w:jc w:val="center"/>');
    expect(drawingPara).toContain("<w:drawing>");
  });

  it("degrades logos to a note + empty text when no getSpaceLogo dep is wired (F3 invariant)", async () => {
    const { fetcher } = recordingFetcher();
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + para("$scroll.spacelogo"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: logoDetails,
      template,
      deps, // no getSpaceLogo
      assets: fetcher,
    });
    const note = report.notes.find((n) => n.code === "logo-skipped");
    expect(note?.level).toBe("warning");
    expect(note?.message).toContain("$scroll.spacelogo");
    expect(report.embeddedImages).toBe(0);
    expect(report.skippedImages).toBe(1);
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("$scroll.");
    expect(doc).not.toContain("<w:drawing");
    expect(readPart(bytes, "word/_rels/document.xml.rels")).not.toContain("relationships/image");
  });

  it("degrades an SVG space logo (the Cloud default) to a logo-embed-failed note", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + para("$scroll.spacelogo"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: logoDetails,
      template,
      deps: { ...deps, getSpaceLogo: async () => ({ url: "/images/logo/default-space-logo.svg" }) },
      assets: { fetch: async () => svg },
    });
    const note = report.notes.find((n) => n.code === "logo-embed-failed");
    expect(note?.level).toBe("warning");
    expect(note?.message).toContain("SVG");
    expect(report.skippedImages).toBe(1);
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("$scroll.");
    expect(doc).not.toContain("<w:drawing");
  });

  it("degrades a failed logo fetch to a warning, token blanked", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + para("$scroll.globallogo"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: logoDetails,
      template,
      deps: { ...deps, getSpaceLogo: async () => ({ url: "/download/attachments/999/logo.png" }) },
      assets: {
        async fetch() {
          throw new Error("boom (403)");
        },
      },
    });
    const note = report.notes.find((n) => n.code === "logo-skipped");
    expect(note?.level).toBe("warning");
    expect(note?.message).toContain("boom (403)");
    expect(readPart(bytes, "word/document.xml")).not.toContain("$scroll.");
  });

  it("never calls getSpaceLogo when the template uses no logo placeholder (lazy contract)", async () => {
    const { fetcher } = recordingFetcher();
    let logoCalls = 0;
    await exportDocx({
      templateBytes: imageTemplate(),
      details,
      template,
      deps: {
        ...deps,
        getSpaceLogo: async () => {
          logoCalls++;
          return null;
        },
      },
      assets: fetcher,
    });
    expect(logoCalls).toBe(0);
  });

  it("never calls getSpaceLogo when embedding is disabled (--no-images)", async () => {
    let logoCalls = 0;
    const { fetcher } = recordingFetcher();
    const { report } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content") + para("$scroll.spacelogo"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: logoDetails,
      template,
      deps: {
        ...deps,
        getSpaceLogo: async () => {
          logoCalls++;
          return { url: "/x.png" };
        },
      },
      assets: fetcher,
      embedImages: false,
    });
    expect(logoCalls).toBe(0);
    expect(report.notes.some((n) => n.code === "logo-skipped")).toBe(true);
  });

  it("embeds images inside table cells and honors ac:width scaling", async () => {
    const { fetcher } = recordingFetcher(pngFixtureBytes(800, 400));
    const { bytes, report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage:
          "<table><tbody><tr><td>" +
          '<ac:image ac:width="250"><ri:attachment ri:filename="cell.png"/></ac:image>' +
          "</td></tr></tbody></table>",
      },
      template,
      deps,
      assets: fetcher,
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(report.embeddedImages).toBe(1);
    // Inside the table cell, scaled to 250×125 px.
    const cellStart = doc.indexOf("<w:tc>");
    expect(doc.indexOf("<w:drawing>")).toBeGreaterThan(cellStart);
    expect(doc).toContain(`<wp:extent cx="${250 * 9525}" cy="${125 * 9525}"/>`);
  });
});

// ---------------------------------------------------------------------------
// Mermaid diagram embedding through the full pipeline (spec 005a)
// ---------------------------------------------------------------------------

describe("exportDocx — mermaid diagrams (spec 005a)", () => {
  const diagramTemplate = () =>
    buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });

  const mermaidStorage = (source: string) =>
    `<p>before</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>` +
    `<ac:plain-text-body><![CDATA[${source}]]></ac:plain-text-body></ac:structured-macro>`;

  const mermaidBlocks = (...sources: string[]) =>
    sources
      .map(
        (source) =>
          `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>` +
          `<ac:plain-text-body><![CDATA[${source}]]></ac:plain-text-body></ac:structured-macro>`
      )
      .join("");

  /** A rasterizer recording every call, serving real PNG fixture bytes. */
  function recordingRasterizer() {
    const calls: { svg: string; widthPx: number; heightPx: number }[] = [];
    return {
      calls,
      rasterizer: {
        async rasterize(svg: string, target: { widthPx: number; heightPx: number }) {
          calls.push({ svg, ...target });
          return pngFixtureBytes(target.widthPx, target.heightPx);
        },
      },
    };
  }

  it("embeds a flowchart as svgBlip + PNG@2x with the source as alt text (no asset fetcher needed)", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    const source = "graph TD\n  A[Start] --> B[Done]";
    const { bytes, report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: { ...details, storage: mermaidStorage(source) },
      template,
      deps,
      rasterizer,
    });

    // Rendered through the REAL renderer, rasterized at 2× the intrinsic size.
    expect(calls).toHaveLength(1);
    expect(calls[0].svg).toStartWith("<svg");
    const intrinsicW = calls[0].widthPx / 2;
    const intrinsicH = calls[0].heightPx / 2;

    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("<w:drawing>");
    // svgBlip extension + raster blip, two distinct relationships.
    const pngRel = doc.match(/<a:blip r:embed="(rId\d+)"/)?.[1];
    const svgRel = doc.match(/<asvg:svgBlip[^>]*r:embed="(rId\d+)"/)?.[1];
    expect(pngRel).toBeDefined();
    expect(svgRel).toBeDefined();
    expect(pngRel).not.toBe(svgRel);
    // Display size = intrinsic px (small diagram, uncapped).
    expect(doc).toContain(`<wp:extent cx="${intrinsicW * 9525}" cy="${intrinsicH * 9525}"/>`);
    // Accessibility: the diagram SOURCE is the description (XML-escaped).
    expect(doc).toContain('descr="graph TD\n  A[Start] --&gt; B[Done]"');

    const rels = readPart(bytes, "word/_rels/document.xml.rels");
    expect(rels).toContain('Target="media/atlcli-image1.svg"');
    expect(rels).toContain('Target="media/atlcli-image2.png"');
    const ct = readPart(bytes, "[Content_Types].xml");
    expect(ct).toContain('Extension="svg" ContentType="image/svg+xml"');
    expect(ct).toContain('Extension="png"');

    // The SVG media part is the rendered diagram (theme default, font import stripped).
    const zip = new PizZip(bytes);
    const svgPart = zip.file("word/media/atlcli-image1.svg")!.asText();
    expect(svgPart).toContain("Start");
    expect(svgPart).not.toContain("fonts.googleapis.com");

    expect(report.renderedDiagrams).toBe(1);
    expect(report.embeddedImages).toBe(0);
    expect(report.skippedImages).toBe(0);
    expect(report.notes.some((n) => n.code.startsWith("diagram"))).toBe(false);
  });

  it("routes an unsupported type (Gantt) to the pinned code block — no drawing, note names the type, rasterizer untouched", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    const { bytes, report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: { ...details, storage: mermaidStorage("gantt\n  title T\n  section S\n  A :a1, 2026-01-01, 3d") },
      template,
      deps,
      rasterizer,
    });
    expect(calls).toHaveLength(0);
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("<w:drawing");
    expect(doc).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(doc).toContain("gantt");
    const rels = readPart(bytes, "word/_rels/document.xml.rels");
    expect(rels).not.toContain("relationships/image");
    const note = report.notes.find((n) => n.code === "diagram-unsupported");
    expect(note?.message).toContain("Gantt");
    expect(report.renderedDiagrams).toBe(0);
  });

  it("degrades a rasterizer failure to a warning with NO dangling relationship (F3 invariant)", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: { ...details, storage: mermaidStorage("graph TD\n  A --> B") },
      template,
      deps,
      rasterizer: {
        async rasterize() {
          throw new Error("canvas exploded");
        },
      },
    });
    const note = report.notes.find((n) => n.code === "diagram-render-failed");
    expect(note?.level).toBe("warning");
    expect(note?.message).toContain("canvas exploded");
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("<w:drawing");
    expect(doc).toContain("A --&gt; B");
    expect(readPart(bytes, "word/_rels/document.xml.rels")).not.toContain("relationships/image");
    const zip = new PizZip(bytes);
    expect(Object.keys(zip.files).some((p) => p.startsWith("word/media/"))).toBe(false);
    expect(report.renderedDiagrams).toBe(0);
  });

  it("keeps mermaid a code block when no rasterizer is supplied (pre-005a behavior + note)", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: { ...details, storage: mermaidStorage("graph TD\n  A --> B") },
      template,
      deps,
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("<w:drawing");
    expect(doc).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(report.notes.some((n) => n.code === "diagram-skipped")).toBe(true);
    expect(report.renderedDiagrams).toBe(0);
  });

  it("applies the configured diagram theme to the embedded SVG (Task 4)", async () => {
    const { rasterizer } = recordingRasterizer();
    const { bytes } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: { ...details, storage: mermaidStorage("graph TD\n  A --> B") },
      template,
      deps,
      rasterizer,
      diagramTheme: { bg: "#101820", fg: "#FEE715" },
    });
    const zip = new PizZip(bytes);
    const svgPart = zip.file("word/media/atlcli-image1.svg")!.asText();
    expect(svgPart).toContain("#101820");
    expect(svgPart).toContain("#FEE715");
  });

  it("diagram embedding coexists with attachment images — shared id space, separate counts", async () => {
    const { rasterizer } = recordingRasterizer();
    const { bytes, report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: {
        ...details,
        storage:
          '<ac:image><ri:attachment ri:filename="pic.png"/></ac:image>' +
          mermaidStorage("graph TD\n  A --> B"),
      },
      template,
      deps,
      assets: { fetch: async () => pngFixtureBytes(100, 50) },
      rasterizer,
    });
    expect(report.embeddedImages).toBe(1);
    expect(report.renderedDiagrams).toBe(1);
    const doc = readPart(bytes, "word/document.xml");
    const ids = [...doc.matchAll(/wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("chains diagram rasterization in document order with at most one active call", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const { report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: {
        ...details,
        storage: mermaidBlocks(
          "graph TD\n  First --> A",
          "graph TD\n  Second --> B",
          "graph TD\n  Third --> C"
        ),
      },
      template,
      deps,
      rasterizer: {
        async rasterize(svg, target) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(svg.includes("First") ? "First" : svg.includes("Second") ? "Second" : "Third");
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return pngFixtureBytes(target.widthPx, target.heightPx);
          } finally {
            active -= 1;
          }
        },
      },
    });

    expect(order).toEqual(["First", "Second", "Third"]);
    expect(maxActive).toBe(1);
    expect(report.renderedDiagrams).toBe(3);
  });

  it("prepares identical diagram sources once but embeds every occurrence in document order", async () => {
    const source = "graph TD\n  Shared --> Result";
    let rasterCalls = 0;
    const { bytes, report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: { ...details, storage: mermaidBlocks(source, source) },
      template,
      deps,
      rasterizer: {
        async rasterize(_svg, target) {
          rasterCalls += 1;
          return pngFixtureBytes(target.widthPx, target.heightPx);
        },
      },
    });

    expect(rasterCalls).toBe(1);
    expect(report.renderedDiagrams).toBe(2);
    const doc = readPart(bytes, "word/document.xml");
    expect(doc.match(/<w:drawing>/g)).toHaveLength(2);
    const ids = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it("a failed prepared diagram does not reject or poison the remaining chain", async () => {
    const order: string[] = [];
    const first = "graph TD\n  Broken --> A";
    const second = "graph TD\n  Healthy --> B";
    const { bytes, report } = await exportDocx({
      templateBytes: diagramTemplate(),
      details: { ...details, storage: mermaidBlocks(first, second) },
      template,
      deps,
      rasterizer: {
        async rasterize(svg, target) {
          const name = svg.includes("Broken") ? "Broken" : "Healthy";
          order.push(name);
          if (name === "Broken") throw new Error("first raster failed");
          return pngFixtureBytes(target.widthPx, target.heightPx);
        },
      },
    });

    expect(order).toEqual(["Broken", "Healthy"]);
    expect(report.renderedDiagrams).toBe(1);
    expect(report.notes.filter((n) => n.code === "diagram-render-failed")).toHaveLength(1);
    const doc = readPart(bytes, "word/document.xml");
    expect(doc.match(/<w:drawing>/g)).toHaveLength(1);
    expect(doc).toContain("Broken --&gt; A");
  });
});

describe("exportDocx — parallel prefetch determinism (perf regression)", () => {
  // Three attachment images + a space logo, each with DISTINCT bytes so a
  // mixed-up embed order cannot go unnoticed. The staggered run completes
  // fetches in REVERSE document order (c before b before a, logo last);
  // output bytes must be identical to the instant run — media numbering and
  // relationship ids are allocated in document order, never completion order.
  const IMG_STORAGE =
    "<p>intro</p>" +
    '<ac:image ac:alt="a"><ri:attachment ri:filename="a.png"/></ac:image>' +
    '<ac:image ac:alt="b"><ri:attachment ri:filename="b.png"/></ac:image>' +
    '<ac:image ac:alt="c"><ri:attachment ri:filename="c.png"/></ac:image>';

  const SIZES: Record<string, [number, number]> = {
    "a.png": [200, 100],
    "b.png": [300, 150],
    "c.png": [400, 200],
    logo: [64, 64],
  };

  function fetcherWithDelays(delays: Record<string, number>) {
    return {
      fetch(ref: { url: string; filename?: string }): Promise<Uint8Array> {
        const key = ref.url.includes("logo") ? "logo" : (ref.filename ?? ref.url);
        const [w, h] = SIZES[key];
        return new Promise((res) => setTimeout(() => res(pngFixtureBytes(w, h)), delays[key] ?? 0));
      },
    };
  }

  async function runWith(delays: Record<string, number>) {
    return exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.spacelogo") + para("$scroll.content"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: { ...details, storage: IMG_STORAGE },
      template,
      exportDate: new Date(2026, 6, 14, 9, 5),
      deps: {
        ...deps,
        getSpaceLogo: async () => ({ url: "/download/attachments/9/logo.png", pageId: "9", filename: "logo.png" }),
      },
      assets: fetcherWithDelays(delays),
    });
  }

  it("produces byte-identical output whether fetches resolve in document order or reversed", async () => {
    const instant = await runWith({});
    const scrambled = await runWith({ "a.png": 60, "b.png": 40, "c.png": 0, logo: 80 });

    expect(instant.report.embeddedImages).toBe(4); // 3 page images + 1 logo
    expect(scrambled.report.embeddedImages).toBe(4);

    const zipA = new PizZip(instant.bytes);
    const zipB = new PizZip(scrambled.bytes);
    const partsA = Object.keys(zipA.files).sort();
    const partsB = Object.keys(zipB.files).sort();
    expect(partsB).toEqual(partsA);
    for (const name of partsA) {
      if (zipA.files[name].dir) continue;
      expect([...zipB.file(name)!.asUint8Array()]).toEqual([...zipA.file(name)!.asUint8Array()]);
    }

    // Media numbering follows document order: image1 is a.png (200px wide).
    const doc = readPart(instant.bytes, "word/document.xml");
    const firstImageExtent = doc.indexOf(`<wp:extent cx="${200 * 9525}"`);
    const secondImageExtent = doc.indexOf(`<wp:extent cx="${300 * 9525}"`);
    const thirdImageExtent = doc.indexOf(`<wp:extent cx="${400 * 9525}"`);
    expect(firstImageExtent).toBeGreaterThan(-1);
    expect(secondImageExtent).toBeGreaterThan(firstImageExtent);
    expect(thirdImageExtent).toBeGreaterThan(secondImageExtent);
  });

  it("report note order is stable when a failing fetch resolves last", async () => {
    // b.png fails SLOWLY; the notes must still appear in document order and
    // the export must still embed a + c (F3: no dangling relationship).
    const failing = {
      fetch(ref: { url: string; filename?: string }): Promise<Uint8Array> {
        if (ref.filename === "b.png") {
          return new Promise((_, rej) => setTimeout(() => rej(new Error("boom")), 50));
        }
        const key = ref.url.includes("logo") ? "logo" : (ref.filename ?? ref.url);
        const [w, h] = SIZES[key];
        return Promise.resolve(pngFixtureBytes(w, h));
      },
    };
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({
        body: para("$scroll.content"),
        styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      }),
      details: { ...details, storage: IMG_STORAGE },
      template,
      deps,
      assets: failing,
    });
    expect(report.embeddedImages).toBe(2);
    expect(report.skippedImages).toBe(1);
    const failNote = report.notes.find((n) => n.code === "image-embed-failed");
    expect(failNote?.message).toContain('"b.png"');
    // No dangling rel: exactly two media parts exist.
    const zip = new PizZip(bytes);
    const media = Object.keys(zip.files).filter((f) => f.startsWith("word/media/"));
    expect(media.length).toBe(2);
    assertBalancedXml(readPart(bytes, "word/document.xml"));
  });
});

describe("exportDocx — prefetch failure modes (Codex review findings)", () => {
  const plainTemplate = () =>
    buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });

  it("a SYNCHRONOUSLY-throwing asset fetcher degrades every image to a note (no pool deadlock)", async () => {
    // Seven images > the 6-slot pool: a leaked slot per sync throw would
    // starve the queue and hang the export instead of degrading (004-F3).
    const storage = Array.from(
      { length: 7 },
      (_, i) => `<ac:image><ri:attachment ri:filename="img${i}.png"/></ac:image>`
    ).join("");
    const { report } = await exportDocx({
      templateBytes: plainTemplate(),
      details: { ...details, storage },
      template,
      deps,
      assets: {
        fetch(): Promise<Uint8Array> {
          throw new Error("sync boom"); // NOT an async rejection
        },
      },
    });
    expect(report.embeddedImages).toBe(0);
    expect(report.skippedImages).toBe(7);
    expect(report.notes.filter((n) => n.code === "image-embed-failed").length).toBe(7);
  });

  it("two blocks referencing the same attachment share ONE fetch", async () => {
    let calls = 0;
    const { report } = await exportDocx({
      templateBytes: plainTemplate(),
      details: {
        ...details,
        storage:
          '<ac:image><ri:attachment ri:filename="dup.png"/></ac:image>' +
          "<p>between</p>" +
          '<ac:image><ri:attachment ri:filename="dup.png"/></ac:image>',
      },
      template,
      deps,
      assets: {
        async fetch(): Promise<Uint8Array> {
          calls += 1;
          return pngFixtureBytes(120, 60);
        },
      },
    });
    expect(report.embeddedImages).toBe(2);
    expect(calls).toBe(1);
  });
});

describe("exportDocx — spec 003 exporter-sensitive scroll macros", () => {
  // The DOCX call site wires { exporter: "word" } (spec 001 plumbing verified
  // here per the call-site matrix): a scroll-only[word] block is kept, a
  // scroll-only[pdf] block is dropped, and a page break / caption render.
  const STORAGE_003 =
    '<h1>Doc</h1>' +
    '<ac:structured-macro ac:name="scroll-only"><ac:parameter ac:name="exporter">word</ac:parameter><ac:rich-text-body><p>WORD_ONLY_KEEP</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="scroll-only"><ac:parameter ac:name="exporter">pdf</ac:parameter><ac:rich-text-body><p>PDF_ONLY_DROP</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="scroll-ignore"><ac:rich-text-body><p>IGNORED_DROP</p></ac:rich-text-body></ac:structured-macro>' +
    '<p>a</p><ac:structured-macro ac:name="scroll-pagebreak"/><p>b</p>' +
    '<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body><table><tbody><tr><td>wide</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>';

  it("keeps word-only content, drops pdf-only + ignored, renders break + orientation", async () => {
    const scrollDetails: ConfluencePageDetails = { ...details, storage: STORAGE_003 };
    const { bytes, report } = await exportDocx({
      templateBytes: fullTemplate(false),
      details: scrollDetails,
      template,
      deps,
    });
    const doc = readPart(bytes, "word/document.xml");

    expect(doc).toContain("WORD_ONLY_KEEP");
    expect(doc).not.toContain("PDF_ONLY_DROP");
    expect(doc).not.toContain("IGNORED_DROP");
    // Page break rendered.
    expect(doc).toContain('<w:br w:type="page"/>');
    // Orientation region → a landscape section (swapping the template's own
    // Letter dimensions, never a hard-coded A4 constant).
    expect(doc).toContain('w:orient="landscape"');
    expect(doc).toContain('w:w="15840"');
    // No scroll macro reached the unknown placeholder.
    expect(doc).not.toContain("macro not rendered");
    // Report explains every applied/skipped control.
    const codes = report.notes.map((n) => n.code);
    expect(codes).toContain("scroll-only-applied");
    expect(codes).toContain("scroll-only-skipped-other-exporter");
    expect(codes).toContain("scroll-ignore-applied");
  });
});

describe("exportDocx — spec 003 review fixes", () => {
  it("a document ENDING in an orientation region leaves no empty final section (no blank page)", async () => {
    const endsInRegion: ConfluencePageDetails = {
      ...details,
      storage:
        "<p>lead</p>" +
        '<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body><p>final wide</p></ac:rich-text-body></ac:structured-macro>',
    };
    // A content-only template: nothing between $scroll.content and the body sectPr.
    const templateBytes = buildDocx({ body: para("$scroll.content"), styles: stylesXml("") });
    const { bytes } = await exportDocx({ templateBytes, details: endsInRegion, template, deps });
    const doc = readPart(bytes, "word/document.xml");
    // The region's closing sectPr paragraph merged INTO the body-level sectPr:
    // no sectPr paragraph directly precedes the final body sectPr.
    expect(doc).not.toMatch(
      /<w:p><w:pPr><w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr><\/w:pPr><\/w:p><w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr><\/w:body>/
    );
    // The final body-level section IS the landscape region.
    const bodySect = doc.match(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>(?=<\/w:body>)/)?.[0] ?? "";
    expect(bodySect).toContain('w:orient="landscape"');
    expect(doc).toContain("final wide");
  });

  it("exportControls: passthrough keeps scroll-ignore content (--keep-ignored)", async () => {
    const scrollDetails: ConfluencePageDetails = {
      ...details,
      storage:
        '<ac:structured-macro ac:name="scroll-ignore"><ac:rich-text-body><p>KEEP_FOR_DEBUG</p></ac:rich-text-body></ac:structured-macro>',
    };
    const { bytes, report } = await exportDocx({
      templateBytes: fullTemplate(false),
      details: scrollDetails,
      template,
      deps,
      exportControls: "passthrough",
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("KEEP_FOR_DEBUG");
    expect(report.notes.some((n) => n.code === "export-controls-passthrough")).toBe(true);
  });

  it("an unsupported captionLang falls back to English with a warning note", async () => {
    const capDetails: ConfluencePageDetails = {
      ...details,
      storage:
        '<ac:structured-macro ac:name="scroll-title"><ac:parameter ac:name="title">T</ac:parameter>' +
        "<ac:rich-text-body><table><tbody><tr><td>c</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>",
    };
    const { bytes, report } = await exportDocx({
      templateBytes: fullTemplate(false),
      details: capDetails,
      template,
      deps,
      captionLang: "fr-FR",
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("Table ");
    expect(report.notes.some((n) => n.code === "caption-lang-fallback")).toBe(true);
  });

  it("a BCP-47 regional German tag resolves to German labels", async () => {
    const capDetails: ConfluencePageDetails = {
      ...details,
      storage:
        '<ac:structured-macro ac:name="scroll-title"><ac:parameter ac:name="title">T</ac:parameter>' +
        "<ac:rich-text-body><table><tbody><tr><td>c</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>",
    };
    const { bytes, report } = await exportDocx({
      templateBytes: fullTemplate(false),
      details: capDetails,
      template,
      deps,
      captionLang: "de-AT",
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("Tabelle ");
    expect(report.notes.some((n) => n.code === "caption-lang-fallback")).toBe(false);
  });

  it("ensureCaptionStyle injects the Caption style into a template that lacks it", async () => {
    const capDetails: ConfluencePageDetails = {
      ...details,
      storage:
        '<ac:structured-macro ac:name="scroll-title"><ac:parameter ac:name="title">Styled</ac:parameter>' +
        "<ac:rich-text-body><table><tbody><tr><td>c</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>",
    };
    // fullTemplate's styles.xml has no Caption style.
    const { bytes } = await exportDocx({
      templateBytes: fullTemplate(false),
      details: capDetails,
      template,
      deps,
    });
    const styles = readPart(bytes, "word/styles.xml");
    expect(styles).toContain('w:styleId="Caption"');
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain('<w:pStyle w:val="Caption"/>');
  });

  it("scroll-macro fixture output is byte-stable (deterministic golden)", async () => {
    const zooStorage =
      "<h1>Doc</h1>" +
      '<ac:structured-macro ac:name="scroll-only"><ac:parameter ac:name="exporter">word</ac:parameter><ac:rich-text-body><p>WORD_ONLY_KEEP</p></ac:rich-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="scroll-ignore"><ac:rich-text-body><p>IGNORED_DROP</p></ac:rich-text-body></ac:structured-macro>' +
      '<p>a</p><ac:structured-macro ac:name="scroll-pagebreak"/><p>b</p>' +
      '<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body><table><tbody><tr><td>wide</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="scroll-title"><ac:parameter ac:name="title">Zoo table</ac:parameter><ac:rich-text-body><table><tbody><tr><td>c</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>';
    const zooDetails: ConfluencePageDetails = {
      ...details,
      storage: zooStorage,
    };
    const input = {
      templateBytes: fullTemplate(false),
      details: zooDetails,
      template,
      exportDate: new Date(2026, 6, 20, 9, 0),
      deps,
    };
    const first = await exportDocx(input);
    const second = await exportDocx(input);
    const firstDoc = readPart(first.bytes, "word/document.xml");
    expect(firstDoc).toBe(readPart(second.bytes, "word/document.xml"));
    expect(readPart(first.bytes, "word/styles.xml")).toBe(readPart(second.bytes, "word/styles.xml"));
    // Pin the full serialized body across refactors (snapshot golden).
    expect(firstDoc).toMatchSnapshot("scroll-macro-feature-zoo-document-xml");
  });
});

// ---------------------------------------------------------------------------
// Cross-page include pass (spec 005 D1)
// ---------------------------------------------------------------------------
describe("exportDocx — $scroll.includepage (spec 005 D1)", () => {
  const SENTINEL = "IMPRINT_SENTINEL_9f3a";
  const includePage = (id: string, extraStorage = ""): ConfluencePageDetails => ({
    id,
    title: `Imprint ${id}`,
    spaceKey: "ENG",
    storage: `<p>${SENTINEL} ${id}</p>${extraStorage}`,
  });

  /** A getIncludedPage that resolves any ref to `page`, counting calls. */
  function resolver(pages: Record<string, ConfluencePageDetails>) {
    const calls: string[] = [];
    return {
      calls,
      getIncludedPage: async (ref: { pageId?: string; title?: string; spaceKey?: string }) => {
        calls.push(ref.pageId ?? `${ref.spaceKey ?? ""}:${ref.title ?? ""}`);
        const key = ref.pageId ?? ref.title ?? "";
        const page = pages[key];
        return page
          ? { kind: "resolved" as const, page }
          : { kind: "not-found-or-forbidden" as const };
      },
    };
  }

  const styledTemplate = (opts: { body: string; header?: string; footer?: string }) =>
    buildDocx({
      body: opts.body,
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      ...(opts.header ? { header: opts.header } : {}),
      ...(opts.footer ? { footer: opts.footer } : {}),
    });

  it("renders the same include target in BOTH body and header, fetched once", async () => {
    const page = includePage("Imprint");
    const { calls, getIncludedPage } = resolver({ Imprint: page });
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + para("$scroll.includepage.(ENG:Imprint)"),
        header: para("$scroll.includepage.(ENG:Imprint)"),
      }),
      details,
      template,
      deps: { ...deps, getIncludedPage },
    });
    const doc = readPart(bytes, "word/document.xml");
    const header = readPart(bytes, "word/header1.xml");
    expect(doc).toContain(SENTINEL);
    expect(header).toContain(SENTINEL);
    // One canonical ref key → exactly one fetch (cache hit on the 2nd occurrence).
    expect(calls).toEqual(["ENG:Imprint"]);
    for (const part of [doc, header]) {
      expect(part).not.toContain("$scroll.");
      assertBalancedXml(part);
    }
  });

  it("decodes an ADF-primary include once and never walks its Storage sidecar", async () => {
    const page: IncludePageDetails = {
      ...includePage("AdfInclude", "<p>STORAGE_SIDECAR_POISON</p>"),
      version: 4,
      exportSource: {
        primary: {
          representation: "atlas_doc_format",
          value: JSON.stringify({
            type: "doc",
            version: 1,
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "ADF_INCLUDE_SENTINEL" }],
            }],
          }),
        },
        storageSidecar: "<p>STORAGE_SIDECAR_POISON</p>",
        sourceVersion: 4,
      },
    };
    const { calls, getIncludedPage } = resolver({ AdfInclude: page });
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + para("$scroll.includepage.(AdfInclude)"),
      }),
      details,
      template,
      deps: { ...deps, getIncludedPage },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("ADF_INCLUDE_SENTINEL");
    expect(doc).not.toContain("STORAGE_SIDECAR_POISON");
    expect(calls).toEqual([":AdfInclude"]);
  });

  it("correlates an ADF include image by v2 fileId before asset embedding", async () => {
    const page: IncludePageDetails = {
      ...includePage("AdfMedia"),
      exportSource: {
        primary: {
          representation: "atlas_doc_format",
          value: JSON.stringify({
            type: "doc",
            version: 1,
            content: [{
              type: "mediaSingle",
              content: [{
                type: "media",
                attrs: {
                  type: "file",
                  id: "file-1",
                  collection: "content-1",
                  alt: "Included image",
                },
              }],
            }],
          }),
        },
        sourceVersion: 1,
      },
      mediaAttachments: [{ fileId: "file-1", filename: "included.png", pageId: "AdfMedia" }],
      mediaAttachmentsComplete: true,
    };
    const fetched: Array<{ filename?: string; pageId?: string }> = [];
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + para("$scroll.includepage.(AdfMedia)"),
      }),
      details,
      template,
      deps: { ...deps, getIncludedPage: resolver({ AdfMedia: page }).getIncludedPage },
      assets: {
        async fetch(ref) {
          fetched.push({ filename: ref.filename, pageId: ref.pageId });
          return pngFixtureBytes(120, 60);
        },
      },
    });

    expect(readPart(bytes, "word/document.xml")).toContain("<w:drawing>");
    expect(fetched).toContainEqual({ filename: "included.png", pageId: "AdfMedia" });
    expect(report.notes.map((note) => note.code)).not.toContain("adf-media-unresolved");
  });

  it("bounds ADF include sidecars separately from primary body bytes", async () => {
    const page: IncludePageDetails = {
      ...includePage("SidecarBudget"),
      exportSource: {
        primary: {
          representation: "atlas_doc_format",
          value: JSON.stringify({
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "SMALL_ADF" }] }],
          }),
        },
        storageSidecar: "x".repeat(2 * 1024 * 1024 + 1),
        sourceVersion: 1,
      },
    };
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + para("$scroll.includepage.(SidecarBudget)"),
      }),
      details,
      template,
      deps: {
        ...deps,
        getIncludedPage: async () => ({ kind: "resolved", page }),
      },
    });
    expect(readPart(bytes, "word/document.xml")).not.toContain("SMALL_ADF");
    expect(report.notes.some((note) => note.code === "includepage-budget-exceeded")).toBe(true);
  });

  it("renders two occurrences of the same include in one part with one fetch", async () => {
    const { calls, getIncludedPage } = resolver({ Imprint: includePage("Imprint") });
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({
        body:
          para("$scroll.content") +
          para("$scroll.includepage.(ENG:Imprint)") +
          para("$scroll.includepage.(ENG:Imprint)"),
      }),
      details,
      template,
      deps: { ...deps, getIncludedPage },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc.match(new RegExp(SENTINEL, "g"))?.length).toBe(2);
    expect(calls).toEqual(["ENG:Imprint"]);
  });

  it("finds and replaces a run-split include token", async () => {
    const { getIncludedPage } = resolver({ Imprint: includePage("Imprint") });
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + runSplitPara(["$scroll.includepage.", "(ENG:Imprint)"]),
      }),
      details,
      template,
      deps: { ...deps, getIncludedPage },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain(SENTINEL);
    expect(doc).not.toContain("$scroll.");
  });

  it("does NOT expand a non-atomic paragraph; surrounding text survives verbatim", async () => {
    const { calls, getIncludedPage } = resolver({ Imprint: includePage("Imprint") });
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({
        body:
          para("$scroll.content") +
          para("See our disclaimer: $scroll.includepage.(ENG:Imprint)") +
          para("$scroll.includepage.(A) and $scroll.includepage.(B)"),
      }),
      details,
      template,
      deps: { ...deps, getIncludedPage },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("See our disclaimer: ");
    expect(doc).not.toContain(SENTINEL); // never expanded
    expect(doc).not.toContain("$scroll."); // but token still blanked
    // No fetch happened for a non-atomic paragraph.
    expect(calls).toHaveLength(0);
    expect(report.notes.filter((n) => n.code === "includepage-invalid-context")).toHaveLength(2);
  });

  it("blanks every failure class with its OWN distinct note code (no literal)", async () => {
    const cases: Array<[string, { kind: string; message?: string }, string]> = [
      ["nf", { kind: "not-found-or-forbidden" }, "includepage-unresolved"],
      ["auth", { kind: "auth-failed" }, "includepage-auth-failed"],
      ["rl", { kind: "rate-limited" }, "includepage-rate-limited"],
      ["tr", { kind: "transient-error", message: "socket hangup" }, "includepage-transient-error"],
    ];
    for (const [arg, outcome, code] of cases) {
      const { bytes, report } = await exportDocx({
        templateBytes: styledTemplate({
          body: para("$scroll.content") + para(`$scroll.includepage.(${arg})`),
        }),
        details,
        template,
        deps: { ...deps, getIncludedPage: async () => outcome as never },
      });
      const doc = readPart(bytes, "word/document.xml");
      expect(doc).not.toContain("$scroll.");
      expect(report.notes.some((n) => n.code === code)).toBe(true);
    }
  });

  it("treats an absent getIncludedPage dep as a transient failure (no literal)", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + para("$scroll.includepage.(ENG:Imprint)"),
      }),
      details,
      template,
      deps,
    });
    expect(readPart(bytes, "word/document.xml")).not.toContain("$scroll.");
    expect(report.notes.some((n) => n.code === "includepage-transient-error")).toBe(true);
  });

  it("still renders an ambiguous title, noting the count", async () => {
    const page = includePage("Dup");
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + para("$scroll.includepage.(Dup)"),
      }),
      details,
      template,
      deps: {
        ...deps,
        getIncludedPage: async () => ({ kind: "ambiguous" as const, count: 3, page }),
      },
    });
    expect(readPart(bytes, "word/document.xml")).toContain(SENTINEL);
    const note = report.notes.find((n) => n.code === "includepage-ambiguous-title");
    expect(note?.message).toContain("3");
  });

  it("blocks self-include with includepage-cycle but NOT a non-self repeat", async () => {
    // The exported page id is `123`. A pageId ref to itself is a cycle; a
    // different target referenced twice (body+header) must NOT be flagged.
    const other = includePage("Imprint");
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({
        body:
          para("$scroll.content") +
          para("$scroll.includepage.(123)") +
          para("$scroll.includepage.(ENG:Imprint)"),
        header: para("$scroll.includepage.(ENG:Imprint)"),
      }),
      details,
      template,
      deps: { ...deps, getIncludedPage: resolver({ Imprint: other }).getIncludedPage },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("$scroll.");
    expect(report.notes.filter((n) => n.code === "includepage-cycle")).toHaveLength(1);
    // The non-self target still rendered in both parts.
    expect(doc).toContain(SENTINEL);
    expect(readPart(bytes, "word/header1.xml")).toContain(SENTINEL);
  });

  it("embeds an included FOOTER page's image into footer1.xml.rels, not document.xml.rels", async () => {
    const footerPage = includePage(
      "Imprint",
      '<ac:image><ri:attachment ri:filename="inc.png"/></ac:image>'
    );
    const fetchedRefs: { url: string; pageId?: string }[] = [];
    const assets = {
      async fetch(ref: { url: string; pageId?: string }) {
        fetchedRefs.push(ref);
        return pngFixtureBytes(120, 60);
      },
    };
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({
        // The exported page's own body also carries an image → document.xml.rels.
        body: para("$scroll.content"),
        footer: para("$scroll.includepage.(ENG:Imprint)"),
      }),
      details: {
        ...details,
        storage: '<p>own</p><ac:image><ri:attachment ri:filename="own.png"/></ac:image>',
      },
      template,
      deps: { ...deps, getIncludedPage: resolver({ Imprint: footerPage }).getIncludedPage },
      assets,
    });
    const footer = readPart(bytes, "word/footer1.xml");
    expect(footer).toContain("<w:drawing>");
    assertBalancedXml(footer);
    const footerRels = readPart(bytes, "word/_rels/footer1.xml.rels");
    expect(footerRels).toContain("relationships/image");
    // The exported page's own body image is in the document part's rels.
    expect(readPart(bytes, "word/_rels/document.xml.rels")).toContain("relationships/image");
    // The included image was fetched from the INCLUDED page's id, not the root.
    expect(fetchedRefs.some((r) => r.url.includes("/attachments/Imprint/inc.png"))).toBe(true);
  });

  it("embeds an included FOOTER page's Mermaid diagram into footer1.xml.rels, not document.xml.rels", async () => {
    // The included footer page's ONLY content is a mermaid diagram; the diagram
    // seam must thread the occurrence's part so the svgBlip/PNG relationships
    // land in the footer's rels (dangling-relationship regression for diagrams).
    const diagramPage: ConfluencePageDetails = {
      id: "Imprint",
      title: "Imprint",
      spaceKey: "ENG",
      storage:
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[graph TD\n  A --> B]]></ac:plain-text-body></ac:structured-macro>",
    };
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content"),
        footer: para("$scroll.includepage.(ENG:Imprint)"),
      }),
      details: { ...details, storage: "<p>own body, no diagram</p>" },
      template,
      deps: { ...deps, getIncludedPage: resolver({ Imprint: diagramPage }).getIncludedPage },
      rasterizer: {
        async rasterize(_svg: string, target: { widthPx: number; heightPx: number }) {
          return pngFixtureBytes(target.widthPx, target.heightPx);
        },
      },
    });
    expect(report.renderedDiagrams).toBe(1);
    const footer = readPart(bytes, "word/footer1.xml");
    expect(footer).toContain("<w:drawing>");
    assertBalancedXml(footer);
    // The diagram's svgBlip/PNG relationships live in the FOOTER's rels…
    expect(readPart(bytes, "word/_rels/footer1.xml.rels")).toContain("relationships/image");
    // …and NOT in the document part (whose own body carries no diagram).
    expect(readPart(bytes, "word/_rels/document.xml.rels")).not.toContain("relationships/image");
    expect(readPart(bytes, "word/document.xml")).not.toContain("<w:drawing>");
  });

  it("synthesizes the code style when only an included page carries a code macro", async () => {
    const codePage: ConfluencePageDetails = {
      id: "Imprint",
      title: "Imprint",
      spaceKey: "ENG",
      storage:
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>",
    };
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({
        body: para("$scroll.content") + para("$scroll.includepage.(ENG:Imprint)"),
      }),
      details: { ...details, storage: "<p>plain</p>" },
      template,
      deps: { ...deps, getIncludedPage: resolver({ Imprint: codePage }).getIncludedPage },
    });
    expect(readPart(bytes, "word/styles.xml")).toContain('w:styleId="AtlcliCode"');
    expect(readPart(bytes, "word/fontTable.xml")).toContain(
      '<w:font w:name="JetBrains Mono">',
    );
    expect(readPart(bytes, "word/_rels/fontTable.xml.rels")).toContain(
      "relationships/font",
    );
    expect(
      new PizZip(bytes)
        .file("word/fonts/atlcli-code-001b70dc-aa60-4ad5-90ec-18a0948e1eae.odttf")
        ?.asUint8Array().byteLength,
    ).toBeGreaterThan(250_000);
  });

  it("embeds the code face for inline code without requiring a code-block style", async () => {
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({ body: para("$scroll.content") }),
      details: { ...details, storage: "<p>before <code>INLINE_TOKEN</code> after</p>" },
      template,
      deps,
    });
    const zip = new PizZip(bytes);
    expect(readPart(bytes, "word/document.xml")).toContain("INLINE_TOKEN");
    expect(readPart(bytes, "word/document.xml")).toContain(
      'w:rFonts w:ascii="JetBrains Mono"',
    );
    expect(readPart(bytes, "word/styles.xml")).not.toContain('w:styleId="AtlcliCode"');
    expect(Object.keys(zip.files).filter((path) => path.endsWith(".odttf"))).toEqual([
      "word/fonts/atlcli-code-001b70dc-aa60-4ad5-90ec-18a0948e1eae.odttf",
    ]);
  });

  it("does not add font parts to a document with no code semantics", async () => {
    const { bytes } = await exportDocx({
      templateBytes: styledTemplate({ body: para("$scroll.content") }),
      details: { ...details, storage: "<p>plain text only</p>" },
      template,
      deps,
    });
    const zip = new PizZip(bytes);
    expect(Object.keys(zip.files).some((path) => path.endsWith(".odttf"))).toBe(false);
    expect(zip.file("word/fontTable.xml")).toBeNull();
  });

  it("enforces the unique-target budget deterministically (cache still serves repeats)", async () => {
    // 26 distinct targets + 1 repeat of the first. The 26th unique target is
    // over the 25-page cap and blanks; the repeat of #1 still renders (cache).
    const pages: Record<string, ConfluencePageDetails> = {};
    let body = para("$scroll.content");
    for (let i = 1; i <= 26; i++) {
      const id = `P${i}`;
      pages[id] = includePage(id);
      body += para(`$scroll.includepage.(${id})`);
    }
    body += para("$scroll.includepage.(P1)"); // repeat of an accepted target
    const { bytes, report } = await exportDocx({
      templateBytes: styledTemplate({ body }),
      details,
      template,
      deps: { ...deps, getIncludedPage: resolver(pages).getIncludedPage },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).not.toContain("$scroll.");
    expect(doc).toContain(`${SENTINEL} P1`); // first accepted + its later repeat
    expect(doc).toContain(`${SENTINEL} P25`);
    expect(doc).not.toContain(`${SENTINEL} P26`); // over budget → blanked
    expect(report.notes.filter((n) => n.code === "includepage-budget-exceeded")).toHaveLength(1);
    // The repeat of P1 renders → P1 sentinel appears twice.
    expect(doc.match(new RegExp(`${SENTINEL} P1\\b`, "g"))?.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SVG attachment embedding (spec 006 G4)
// ---------------------------------------------------------------------------

describe("exportDocx — SVG attachment embedding (spec 006 G4)", () => {
  const svgTemplate = () =>
    buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });

  const svgStorage = (filename = "arch.svg") =>
    `<ac:image><ri:attachment ri:filename="${filename}"/></ac:image>`;

  /** A rasterizer recording calls, serving real PNG fixture bytes at the target size. */
  function recordingRasterizer() {
    const calls: { svg: string; widthPx: number; heightPx: number }[] = [];
    return {
      calls,
      rasterizer: {
        async rasterize(svg: string, target: { widthPx: number; heightPx: number }) {
          calls.push({ svg, ...target });
          return pngFixtureBytes(target.widthPx, target.heightPx);
        },
      },
    };
  }

  const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60"/></svg>';

  it("embeds a clean SVG attachment as svgBlip + PNG@2x, counting as an image not a diagram", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    const { bytes, report } = await exportDocx({
      templateBytes: svgTemplate(),
      details: { ...details, storage: svgStorage() },
      template,
      deps,
      assets: { fetch: async () => new TextEncoder().encode(CLEAN_SVG) },
      rasterizer,
    });

    // Rasterized once at 2× the intrinsic display size.
    expect(calls).toHaveLength(1);
    expect(calls[0].widthPx).toBe(240);
    expect(calls[0].heightPx).toBe(120);

    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("<w:drawing>");
    expect(doc).toContain("<asvg:svgBlip");
    const rels = readPart(bytes, "word/_rels/document.xml.rels");
    expect(rels).toContain('Target="media/atlcli-image1.svg"');
    expect(rels).toContain('Target="media/atlcli-image2.png"');

    // Counters: an SVG attachment is an image, not a rendered diagram.
    expect(report.embeddedImages).toBe(1);
    expect(report.renderedDiagrams).toBe(0);
    expect(report.skippedImages).toBe(0);
  });

  it("uses the 600×400 default with an info note when the SVG has no intrinsic size", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    const noSize = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const { report } = await exportDocx({
      templateBytes: svgTemplate(),
      details: { ...details, storage: svgStorage() },
      template,
      deps,
      assets: { fetch: async () => new TextEncoder().encode(noSize) },
      rasterizer,
    });
    // Width capped to 600 → 2× = 1200; height 400 → 2× = 800.
    expect(calls[0].widthPx).toBe(1200);
    expect(calls[0].heightPx).toBe(800);
    expect(report.notes.some((n) => n.code === "image-svg-default-size")).toBe(true);
    expect(report.embeddedImages).toBe(1);
  });

  it("rejects a hostile <script> SVG with a note and leaves the archive untouched", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { bytes, report } = await exportDocx({
      templateBytes: svgTemplate(),
      details: { ...details, storage: svgStorage() },
      template,
      deps,
      assets: { fetch: async () => new TextEncoder().encode(hostile) },
      rasterizer,
    });
    expect(calls).toHaveLength(0); // never rasterized
    const note = report.notes.find((n) => n.message.includes("active or externally loaded"));
    expect(note).toBeDefined();
    expect(report.embeddedImages).toBe(0);
    expect(report.skippedImages).toBe(1);
    const zip = new PizZip(bytes);
    expect(Object.keys(zip.files).some((p) => p.startsWith("word/media/"))).toBe(false);
  });

  it("rejects a UTF-16LE + BOM <script> SVG end-to-end (spec 011 must-reject)", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    // Encode UTF-16LE with a BOM — a naive UTF-8 decode would garble it and hide
    // the <script>; the BOM-aware seam decodes it and the scanner rejects it.
    const bytes = new Uint8Array(2 + hostile.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < hostile.length; i++) {
      const c = hostile.charCodeAt(i);
      bytes[2 + i * 2] = c & 0xff;
      bytes[3 + i * 2] = c >> 8;
    }
    const { bytes: out, report } = await exportDocx({
      templateBytes: svgTemplate(),
      details: { ...details, storage: svgStorage() },
      template,
      deps,
      assets: { fetch: async () => bytes },
      rasterizer,
    });
    expect(calls).toHaveLength(0); // never rasterized
    expect(report.notes.some((n) => n.message.includes("active or externally loaded"))).toBe(true);
    expect(report.embeddedImages).toBe(0);
    expect(report.skippedImages).toBe(1);
    const zip = new PizZip(out);
    expect(Object.keys(zip.files).some((p) => p.startsWith("word/media/"))).toBe(false);
  });

  it("rejects a CSS-carried external reference SVG", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    const cssHostile =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>.a{background:url(https://evil/x)}</style></svg>';
    const { report } = await exportDocx({
      templateBytes: svgTemplate(),
      details: { ...details, storage: svgStorage() },
      template,
      deps,
      assets: { fetch: async () => new TextEncoder().encode(cssHostile) },
      rasterizer,
    });
    expect(calls).toHaveLength(0);
    expect(report.notes.some((n) => n.message.includes("active or externally loaded"))).toBe(true);
    expect(report.skippedImages).toBe(1);
  });

  it("degrades an oversized SVG with image-svg-oversized, never invoking the rasterizer", async () => {
    const { calls, rasterizer } = recordingRasterizer();
    // Author dimensions force a pathological target: width capped to 600, but an
    // extreme aspect ratio via viewBox pushes the height past the axis budget.
    const huge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1000000"><rect/></svg>';
    const { report } = await exportDocx({
      templateBytes: svgTemplate(),
      details: { ...details, storage: svgStorage() },
      template,
      deps,
      assets: { fetch: async () => new TextEncoder().encode(huge) },
      rasterizer,
    });
    expect(calls).toHaveLength(0);
    expect(report.notes.some((n) => n.code === "image-svg-oversized")).toBe(true);
    expect(report.skippedImages).toBe(1);
    expect(report.embeddedImages).toBe(0);
  });

  it("counters: one diagram + one successful SVG + one skipped SVG → (1,1,1)", async () => {
    // The rasterizer is export-wide, so a single export cannot mix a "no
    // rasterizer" SVG with a successfully-rasterized diagram. The DoD's exact
    // (renderedDiagrams=1, embeddedImages=1, skippedImages=1) triple is achieved
    // with a rasterizer present and the third asset degrading for a different
    // reason (an oversized SVG) — the reporting semantics are identical, and the
    // no-rasterizer path is asserted separately above.
    const { rasterizer } = recordingRasterizer();
    const assets = {
      async fetch(ref: { url: string; filename?: string }) {
        const huge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1000000"><rect/></svg>';
        const isHuge = (ref.filename ?? ref.url).includes("huge");
        return new TextEncoder().encode(isHuge ? huge : CLEAN_SVG);
      },
    };
    const storage =
      `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[graph TD\n A --> B]]></ac:plain-text-body></ac:structured-macro>` +
      svgStorage("clean.svg") +
      svgStorage("huge.svg");
    const { report } = await exportDocx({
      templateBytes: svgTemplate(),
      details: { ...details, storage },
      template,
      deps,
      assets,
      rasterizer,
    });
    expect(report.renderedDiagrams).toBe(1);
    expect(report.embeddedImages).toBe(1);
    expect(report.skippedImages).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Table column widths + table style source (spec 006 G3/G3b)
// ---------------------------------------------------------------------------

describe("exportDocx — table widths & style source (spec 006 G3/G3b)", () => {
  const tableStorage =
    '<table><colgroup><col style="width: 100px"/><col style="width: 300px"/></colgroup>' +
    "<tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr>" +
    "<tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>";

  const tmpl = (extraStyles = "") =>
    buildDocx({ body: para("$scroll.content"), styles: stylesXml(headingStyle("Heading1", "Heading 1") + extraStyles) });

  const detailsFor = (storage: string): ConfluencePageDetails => ({ ...details, storage });

  it("honors colgroup widths as non-uniform w:gridGrid summing to 9000 (G3)", async () => {
    const { bytes } = await exportDocx({ templateBytes: tmpl(), details: detailsFor(tableStorage), template, deps });
    const doc = readPart(bytes, "word/document.xml");
    const cols = [...doc.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(cols).toEqual([2250, 6750]);
    expect(cols.reduce((s, w) => s + w, 0)).toBe(9000);
    expect(doc).toContain('<w:tblLayout w:type="fixed"/>');
  });

  it("source template resolves 'Scroll Table Normal' and omits inline borders (G3b)", async () => {
    const { bytes } = await exportDocx({
      templateBytes: tmpl(headingStyle("ScrollTableNormalId", "Scroll Table Normal")),
      details: detailsFor(tableStorage),
      template,
      deps,
      tableStyle: { source: "template" },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain('<w:tblStyle w:val="ScrollTableNormalId"/>');
    expect(doc).not.toContain("<w:tblBorders>");
  });

  it("source template with an undefined style falls back to the grid + a note (G3b)", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: tmpl(),
      details: detailsFor(tableStorage),
      template,
      deps,
      tableStyle: { source: "template" },
    });
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain('<w:tblStyle w:val="TableGrid"/>');
    expect(report.notes.some((n) => n.code === "table-style-missing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Alt-text audit through the real export pipeline (spec 011, PDF/UA lane)
// ---------------------------------------------------------------------------

describe("exportDocx — alt-text audit (spec 011)", () => {
  const imageTemplate = () =>
    buildDocx({ body: para("$scroll.content"), styles: stylesXml(headingStyle("Heading1", "Heading 1")) });

  const altNotes = (report: { notes: { code: string }[] }) =>
    report.notes.filter((n) => n.code === "image-missing-alt");

  it("warns for an embedded attachment image with no alt and names the asset", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<ac:image><ri:attachment ri:filename="chart-final-v2.png"/></ac:image>',
      },
      template,
      deps,
      assets: { fetch: async () => pngFixtureBytes(120, 60) },
    });
    // The image really is embedded — this is an audit, not a rejection.
    expect(report.embeddedImages).toBe(1);
    expect(altNotes(report)).toHaveLength(1);
    expect(altNotes(report)[0]).toMatchObject({
      level: "warning",
      source: { assetName: "chart-final-v2.png" },
    });
    // …and the descr it is warning about is the filename fallback.
    expect(readPart(bytes, "word/document.xml")).toContain('descr="chart-final-v2.png"');
  });

  it("stays silent when the author wrote alt text", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<ac:image ac:alt="Quarterly revenue by region"><ri:attachment ri:filename="chart.png"/></ac:image>',
      },
      template,
      deps,
      assets: { fetch: async () => pngFixtureBytes(120, 60) },
    });
    expect(report.embeddedImages).toBe(1);
    expect(altNotes(report)).toEqual([]);
    expect(readPart(bytes, "word/document.xml")).toContain('descr="Quarterly revenue by region"');
  });

  it("audits each offending image once, leaving described ones alone", async () => {
    const { report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage:
          '<ac:image><ri:attachment ri:filename="a.png"/></ac:image>' +
          '<ac:image ac:alt="described"><ri:attachment ri:filename="b.png"/></ac:image>' +
          '<ac:image><ri:attachment ri:filename="c.png"/></ac:image>',
      },
      template,
      deps,
      assets: {
        fetch: async (ref: { filename?: string }) =>
          pngFixtureBytes(100 + (ref.filename?.charCodeAt(0) ?? 0), 50),
      },
    });
    expect(report.embeddedImages).toBe(3);
    expect(altNotes(report).map((n) => (n as { source?: { assetName?: string } }).source?.assetName)).toEqual([
      "a.png",
      "c.png",
    ]);
  });

  it("audits an SVG attachment too — the vector path has the same fallback", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60"/></svg>';
    const { report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: { ...details, storage: '<ac:image><ri:attachment ri:filename="arch.svg"/></ac:image>' },
      template,
      deps,
      assets: { fetch: async () => new TextEncoder().encode(svg) },
      rasterizer: {
        async rasterize(_svg: string, target: { widthPx: number; heightPx: number }) {
          return pngFixtureBytes(target.widthPx, target.heightPx);
        },
      },
    });
    expect(report.embeddedImages).toBe(1);
    expect(altNotes(report)).toHaveLength(1);
    expect(altNotes(report)[0]).toMatchObject({ source: { assetName: "arch.svg" } });
  });

  it("audits an image that FAILED to embed, matching the PDF engine", async () => {
    // The defect belongs to the source page, not to the embed attempt: a
    // broken image with no alt text still needs alt text once the attachment
    // is fixed. Routing this through the serializer's per-image outcome
    // channel would silence it (the serializer reads outcome notes only on
    // success), which is why the seam has a separate audit sink.
    const { report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: { ...details, storage: '<ac:image><ri:attachment ri:filename="gone.png"/></ac:image>' },
      template,
      deps,
      assets: {
        fetch: async () => {
          throw new Error("404");
        },
      },
    });
    expect(report.embeddedImages).toBe(0);
    expect(altNotes(report)).toHaveLength(1);
    expect(report.notes.some((n) => n.code === "image-embed-failed")).toBe(true);
  });

  it("does not audit a failed image that DID carry alt text", async () => {
    // Guards the guard: the audit must key on the alt text, not merely fire
    // for every image that reaches the seam.
    const { report } = await exportDocx({
      templateBytes: imageTemplate(),
      details: {
        ...details,
        storage: '<ac:image ac:alt="described"><ri:attachment ri:filename="gone.png"/></ac:image>',
      },
      template,
      deps,
      assets: {
        fetch: async () => {
          throw new Error("404");
        },
      },
    });
    expect(altNotes(report)).toEqual([]);
    expect(report.notes.some((n) => n.code === "image-embed-failed")).toBe(true);
  });
});
