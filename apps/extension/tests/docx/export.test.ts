import { describe, expect, it } from "bun:test";
import type { ConfluencePageDetails, ConfluenceSpace } from "@atlcli/confluence/browser";
import { exportDocx } from "../../utils/docx/export.js";
import type { CurrentUser } from "../../utils/docx/resolver.js";
import { buildDocx, headingStyle, para, readPart, runSplitPara, stylesXml } from "./fixtures.js";

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
