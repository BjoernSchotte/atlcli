/**
 * OOXML image module tests (spec 005): the dimension decoder against real
 * header bytes, sizing/EMU math, and the embedder's archive surgery on a real
 * PizZip package (media part, relationship, content-type, unique ids, dedup)
 * — no stubs, per the repo's real-infra directive.
 */
import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import {
  ImageEmbedder,
  ImageEmbedError,
  MAX_CONTENT_WIDTH_PX,
  decodeImageInfo,
  ensureContentTypeDefault,
  inlineImageParagraph,
  isSvg,
  pxToEmu,
  resolveTargetSize,
} from "./image.js";
import { assertBalancedXml, buildDocx, para, pngFixtureBytes as pngBytes } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Fixture bytes — real, minimal image headers (PNG builder lives in fixtures)
// ---------------------------------------------------------------------------

/** A JPEG: SOI, a COM segment (exercises segment skipping), then SOF0. */
function jpegBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(2 + 8 + 13 + 2);
  const view = new DataView(b.buffer);
  let i = 0;
  b.set([0xff, 0xd8], i); // SOI
  i += 2;
  b.set([0xff, 0xfe], i); // COM marker
  view.setUint16(i + 2, 6); // segment length (incl. the 2 length bytes)
  i += 2 + 6;
  b.set([0xff, 0xc0], i); // SOF0
  view.setUint16(i + 2, 11);
  b[i + 4] = 8; // precision
  view.setUint16(i + 5, height);
  view.setUint16(i + 7, width);
  b[i + 9] = 3; // components
  i += 2 + 11;
  b.set([0xff, 0xd9], i); // EOI
  return b;
}

/** A GIF89a logical-screen header with the given size. */
function gifBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  const view = new DataView(b.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return b;
}

function svgBytes(): Uint8Array {
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`;
  return new TextEncoder().encode(text);
}

function templateZip(body = para("hello")): PizZip {
  return new PizZip(buildDocx({ body }));
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

describe("decodeImageInfo", () => {
  it("decodes PNG IHDR dimensions", () => {
    expect(decodeImageInfo(pngBytes(640, 480))).toEqual({
      format: "png",
      ext: "png",
      mime: "image/png",
      width: 640,
      height: 480,
    });
  });

  it("decodes JPEG SOF dimensions past skippable segments", () => {
    expect(decodeImageInfo(jpegBytes(1024, 768))).toMatchObject({
      format: "jpeg",
      mime: "image/jpeg",
      width: 1024,
      height: 768,
    });
  });

  it("decodes GIF logical-screen dimensions (little-endian)", () => {
    expect(decodeImageInfo(gifBytes(300, 200))).toMatchObject({
      format: "gif",
      width: 300,
      height: 200,
    });
  });

  it("decodes a real 1×1 PNG (base64 fixture)", () => {
    const onePx = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0)
    );
    expect(decodeImageInfo(onePx)).toMatchObject({ format: "png", width: 1, height: 1 });
  });

  it("rejects garbage, truncated and SVG bytes", () => {
    expect(decodeImageInfo(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(decodeImageInfo(pngBytes(10, 10).slice(0, 20))).toBeNull();
    expect(decodeImageInfo(svgBytes())).toBeNull();
  });

  it("decodes from a non-zero-offset subarray view", () => {
    // The engine hands out views over fetched buffers; the DataView math must
    // respect byteOffset, not assume the view starts at the buffer's origin.
    const buf = new Uint8Array(10 + 33);
    buf.set(pngBytes(20, 30), 10);
    expect(decodeImageInfo(buf.subarray(10))).toMatchObject({ width: 20, height: 30 });
  });
});

describe("isSvg", () => {
  it("detects an SVG behind XML declaration and comments", () => {
    expect(isSvg(svgBytes())).toBe(true);
  });
  it("does not flag PNG or HTML-ish text", () => {
    expect(isSvg(pngBytes(1, 1))).toBe(false);
    expect(isSvg(new TextEncoder().encode("<p>svg is mentioned</p>"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

describe("resolveTargetSize / pxToEmu", () => {
  const intrinsic = { width: 800, height: 400 };

  it("uses intrinsic size when nothing is specified", () => {
    expect(resolveTargetSize(intrinsic, {}, 1000)).toEqual({ widthPx: 800, heightPx: 400 });
  });

  it("scales the missing axis from a width-only override", () => {
    expect(resolveTargetSize(intrinsic, { widthPx: 400 }, 1000)).toEqual({ widthPx: 400, heightPx: 200 });
  });

  it("scales the missing axis from a height-only override", () => {
    expect(resolveTargetSize(intrinsic, { heightPx: 100 }, 1000)).toEqual({ widthPx: 200, heightPx: 100 });
  });

  it("caps to the content width preserving aspect ratio", () => {
    expect(resolveTargetSize(intrinsic, {}, MAX_CONTENT_WIDTH_PX)).toEqual({ widthPx: 600, heightPx: 300 });
    expect(resolveTargetSize(intrinsic, { widthPx: 1200, heightPx: 300 }, 600)).toEqual({
      widthPx: 600,
      heightPx: 150,
    });
  });

  it("converts px to EMU with rounding", () => {
    expect(pxToEmu(1)).toBe(9525);
    expect(pxToEmu(0.5)).toBe(4763);
  });
});

// ---------------------------------------------------------------------------
// Embedder — archive surgery on a real package
// ---------------------------------------------------------------------------

describe("ImageEmbedder", () => {
  it("writes media part + relationship + content type and returns the drawing", () => {
    const zip = templateZip();
    const embedder = new ImageEmbedder(zip);
    const xml = embedder.embed(pngBytes(100, 50), { name: "diagram.png", alt: "the diagram" });

    assertBalancedXml(xml);
    // Drawing landmarks: extent in EMU, alt text on docPr, blip → rel id.
    expect(xml).toContain(`<wp:extent cx="${100 * 9525}" cy="${50 * 9525}"/>`);
    expect(xml).toContain('descr="the diagram"');
    const relId = xml.match(/r:embed="(rId\d+)"/)?.[1];
    expect(relId).toBeDefined();

    // Media part holds the exact bytes.
    const media = zip.file("word/media/atlcli-image1.png");
    expect(media).not.toBeNull();
    expect([...media!.asUint8Array()]).toEqual([...pngBytes(100, 50)]);

    // Relationship targets the media part.
    const rels = zip.file("word/_rels/document.xml.rels")!.asText();
    expect(rels).toContain(`Id="${relId}"`);
    expect(rels).toContain('Target="media/atlcli-image1.png"');
    expect(rels).toContain("relationships/image");

    // Content-type default registered exactly once.
    const ct = zip.file("[Content_Types].xml")!.asText();
    expect(ct.match(/Extension="png"/g)).toHaveLength(1);
    expect(embedder.embeddedCount).toBe(1);
  });

  it("allocates unique docPr ids and rIds across multiple images", () => {
    const zip = templateZip();
    const embedder = new ImageEmbedder(zip);
    const a = embedder.embed(pngBytes(10, 10));
    const b = embedder.embed(gifBytes(20, 20));

    const idsA = [...a.matchAll(/(?:wp:docPr|pic:cNvPr) id="(\d+)"/g)].map((m) => m[1]);
    const idsB = [...b.matchAll(/(?:wp:docPr|pic:cNvPr) id="(\d+)"/g)].map((m) => m[1]);
    // Within one drawing, docPr and cNvPr share the id; across drawings they differ.
    expect(new Set(idsA).size).toBe(1);
    expect(new Set(idsB).size).toBe(1);
    expect(idsA[0]).not.toBe(idsB[0]);

    const relA = a.match(/r:embed="(rId\d+)"/)?.[1];
    const relB = b.match(/r:embed="(rId\d+)"/)?.[1];
    expect(relA).not.toBe(relB);
    // Both formats registered generically (not PNG-only).
    const ct = zip.file("[Content_Types].xml")!.asText();
    expect(ct).toContain('Extension="png"');
    expect(ct).toContain('Extension="gif"');
  });

  it("seeds docPr ids above drawings the template already contains", () => {
    const body =
      para("x") +
      `<w:p><w:r><w:drawing><wp:docPr id="41" name="Existing"/></w:drawing></w:r></w:p>`;
    const zip = templateZip(body);
    const xml = new ImageEmbedder(zip).embed(pngBytes(5, 5));
    const id = Number(xml.match(/wp:docPr id="(\d+)"/)?.[1]);
    expect(id).toBeGreaterThan(41);
  });

  it("dedupes byte-identical images into one media part with distinct docPr ids", () => {
    const zip = templateZip();
    const embedder = new ImageEmbedder(zip);
    const a = embedder.embed(pngBytes(10, 10), { alt: "first" });
    const b = embedder.embed(pngBytes(10, 10), { alt: "second" });

    expect(a.match(/r:embed="(rId\d+)"/)?.[1]).toBe(b.match(/r:embed="(rId\d+)"/)?.[1]!);
    expect(a.match(/wp:docPr id="(\d+)"/)?.[1]).not.toBe(b.match(/wp:docPr id="(\d+)"/)?.[1]!);
    expect(zip.file("word/media/atlcli-image1.png")).not.toBeNull();
    expect(zip.file("word/media/atlcli-image2.png")).toBeNull();
    expect(embedder.embeddedCount).toBe(2);

    // Same-size but different bytes must NOT dedupe (hash bucket verified).
    const c = embedder.embed(pngBytes(10, 10, /* pad */ 0).map((v, i) => (i === 32 ? 99 : v)) as Uint8Array);
    expect(c.match(/r:embed="(rId\d+)"/)?.[1]).not.toBe(a.match(/r:embed="(rId\d+)"/)?.[1]!);
  });

  it("caps oversized images to the content width", () => {
    const zip = templateZip();
    const xml = new ImageEmbedder(zip).embed(pngBytes(1200, 600));
    expect(xml).toContain(`<wp:extent cx="${600 * 9525}" cy="${300 * 9525}"/>`);
  });

  it("honors author width/height overrides", () => {
    const zip = templateZip();
    const xml = new ImageEmbedder(zip).embed(pngBytes(800, 400), { widthPx: 250 });
    expect(xml).toContain(`<wp:extent cx="${250 * 9525}" cy="${125 * 9525}"/>`);
  });

  it("escapes alt text and names for XML attributes", () => {
    const zip = templateZip();
    const xml = new ImageEmbedder(zip).embed(pngBytes(5, 5), { name: 'a"<b>&.png', alt: 'says "hi" & <bye>' });
    assertBalancedXml(xml);
    expect(xml).toContain('descr="says &quot;hi&quot; &amp; &lt;bye&gt;"');
    expect(xml).toContain('name="a&quot;&lt;b&gt;&amp;.png"');
  });

  it("throws ImageEmbedError and leaves the archive untouched on bad input", () => {
    const zip = templateZip();
    const relsBefore = zip.file("word/_rels/document.xml.rels")!.asText();
    const ctBefore = zip.file("[Content_Types].xml")!.asText();
    const embedder = new ImageEmbedder(zip);

    expect(() => embedder.embed(new Uint8Array(0))).toThrow(ImageEmbedError);
    expect(() => embedder.embed(new TextEncoder().encode("not an image"))).toThrow(ImageEmbedError);
    expect(() => embedder.embed(svgBytes())).toThrow(/SVG/);

    expect(zip.file("word/_rels/document.xml.rels")!.asText()).toBe(relsBefore);
    expect(zip.file("[Content_Types].xml")!.asText()).toBe(ctBefore);
    expect(Object.keys(zip.files).some((p) => p.startsWith("word/media/"))).toBe(false);
    expect(embedder.embeddedCount).toBe(0);
  });

  it("avoids media filename collisions with existing parts", () => {
    const zip = templateZip();
    zip.file("word/media/atlcli-image1.png", pngBytes(1, 1));
    const xml = new ImageEmbedder(zip).embed(pngBytes(9, 9));
    expect(xml).toContain("r:embed=");
    const rels = zip.file("word/_rels/document.xml.rels")!.asText();
    expect(rels).toContain('Target="media/atlcli-image2.png"');
  });
});

describe("ensureContentTypeDefault", () => {
  it("is idempotent and case-insensitive on the extension", () => {
    const zip = templateZip();
    ensureContentTypeDefault(zip, "jpeg", "image/jpeg");
    ensureContentTypeDefault(zip, "jpeg", "image/jpeg");
    const ct = zip.file("[Content_Types].xml")!.asText();
    expect(ct.match(/Extension="jpeg"/g)).toHaveLength(1);
  });
});

describe("inlineImageParagraph", () => {
  it("emits the full Word-blessed fragment (aspect locks, effectExtent, useLocalDpi)", () => {
    const xml = inlineImageParagraph({
      relId: "rId9",
      docPrId: 3,
      name: "pic",
      descr: "alt",
      cxEmu: 100,
      cyEmu: 200,
    });
    assertBalancedXml(xml);
    for (const landmark of [
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
      'noChangeAspect="1"',
      "<a:picLocks",
      "a14:useLocalDpi",
      '<a:blip r:embed="rId9"',
      "<a:noFill/>",
    ]) {
      expect(xml).toContain(landmark);
    }
  });
});
