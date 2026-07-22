import { describe, expect, it } from "bun:test";
import { buildDocx, para, readPart } from "./fixtures.js";

/**
 * Reproducible-build guard (spec 009): PizZip stamps each entry with
 * `new Date()` (2-second resolution) by default, so two independent `buildDocx`
 * calls could differ by a few bytes across a 2-second boundary — a flaky failure
 * whenever a build is byte-compared as a fixed asset (see
 * `@atlcli/export-node`'s `bundledDefaultTemplate`). A pinned `date` must make
 * the archive fully byte-reproducible.
 */
describe("buildDocx date pinning", () => {
  const opts = { body: "<w:p/>", date: new Date("2020-01-01T00:00:00.000Z") };

  it("is byte-reproducible across independent calls when the date is pinned", () => {
    expect(buildDocx(opts)).toEqual(buildDocx(opts));
  });

  it("wires the pinned date through to the zip entry timestamps", () => {
    const early = buildDocx({ ...opts, date: new Date("2020-01-01T00:00:00.000Z") });
    const late = buildDocx({ ...opts, date: new Date("2021-06-15T12:00:00.000Z") });
    // Different pinned timestamps → different bytes, proving the date is not ignored.
    expect(early).not.toEqual(late);
  });
});

describe("buildDocx story relationships", () => {
  it("attaches header and footer parts to the document section", () => {
    const bytes = buildDocx({
      body: para("body"),
      header: para("header"),
      footer: para("footer"),
    });

    const document = readPart(bytes, "word/document.xml");
    const relationships = readPart(bytes, "word/_rels/document.xml.rels");
    expect(document).toContain(
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    );
    expect(document).toContain('<w:headerReference w:type="default" r:id="rIdH1"/>');
    expect(document).toContain('<w:footerReference w:type="default" r:id="rIdF2"/>');
    expect(relationships).toContain('Id="rIdH1"');
    expect(relationships).toContain('Id="rIdF2"');
  });

  it("uses the actual footer relationship id when no header exists", () => {
    const bytes = buildDocx({ body: para("body"), footer: para("footer") });
    const document = readPart(bytes, "word/document.xml");

    expect(document).not.toContain("w:headerReference");
    expect(document).toContain('<w:footerReference w:type="default" r:id="rIdF1"/>');
  });
});
