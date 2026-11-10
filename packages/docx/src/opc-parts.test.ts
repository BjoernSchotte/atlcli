import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import {
  addRelationship,
  ensureContentTypeDefault,
  ensureContentTypeOverride,
  registerDocumentPart,
} from "./opc-parts.js";

const TYPES = (inner: string): string =>
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${inner}</Types>`;
const RELS = (inner: string): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function zipWith(contentTypes: string, documentRels?: string): PizZip {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", contentTypes);
  if (documentRels !== undefined) zip.file("word/_rels/document.xml.rels", documentRels);
  return zip;
}
const count = (zip: PizZip, path: string, needle: RegExp): number =>
  (zip.file(path)!.asText().match(needle) ?? []).length;

describe("OPC part registration", () => {
  it("does not declare a content type twice when the template quotes with apostrophes", () => {
    const zip = zipWith(
      TYPES(
        `<Default Extension='png' ContentType='image/png'/>` +
          `<Override PartName='/word/settings.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'/>` +
          `<Override PartName='/word/fontTable.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'/>`
      )
    );
    ensureContentTypeDefault(zip, "png", "image/png");
    ensureContentTypeOverride(zip, "word/fontTable.xml", "x/y");
    registerDocumentPart(zip, "settings");
    expect(count(zip, "[Content_Types].xml", /Extension=/g)).toBe(1);
    expect(count(zip, "[Content_Types].xml", /PartName=/g)).toBe(2);
  });

  it("adds what is missing, once", () => {
    const zip = zipWith(TYPES(""));
    for (let i = 0; i < 2; i += 1) {
      ensureContentTypeDefault(zip, "png", "image/png");
      registerDocumentPart(zip, "numbering");
      registerDocumentPart(zip, "comments");
    }
    const types = zip.file("[Content_Types].xml")!.asText();
    expect(types).toContain(`<Default Extension="png" ContentType="image/png"/>`);
    expect(types).toContain(
      `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`
    );
    expect(count(zip, "[Content_Types].xml", /PartName=/g)).toBe(2);
    const rels = zip.file("word/_rels/document.xml.rels")!.asText();
    expect(rels).toContain(`<Relationship Id="rId1" Type="${OFFICE}/numbering" Target="numbering.xml"/>`);
    expect(rels).toContain(`<Relationship Id="rId2" Type="${OFFICE}/comments" Target="comments.xml"/>`);
    expect(count(zip, "word/_rels/document.xml.rels", /<Relationship /g)).toBe(2);
  });

  it("keeps a template's own settings relationship, whatever its target and quoting", () => {
    const zip = zipWith(
      TYPES(""),
      RELS(
        `<Relationship Id='rId7' Type='${OFFICE}/settings' Target='docSettings.xml'/>` +
          `<Relationship Id='rId8' Type='${OFFICE}/webSettings' Target='webSettings.xml'/>`
      )
    );
    registerDocumentPart(zip, "settings");
    expect(count(zip, "word/_rels/document.xml.rels", /<Relationship /g)).toBe(2);
  });

  it("allocates the next relationship id past ids in either quote style", () => {
    const zip = zipWith(TYPES(""), RELS(`<Relationship Id='rId4' Type='t' Target='a'/><Relationship Id="rId2" Type="t" Target="b"/>`));
    expect(addRelationship(zip, "word/document.xml", `${OFFICE}/image`, "media/x.png")).toBe("rId5");
    expect(addRelationship(zip, "word/header1.xml", `${OFFICE}/image`, "media/x.png")).toBe("rId1");
    expect(zip.file("word/_rels/header1.xml.rels")!.asText()).toContain(`Target="media/x.png"`);
  });
});
