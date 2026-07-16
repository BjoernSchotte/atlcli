/**
 * Real-infrastructure proof of the Node rasterizer (spec 005a Node leg):
 * the actual resvg wasm renders actual beautiful-mermaid SVGs to actual PNG
 * bytes — decoded back through the engine's own header decoder — with the
 * bundled Inter/JetBrains Mono fonts standing in for the system fonts the
 * wasm build deliberately cannot see. No mocks anywhere.
 */
import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import { renderDiagram } from "@atlcli/diagram";
import { exportDocx } from "./export.js";
import { buildDocx, para, stylesXml } from "./fixtures.js";
import { decodeImageInfo } from "./image.js";
import { bundledDiagramFonts, resvgSvgRasterizer } from "./node-adapters.js";

const FLOWCHART = "graph TD\n  A[Start] --> B{Is it good?}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Fix it]";

async function renderedFlowchart() {
  const rendered = await renderDiagram(FLOWCHART);
  if (rendered.kind !== "svg") throw new Error(`expected svg, got ${rendered.kind}`);
  return rendered;
}

describe("resvgSvgRasterizer (real wasm, real fonts)", () => {
  it("rasterizes a rendered mermaid SVG to a real PNG at the requested 2× size", async () => {
    const rendered = await renderedFlowchart();
    const png = await resvgSvgRasterizer().rasterize(rendered.svg, {
      widthPx: rendered.widthPx * 2,
      heightPx: rendered.heightPx * 2,
    });

    const info = decodeImageInfo(png);
    expect(info?.format).toBe("png");
    expect(info?.width).toBe(rendered.widthPx * 2);
    // fitTo is width-driven; height follows the preserved aspect ratio.
    expect(info?.height).toBeGreaterThanOrEqual(rendered.heightPx * 2 - 2);
    expect(info?.height).toBeLessThanOrEqual(rendered.heightPx * 2 + 2);
  });

  it("bundles the families beautiful-mermaid names, and they actually paint text", async () => {
    const fonts = await bundledDiagramFonts();
    // Inter ×5 + JetBrains Mono ×2, each a real sfnt (TTF magic 0x00010000).
    expect(fonts.length).toBe(7);
    for (const font of fonts) {
      expect([...font.slice(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
    }

    // The observable for "fonts work": glyphs add pixel data. The same
    // diagram rasterized with NO fonts loses all its text (resvg drops
    // unmatchable text) and compresses far smaller.
    const rendered = await renderedFlowchart();
    const target = { widthPx: rendered.widthPx * 2, heightPx: rendered.heightPx * 2 };
    const withFonts = await resvgSvgRasterizer().rasterize(rendered.svg, target);
    const withoutFonts = await resvgSvgRasterizer({ fonts: [] }).rasterize(rendered.svg, target);
    expect(withFonts.length).toBeGreaterThan(withoutFonts.length * 1.2);
  });

  it("drives the full export: the DOCX media PNG decodes, the svgBlip SVG is var()-free", async () => {
    const storage =
      `<p>before</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[${FLOWCHART}]]></ac:plain-text-body></ac:structured-macro>`;
    const { bytes, report } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content"), styles: stylesXml() }),
      details: {
        id: "1",
        title: "Diagram page",
        spaceKey: "DOC",
        storage,
        version: 1,
      },
      template: { name: "t.docx", modificationDate: new Date("2026-01-01") },
      deps: {},
      rasterizer: resvgSvgRasterizer(),
    });

    expect(report.renderedDiagrams).toBe(1);
    const zip = new PizZip(bytes);
    const png = new Uint8Array(zip.file("word/media/atlcli-image2.png")!.asUint8Array());
    const info = decodeImageInfo(png);
    expect(info?.format).toBe("png");
    expect(info!.width).toBeGreaterThan(0);

    const svgPart = zip.file("word/media/atlcli-image1.svg")!.asText();
    expect(svgPart).not.toContain("var(");
    expect(svgPart).not.toContain("color-mix(");
    expect(svgPart).toContain("Ship it");
  });
});
