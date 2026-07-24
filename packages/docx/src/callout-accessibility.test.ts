import { describe, expect, it } from "bun:test";
import { inlineImageRun } from "./image.js";

describe("semantic callout icon accessibility spikes", () => {
  it("can label an inline drawing through target-specific replacement text", () => {
    const xml = inlineImageRun({
      relId: "rId1",
      docPrId: 1,
      name: "Warning callout icon",
      accessibility: { kind: "labelled", description: "Warning" },
      cxEmu: 152400,
      cyEmu: 152400,
    });

    expect(xml).toContain(
      '<wp:docPr id="1" name="Warning callout icon" descr="Warning"/>',
    );
    expect(xml).toContain(
      '<pic:cNvPr id="1" name="Warning callout icon" descr="Warning"/>',
    );
    expect(xml).not.toContain("adec:decorative");
  });

  it("can exclude a decorative inline drawing from Office assistive text", () => {
    const xml = inlineImageRun({
      relId: "rId1",
      docPrId: 1,
      name: "Warning callout icon",
      accessibility: { kind: "decorative" },
      cxEmu: 152400,
      cyEmu: 152400,
    });

    expect(xml).toContain(
      '<adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/>',
    );
    expect(xml).not.toContain("descr=");
    expect(xml).not.toContain("<w:t>");
  });
});
