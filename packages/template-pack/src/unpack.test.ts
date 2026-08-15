/**
 * Reader security tests (spec 007 T2.4) — real crafted archives, no mocking.
 *
 * Evil archives are built directly with PizZip (path traversal, symlinks,
 * over-cap members, zip bombs) and fed to `unpackTemplate`; each must be
 * rejected with the matching typed {@link TemplatePackError.kind}.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import PizZipDefault from "pizzip";
import {
  unpackTemplate,
  TemplatePackError,
  MAX_TEMPLATE_PACK_BYTES,
  MAX_TEMPLATE_PACK_FILE_BYTES,
  MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES,
  type TemplatePackErrorKind,
} from "./unpack.js";
import { TEMPLATE_PACK_MANIFEST_NAME } from "./manifest.js";

/** Raw PizZip surface (cast to reach the determinism/permission options). */
interface RawZip {
  file(
    path: string,
    content: Uint8Array | string,
    options?: { date?: Date; unixPermissions?: number }
  ): unknown;
  generate(options: {
    type: "uint8array";
    compression: "DEFLATE";
    platform?: "DOS" | "UNIX";
  }): Uint8Array;
}
const RawPizZip = PizZipDefault as unknown as { new (): RawZip };

const DATE = new Date(1980, 0, 1, 0, 0, 0);
const CPU_HEAVY_TEST_TIMEOUT_MS = 30_000;

function manifestJson(entry = "template.typ"): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "com.acme.doc",
    name: "Acme",
    version: "1.0.0",
    engine: { kind: "typst", api: "wiki.pdf-template/v1", entry },
  });
}

/** Build a raw archive with a valid manifest plus caller-supplied extra entries. */
function buildRaw(
  extra: (zip: RawZip) => void,
  opts: { platform?: "DOS" | "UNIX"; withEntry?: boolean } = {}
): Uint8Array {
  const zip = new RawPizZip();
  zip.file(TEMPLATE_PACK_MANIFEST_NAME, manifestJson(), { date: DATE });
  if (opts.withEntry !== false) {
    zip.file("template.typ", "#let render(meta, body, settings) = body", { date: DATE });
  }
  extra(zip);
  return zip.generate({ type: "uint8array", compression: "DEFLATE", platform: opts.platform ?? "DOS" });
}

function expectKind(fn: () => void, kind: TemplatePackErrorKind): void {
  try {
    fn();
    throw new Error("expected TemplatePackError, none thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(TemplatePackError);
    expect((err as TemplatePackError).kind).toBe(kind);
  }
}

describe("path traversal rejection", () => {
  it("rejects a `../evil.typ` entry", () => {
    const bytes = buildRaw((z) => z.file("../evil.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });

  it("rejects an absolute path", () => {
    const bytes = buildRaw((z) => z.file("/etc/passwd", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });

  it("rejects a backslash path", () => {
    const bytes = buildRaw((z) => z.file("dir\\evil.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });

  it("rejects a nested `..` segment", () => {
    const bytes = buildRaw((z) => z.file("a/../../evil.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });

  it("rejects a newline-containing path (payloadSha256 delimiter-injection guard)", () => {
    const bytes = buildRaw((z) => z.file("bar\n4\nabc\nfoo", "xyz", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "invalid-path");
  });

  it("rejects CR and NUL control characters in paths", () => {
    const cr = buildRaw((z) => z.file("evil\r.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(cr), "invalid-path");
    const nul = buildRaw((z) => z.file("evil\u0000.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(nul), "invalid-path");
  });
});

describe("symlink rejection", () => {
  it("rejects a symlink entry (S_IFLNK)", () => {
    const bytes = buildRaw(
      (z) => z.file("link.typ", "/etc/passwd", { date: DATE, unixPermissions: 0o120777 }),
      { platform: "UNIX" }
    );
    expectKind(() => unpackTemplate(bytes), "symlink");
  });
});

describe("manifest / entry integrity", () => {
  it("rejects a missing engine.entry member", () => {
    // Manifest points at template.typ but the archive omits it.
    const bytes = buildRaw(() => {}, { withEntry: false });
    expectKind(() => unpackTemplate(bytes), "missing-entry");
  });

  it("rejects a missing manifest", () => {
    const zip = new RawPizZip();
    zip.file("template.typ", "body", { date: DATE });
    const bytes = zip.generate({ type: "uint8array", compression: "DEFLATE", platform: "DOS" });
    expectKind(() => unpackTemplate(bytes), "missing-manifest");
  });

  it("rejects a non-zip buffer", () => {
    expectKind(() => unpackTemplate(new TextEncoder().encode("not a zip")), "not-zip");
  });
});

describe("size caps", () => {
  it("rejects an archive over the 30 MiB outer cap (before unzip)", () => {
    // A buffer larger than the cap is rejected on length alone, before parsing.
    const oversized = new Uint8Array(MAX_TEMPLATE_PACK_BYTES + 1);
    expectKind(() => unpackTemplate(oversized), "too-large-archive");
  });

  it("rejects a member over the per-file cap by declared size", () => {
    const big = new Uint8Array(MAX_TEMPLATE_PACK_FILE_BYTES + 1024); // zeros, compresses tiny
    const bytes = buildRaw((z) => z.file("huge.bin", big, { date: DATE }));
    expect(bytes.byteLength).toBeLessThan(1024 * 1024); // archive stays small
    expectKind(() => unpackTemplate(bytes), "file-too-large");
  });

  it("aborts on declared cumulative uncompressed size before inflating (zip bomb)", () => {
    // Three 30 MiB zero members: each is under the 32 MiB per-file cap, but the
    // cumulative declared 90 MiB exceeds the 64 MiB cap. The archive itself is a
    // few KB compressed — proving the guard accounts DECLARED uncompressed size,
    // not compressed bytes, and trips in the pre-inflation pass.
    const chunk = () => new Uint8Array(30 * 1024 * 1024);
    const bytes = buildRaw((z) => {
      z.file("a.bin", chunk(), { date: DATE });
      z.file("b.bin", chunk(), { date: DATE });
      z.file("c.bin", chunk(), { date: DATE });
    });
    expect(bytes.byteLength).toBeLessThan(1024 * 1024);
    expect(90 * 1024 * 1024).toBeGreaterThan(MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES);
    expectKind(() => unpackTemplate(bytes), "uncompressed-too-large");
  });
});

/* -------------------------------------------------------------------------
 * Forged central directory: the declared-size bypass.
 *
 * The size caps above budget on `_data.uncompressedSize`, which is metadata
 * the attacker writes. An archive that UNDER-declares slips past every
 * absolute cap and detonates in the inflation pass instead. These tests forge
 * that field directly in the zip bytes, which no fixture builder can express.
 * ---------------------------------------------------------------------- */

/** Zip record signatures and the offset of the uncompressed-size field in each. */
const CENTRAL_DIR_SIG = 0x02014b50;
const CENTRAL_DIR_USIZE_OFFSET = 24;
const LOCAL_HEADER_SIG = 0x04034b50;
const LOCAL_HEADER_USIZE_OFFSET = 22;

/**
 * Rewrite a member's declared uncompressed size in BOTH the central-directory
 * record and the local file header.
 *
 * Patching only the central directory would be a weaker adversary than the real
 * one: readers that cross-check the two headers would notice. Patching both
 * produces an internally consistent archive whose only flaw is that the
 * declared size does not match what the DEFLATE stream actually yields — which
 * is precisely the attack `assertPlausibleCompression` exists to refuse.
 *
 * @returns the patched archive; asserts that both records were found.
 */
function forgeDeclaredSize(archive: Uint8Array, actual: number, forged: number): Uint8Array {
  const out = new Uint8Array(archive);
  const dv = new DataView(out.buffer);
  let patched = 0;
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true);
    if (
      sig === CENTRAL_DIR_SIG &&
      i + CENTRAL_DIR_USIZE_OFFSET + 4 <= out.length &&
      dv.getUint32(i + CENTRAL_DIR_USIZE_OFFSET, true) === actual
    ) {
      dv.setUint32(i + CENTRAL_DIR_USIZE_OFFSET, forged, true);
      patched++;
    }
    if (
      sig === LOCAL_HEADER_SIG &&
      i + LOCAL_HEADER_USIZE_OFFSET + 4 <= out.length &&
      dv.getUint32(i + LOCAL_HEADER_USIZE_OFFSET, true) === actual
    ) {
      dv.setUint32(i + LOCAL_HEADER_USIZE_OFFSET, forged, true);
      patched++;
    }
  }
  // Both the central-directory record and the local header must have been hit.
  expect(patched).toBe(2);
  return out;
}

/** Read back a member's declared/compressed sizes as the reader sees them. */
function sizesOf(archive: Uint8Array, name: string): { declared: number; compressed: number } {
  const zip = new PizZipDefault(archive);
  const files = zip.files as unknown as Record<
    string,
    { _data?: { uncompressedSize?: number; compressedSize?: number } }
  >;
  const e = files[name];
  return { declared: e?._data?.uncompressedSize ?? -1, compressed: e?._data?.compressedSize ?? -1 };
}

describe("forged declared size (under-declaration bypass)", () => {
  /** Size the bomb inflates to. Far above any plausible GC noise in the RSS check. */
  const BOMB_UNCOMPRESSED = 256 * 1024 * 1024;

  /** Build the forged archive, keeping the 256 MiB buffer out of the caller's scope. */
  function buildForgedBomb(): Uint8Array {
    const honest = buildRaw((z) =>
      z.file("bomb.bin", new Uint8Array(BOMB_UNCOMPRESSED), { date: DATE })
    );
    // Declare 1 KiB for a member that actually inflates to 256 MiB.
    return forgeDeclaredSize(honest, BOMB_UNCOMPRESSED, 1024);
  }

  it("refuses a member declaring fewer bytes than its own compressed stream", () => {
    const forged = buildForgedBomb();
    const { declared, compressed } = sizesOf(forged, "bomb.bin");

    // The forgery is what makes this lethal: 1 KiB declared passes BOTH the
    // per-file cap and the cumulative cap, so absolute limits alone let it through.
    expect(declared).toBe(1024);
    expect(declared).toBeLessThan(MAX_TEMPLATE_PACK_FILE_BYTES);
    expect(declared).toBeLessThan(MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES);
    // ...yet it declares far less than its own compressed stream, which DEFLATE
    // can never do. That contradiction is the detection.
    expect(declared).toBeLessThan(compressed);

    expectKind(() => unpackTemplate(forged), "suspicious-compression");
  }, CPU_HEAVY_TEST_TIMEOUT_MS);

  it("refuses the forged bomb WITHOUT inflating it (RSS stays flat)", () => {
    const forged = buildForgedBomb();
    Bun.gc(true);

    const before = process.memoryUsage().rss;
    expectKind(() => unpackTemplate(forged), "suspicious-compression");
    const after = process.memoryUsage().rss;

    const grewBytes = after - before;
    // Before the guard this inflated the full 256 MiB payload (measured at
    // 400 MiB: +819 MiB RSS in 231 ms) and only then threw an untyped PizZip
    // "uncompressed data size mismatch". Rejecting from metadata alone must
    // allocate essentially nothing, so a fraction of the payload is a generous
    // bound that still fails loudly if the pre-inflation guard regresses.
    expect(grewBytes).toBeLessThan(BOMB_UNCOMPRESSED / 4);
  }, CPU_HEAVY_TEST_TIMEOUT_MS);

  it("refuses a member declaring implausibly MORE than its compressed stream", () => {
    // A bomb that stays under the absolute caps: ~4 KiB of incompressible data
    // re-declared as 30 MiB. Under the 32 MiB per-file and 64 MiB cumulative
    // caps, so only the ratio bound can catch it.
    // xorshift32 — genuinely incompressible, so the member lands ABOVE the
    // 512-byte floor and the ratio bound is what decides. (A weaker generator
    // compressed to 303 bytes and skipped the check entirely.)
    const noise = new Uint8Array(4096);
    let state = 0x9e3779b9;
    for (let i = 0; i < noise.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      noise[i] = state & 0xff;
    }
    const honest = buildRaw((z) => z.file("padded.bin", noise, { date: DATE }));

    const declaredBig = 30 * 1024 * 1024;
    const forged = forgeDeclaredSize(honest, noise.length, declaredBig);
    const { declared, compressed } = sizesOf(forged, "padded.bin");

    expect(declared).toBe(declaredBig);
    expect(declared).toBeLessThan(MAX_TEMPLATE_PACK_FILE_BYTES);
    expect(compressed).toBeGreaterThan(512); // above the ratio floor
    expect(declared / compressed).toBeGreaterThan(500);

    expectKind(() => unpackTemplate(forged), "suspicious-compression");
  });
});

describe("inflate failure is typed", () => {
  it("reports a PizZip size mismatch as `corrupt-entry`, not an untyped Error", () => {
    // Declared size is forged to a value that is PLAUSIBLE for the compressed
    // stream (so the ratio guard passes) but still wrong, so the failure lands
    // where it previously escaped untyped: inside the inflation pass.
    const body = "#let caption = [Figure]\n".repeat(4096); // ~98 KB, compresses well
    const actual = new TextEncoder().encode(body).length;
    const honest = buildRaw((z) => z.file("big.typ", body, { date: DATE }));

    const forgedSize = Math.floor(actual / 2);
    const forged = forgeDeclaredSize(honest, actual, forgedSize);
    const { declared, compressed } = sizesOf(forged, "big.typ");

    // Confirm this slips past the ratio band, so the test really exercises the
    // inflate path rather than being caught earlier by `suspicious-compression`.
    const ratio = declared / compressed;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(500);

    expectKind(() => unpackTemplate(forged), "corrupt-entry");
  });
});

/* -------------------------------------------------------------------------
 * Positive controls.
 *
 * A guard that rejects ordinary input is the same class of defect as the hole
 * it closes, so the legitimate shapes are pinned as tightly as the evil ones.
 * Measured ratios (PizZip, the compressor `packTemplate` itself uses):
 * PNG ~1.2:1, real TTF ~2.1:1, Typst source ~3.4:1, SVG ~7.1:1,
 * localization JSON ~11.9:1, 20 000 identical Typst blocks ~335.8:1.
 * ---------------------------------------------------------------------- */

/** A real TTF shipped by `@atlcli/docx`, resolved through its export map. */
function realFontBytes(): Uint8Array {
  const url = import.meta.resolve("@atlcli/docx/fonts/Inter-Regular.ttf");
  return new Uint8Array(readFileSync(fileURLToPath(url)));
}

/** CRC-32 over `bytes`, for building a genuine PNG. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a genuine, structurally valid PNG (zlib-compressed IDAT).
 *
 * A real PNG rather than random bytes because the point of the control is the
 * COMPRESSION behaviour of the media: PNG's payload is already DEFLATE'd, so
 * the zip layer can barely shrink it further (~1.2:1 measured).
 */
function buildPng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = new TextEncoder().encode(type);
    const body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes, 0);
    body.set(data, typeBytes.length);
    const out = new Uint8Array(4 + body.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length, false);
    out.set(body, 4);
    dv.setUint32(4 + body.length, crc32(body), false);
    return out;
  };

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: truecolour
  // Varied pixel data, so the PNG is a plausible photo/diagram rather than a
  // flat fill that would compress unrealistically well.
  const raw = new Uint8Array(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[p++] = (x * 7 + y * 13) % 256;
      raw[p++] = (x * 31 + y * 17) % 256;
      raw[p++] = (x * 3 + y * 101) % 256;
    }
  }
  const idat = Bun.deflateSync(raw);

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    sig,
    chunk("IHDR", ihdrData),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

describe("legitimate packs still unpack (positive controls)", () => {
  it("accepts a realistic mixed pack: manifest + Typst + real TTF + real PNG", () => {
    const font = realFontBytes();
    const png = buildPng(256, 256);
    expect(font.byteLength).toBeGreaterThan(100_000); // a real font, not a stub
    expect(png.byteLength).toBeGreaterThan(10_000);

    const typst = [
      "#let render(meta, body, settings) = {",
      '  set page(paper: "a4", margin: 2cm)',
      '  set text(font: "Inter", size: 10pt)',
      "  heading(meta.title)",
      "  body",
      "}",
    ].join("\n");

    const bytes = buildRaw((z) => {
      z.file("assets/Inter-Regular.ttf", font, { date: DATE });
      z.file("assets/cover.png", png, { date: DATE });
      z.file("partials/body.typ", typst, { date: DATE });
    });

    const out = unpackTemplate(bytes);
    expect(out.manifest.engine.entry).toBe("template.typ");
    expect(out.files["assets/Inter-Regular.ttf"]?.byteLength).toBe(font.byteLength);
    expect(out.files["assets/cover.png"]?.byteLength).toBe(png.byteLength);

    // The incompressible media must sit comfortably inside the ratio band.
    for (const name of ["assets/Inter-Regular.ttf", "assets/cover.png"]) {
      const { declared, compressed } = sizesOf(bytes, name);
      const ratio = declared / compressed;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(500);
    }
  });

  it("accepts a highly repetitive but legitimate pack (~336:1, just under the cap)", () => {
    // The template-pack analogue of a long form of identical empty rows. This is
    // the shape that a naive 100:1 cap would have rejected: measured 335.8:1 at
    // 20 000 blocks, converging to ~343:1 rather than climbing to DEFLATE's
    // ceiling, because real Typst syntax needs several distinct bytes per unit.
    const block = "#block(width: 100%, inset: 8pt)[#text(size: 10pt)[]]";
    const repetitive = Array.from({ length: 20_000 }, () => block).join("\n");

    const bytes = buildRaw((z) => z.file("form.typ", repetitive, { date: DATE }));
    const { declared, compressed } = sizesOf(bytes, "form.typ");
    const ratio = declared / compressed;

    // Pin the measurement: this legitimate shape really is far above 100:1.
    expect(ratio).toBeGreaterThan(300);
    expect(ratio).toBeLessThan(500);

    const out = unpackTemplate(bytes);
    expect(new TextDecoder().decode(out.files["form.typ"]!)).toBe(repetitive);
  });

  it("accepts ordinary small members below the 512-byte ratio floor", () => {
    // Zip framing dominates tiny entries — a 4-byte member compresses to ~6
    // bytes (0.7:1), which is UNDER the lower bound and would be rejected as a
    // lie were the floor not applied.
    const bytes = buildRaw((z) => {
      z.file("tiny.txt", "body", { date: DATE });
      z.file("small.typ", "#let x = 1\n".repeat(18), { date: DATE });
      z.file("empty.txt", "", { date: DATE });
    });

    const tiny = sizesOf(bytes, "tiny.txt");
    expect(tiny.compressed).toBeLessThan(512); // below the floor
    expect(tiny.declared).toBeLessThan(tiny.compressed); // would trip the lower bound

    const out = unpackTemplate(bytes);
    expect(new TextDecoder().decode(out.files["tiny.txt"]!)).toBe("body");
    expect(out.files["empty.txt"]?.byteLength).toBe(0);
  });

  it("accepts a manifest carrying a large repetitive localization table", () => {
    const localization = Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`key.${i}`, { en: "Continued", de: "Fortsetzung" }])
    );
    const bytes = buildRaw((z) =>
      z.file("i18n.json", JSON.stringify(localization), { date: DATE })
    );

    const { declared, compressed } = sizesOf(bytes, "i18n.json");
    expect(declared / compressed).toBeLessThan(500);
    expect(() => unpackTemplate(bytes)).not.toThrow();
  });
});
