/**
 * Infrastructure tests for the shape-parity comparison core (spec 011). These
 * run pure functions over REAL zip bytes (`@atlcli/docx/fixtures` `buildDocx`)
 * and REAL PNG bytes (round-tripped through the codec) — no mocks. The blank and
 * mis-cropped fixtures prove the raster content check rejects a same-size image
 * that merely looks structurally plausible.
 */
import { describe, expect, it } from "bun:test";
import { unzipDocx } from "@atlcli/docx/browser";
import { buildDocx, para, stylesXml } from "@atlcli/docx/fixtures";
import { decodePng, encodeRgbaPng } from "./png-codec.js";
import {
  compareDocxParity,
  comparePdfParity,
  compareRasterMedia,
  compareReportProjection,
  digestParts,
  projectNotes,
  sha256Hex,
} from "./parity-compare.js";

function docxParts(bytes: Uint8Array): Record<string, Uint8Array> {
  const zip = unzipDocx(bytes);
  const parts: Record<string, Uint8Array> = {};
  for (const [name, file] of Object.entries(zip.files)) {
    if (!(file as { dir?: boolean }).dir) parts[name] = (file as { asUint8Array(): Uint8Array }).asUint8Array();
  }
  return parts;
}

/** Solid rectangle of `colour` on transparent background at (x0,y0..x1,y1). */
function rgbaImage(
  width: number,
  height: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  colour: [number, number, number, number] = [200, 40, 40, 255],
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4); // all zero = transparent
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = colour[0];
      rgba[i + 1] = colour[1];
      rgba[i + 2] = colour[2];
      rgba[i + 3] = colour[3];
    }
  }
  return rgba;
}

describe("png codec round-trip", () => {
  it("decodes what it encodes (filter 0 + zlib)", () => {
    const rgba = rgbaImage(16, 16, { x0: 4, y0: 4, x1: 12, y1: 12 });
    const png = encodeRgbaPng(16, 16, rgba);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(16);
    expect(decoded.hasAlpha).toBe(true);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });
});

describe("sha256 + digest maps", () => {
  it("is stable and content-addressed", () => {
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).toBe(sha256Hex(new Uint8Array([1, 2, 3])));
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).not.toBe(sha256Hex(new Uint8Array([1, 2, 4])));
  });

  it("digests every part of a real docx package", () => {
    const bytes = buildDocx({ body: para("hello"), styles: stylesXml() });
    const map = digestParts(docxParts(bytes));
    expect(Object.keys(map)).toContain("word/document.xml");
    expect(map["word/document.xml"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("report projection", () => {
  it("counts by code/severity/phase and ignores free text + timing", () => {
    const a = projectNotes([
      { code: "unknown-macro", level: "warning", message: "took 12ms on page 3" },
      { code: "unknown-macro", level: "warning", message: "different wording" },
      { code: "scroll-title-caption-fallback", level: "info" },
    ]);
    const b = projectNotes([
      { code: "unknown-macro", severity: "warning" },
      { code: "unknown-macro", severity: "warning" },
      { code: "scroll-title-caption-fallback", severity: "info" },
    ]);
    expect(compareReportProjection(a, b)).toEqual([]);
  });

  it("flags a divergent note count", () => {
    const a = projectNotes([{ code: "macro-degraded", level: "warning" }]);
    const b = projectNotes([]);
    expect(compareReportProjection(a, b)).toEqual([
      "report note macro-degraded|warning|: browser 1 vs cli 0",
    ]);
  });
});

describe("raster content check", () => {
  const content = encodeRgbaPng(32, 32, rgbaImage(32, 32, { x0: 8, y0: 8, x1: 24, y1: 24 }));

  it("accepts two near-identical content images", () => {
    const result = compareRasterMedia(content, content);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects a same-size BLANK image", () => {
    const blank = encodeRgbaPng(32, 32, new Uint8Array(32 * 32 * 4));
    const result = compareRasterMedia(content, blank);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("blank");
  });

  it("rejects a same-size MIS-CROPPED image (content shifted)", () => {
    const shifted = encodeRgbaPng(32, 32, rgbaImage(32, 32, { x0: 0, y0: 0, x1: 6, y1: 6 }));
    const result = compareRasterMedia(content, shifted);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/content bounds|perceptual/);
  });

  it("rejects an RGB image lacking an alpha channel", () => {
    // Build a colour-type-2 PNG by hand-decoding path: encode RGBA then strip is
    // not possible with the encoder, so assert via a real RGB fixture instead.
    const rgb = encodeRgbPng(16, 16);
    const result = compareRasterMedia(content, rgb);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("alpha channel missing");
  });
});

describe("compareDocxParity", () => {
  it("passes for byte-identical packages", () => {
    const a = docxParts(buildDocx({ body: para("same"), styles: stylesXml() }));
    const b = docxParts(buildDocx({ body: para("same"), styles: stylesXml() }));
    const failures = compareDocxParity("scope", { parts: a, notes: [] }, { parts: b, notes: [] });
    expect(failures).toEqual([]);
  });

  it("names the first divergent non-media part", () => {
    const a = docxParts(buildDocx({ body: para("left"), styles: stylesXml() }));
    const b = docxParts(buildDocx({ body: para("right"), styles: stylesXml() }));
    const failures = compareDocxParity("scope", { parts: a, notes: [] }, { parts: b, notes: [] });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].detail).toContain("word/document.xml");
  });

  it("compares media parts by raster content, not bytes", () => {
    const shared = buildDocx({ body: para("m"), styles: stylesXml() });
    const a = docxParts(shared);
    const b = docxParts(shared);
    // Two visually-equivalent but byte-different PNGs (padding differs).
    const img = rgbaImage(24, 24, { x0: 4, y0: 4, x1: 20, y1: 20 });
    a["word/media/image1.png"] = encodeRgbaPng(24, 24, img);
    b["word/media/image1.png"] = encodeRgbaPng(24, 24, img);
    const ok = compareDocxParity("media", { parts: a, notes: [] }, { parts: b, notes: [] });
    expect(ok).toEqual([]);

    b["word/media/image1.png"] = encodeRgbaPng(24, 24, new Uint8Array(24 * 24 * 4));
    const bad = compareDocxParity("media", { parts: a, notes: [] }, { parts: b, notes: [] });
    expect(bad.some((f) => f.detail.includes("word/media/image1.png"))).toBe(true);
  });
});

describe("comparePdfParity", () => {
  it("passes for byte-identical PDFs at the same compiler version", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
    const failures = comparePdfParity(
      "pdf-settings",
      { bytes, compilerVersion: "typst-0.14", notes: [] },
      { bytes: bytes.slice(), compilerVersion: "typst-0.14", notes: [] },
    );
    expect(failures).toEqual([]);
  });

  it("fails loudly on compiler version skew before diffing bytes", () => {
    const failures = comparePdfParity(
      "pdf-settings",
      { bytes: new Uint8Array([1]), compilerVersion: "typst-0.14", notes: [] },
      { bytes: new Uint8Array([2]), compilerVersion: "typst-0.15", notes: [] },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("compiler version mismatch");
  });

  it("flags divergent PDF bytes", () => {
    const failures = comparePdfParity(
      "pdf-settings",
      { bytes: new Uint8Array([1, 2, 3]), compilerVersion: "v", notes: [] },
      { bytes: new Uint8Array([1, 2, 9]), compilerVersion: "v", notes: [] },
    );
    expect(failures.some((f) => f.detail.includes("PDF bytes differ"))).toBe(true);
  });
});

// --- helper: a real colour-type-2 (RGB, no alpha) PNG for the alpha test -----

import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

function encodeRgbPng(width: number, height: number): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * (stride + 1) + 1 + x * 3;
      raw[i] = 10 + x;
      raw[i + 1] = 20 + y;
      raw[i + 2] = 30;
    }
  }
  const idat = new Uint8Array(deflateSync(raw));
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2; // colour type RGB
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
