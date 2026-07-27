import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import {
  DOCX_ARCHIVE_BUDGET,
  DOCX_TEMPLATE_INTAKE_BUDGET,
  DocxError,
  MAX_TEMPLATE_BYTES,
  assertSafeDocxEntryName,
  collectRiskyFieldInstructions,
  hasAltChunkRelationship,
  scanTemplate,
  unzipDocx,
} from "./scan.js";
import {
  buildDocx,
  chartTitlePart,
  complexFieldResult,
  drawingAdjacentPara,
  fldSimpleResult,
  para,
  runSplitPara,
  smartArtDataPart,
  textBoxTitlePara,
} from "./fixtures.js";

describe("scanTemplate", () => {
  it("classifies supported / unsupported / never placeholders", () => {
    const bytes = buildDocx({
      body:
        para("$scroll.title") +
        para("$scroll.space.name") +
        para("$scroll.pageowner.fullName") +
        para("$scroll.spacelogo") +
        para("$scroll.custom.(k15t-scroll-document-versions-for-confluence,document-id)") +
        para("$adhocState") +
        para("$scroll.content"),
    });
    const scan = scanTemplate(bytes);

    const supported = scan.supported.map((h) => h.base).sort();
    const unsupported = scan.unsupported.map((h) => h.base).sort();
    const never = scan.never.map((h) => h.base).sort();

    // pageowner is SUPPORTED since G1 closed (Cloud v2 exposes `ownerId`); the
    // space logo is SUPPORTED since spec 005's image module landed (G3).
    expect(supported).toEqual([
      "$scroll.pageowner.fullName",
      "$scroll.space.name",
      "$scroll.spacelogo",
      "$scroll.title",
    ]);
    // $adhocState was dropped from the curated never-list ("bauen wir aus") but
    // is still DETECTED, so it lands on the generic unrecognized→unsupported
    // path and gets blanked. Were it dropped from detection instead, the raw
    // token would survive into the exported document.
    expect(unsupported).toEqual(["$adhocState"]);
    expect(never).toEqual(["$scroll.custom"]);
    expect(scan.hasContentPlaceholder).toBe(true);
    // $scroll.content is not listed as a placeholder hit.
    expect([...supported, ...unsupported, ...never]).not.toContain("$scroll.content");
  });

  it("detects a placeholder split across multiple runs (run normalization)", () => {
    const bytes = buildDocx({
      // Word split "$scroll.title" across three runs.
      body: runSplitPara(["$scr", "oll.", "title"]),
    });
    const scan = scanTemplate(bytes);
    expect(scan.supported.map((h) => h.base)).toContain("$scroll.title");
  });

  it("does not swallow a sentence-ending period after a placeholder (#9)", () => {
    const bytes = buildDocx({
      body: para("Title: $scroll.title. More text.") + para("$scroll.pagelabels.capitalised"),
    });
    const scan = scanTemplate(bytes);
    const bases = scan.supported.map((h) => h.base).sort();
    // $scroll.title is recognized (period is NOT part of the token) and the real
    // dotted sub-token still matches whole.
    expect(bases).toContain("$scroll.title");
    expect(bases).toContain("$scroll.pagelabels.capitalised");
    const title = scan.supported.find((h) => h.base === "$scroll.title");
    expect(title!.raw).toContain("$scroll.title");
    expect(title!.raw).not.toContain("$scroll.title.");
  });

  it("does not fuse placeholders across a hard line break (#8 detection)", () => {
    // Two placeholders on separate lines must classify separately — not as one
    // fused `$scroll.titleVersion`.
    const bytes = buildDocx({
      body:
        `<w:p><w:r><w:t xml:space="preserve">Title: $scroll.title</w:t></w:r>` +
        `<w:r><w:br/></w:r>` +
        `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">Version: $scroll.version</w:t></w:r></w:p>`,
    });
    const scan = scanTemplate(bytes);
    const bases = scan.supported.map((h) => h.base).sort();
    expect(bases).toContain("$scroll.title");
    expect(bases).toContain("$scroll.version");
    expect(bases).not.toContain("$scroll.titleVersion");
  });

  it("reports a text-box title as supporting $scroll.title (real-template shape a)", () => {
    // The title lives inside a text box (mc:AlternateContent Choice + Fallback);
    // the scan must not miss it, so the panel lists it as supported.
    const bytes = buildDocx({ body: textBoxTitlePara("$scroll.title") + para("$scroll.content") });
    const scan = scanTemplate(bytes);
    expect(scan.supported.map((h) => h.base)).toContain("$scroll.title");
  });

  it("counts a text-box title (Choice+Fallback) plus a footer occurrence (shape a+b)", () => {
    // Two text-box copies on the cover + one clean run trailing a footer picture
    // = the occurrences the replacement resolves; the scan must count them all
    // (the real bug reported ×2 while missing one).
    const bytes = buildDocx({
      body: textBoxTitlePara("$scroll.title") + para("$scroll.content"),
      footer: drawingAdjacentPara("$scroll.title"),
    });
    const scan = scanTemplate(bytes);
    const title = scan.supported.find((h) => h.base === "$scroll.title");
    expect(title).toBeDefined();
    expect(title!.count).toBe(3); // Choice + Fallback + footer clean run
  });

  it("classifies a placeholder in a chart part's <a:t> title (shape ①)", () => {
    const bytes = buildDocx({
      body: para("$scroll.content"),
      extraParts: { "word/charts/chart1.xml": chartTitlePart("$scroll.title") },
    });
    const scan = scanTemplate(bytes);
    expect(scan.supported.map((h) => h.base)).toContain("$scroll.title");
    expect(scan.parts).toContain("word/charts/chart1.xml");
  });

  it("classifies a placeholder in a SmartArt diagram data part's <a:t> (shape ①)", () => {
    const bytes = buildDocx({
      body: para("$scroll.content"),
      extraParts: { "word/diagrams/data1.xml": smartArtDataPart("$scroll.title") },
    });
    const scan = scanTemplate(bytes);
    expect(scan.supported.map((h) => h.base)).toContain("$scroll.title");
    expect(scan.parts).toContain("word/diagrams/data1.xml");
  });

  it("counts a field's cached result once, ignoring the instruction text (shape ②)", () => {
    // $scroll.title appears in BOTH the w:instr and the cached result; the scan
    // must count only the displayed result (instructions are not text).
    const bytes = buildDocx({
      body:
        fldSimpleResult(" DOCPROPERTY $scroll.title ", "$scroll.title") +
        complexFieldResult(" REF $scroll.title ", "$scroll.title"),
    });
    const scan = scanTemplate(bytes);
    const title = scan.supported.find((h) => h.base === "$scroll.title");
    expect(title).toBeDefined();
    expect(title!.count).toBe(2); // one per field RESULT, not the two instructions
  });

  it("scans header and footer parts", () => {
    const bytes = buildDocx({
      body: para("body"),
      header: para("$scroll.title"),
      footer: runSplitPara(["$scroll.exporter", ".fullName"]),
    });
    const scan = scanTemplate(bytes);
    const bases = scan.supported.map((h) => h.base).sort();
    expect(bases).toContain("$scroll.title");
    expect(bases).toContain("$scroll.exporter.fullName");
    expect(scan.parts).toContain("word/header1.xml");
    expect(scan.parts).toContain("word/footer1.xml");
  });

  it("captures the raw form incl. date argument and counts occurrences", () => {
    const bytes = buildDocx({
      body: para('$scroll.exportdate.("dd.MM.yyyy")') + para("$scroll.exportdate"),
    });
    const scan = scanTemplate(bytes);
    const hit = scan.supported.find((h) => h.base === "$scroll.exportdate");
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(2);
    expect(hit!.raw).toContain('$scroll.exportdate.("dd.MM.yyyy")');
  });

  it("rejects a non-zip buffer (corrupt upload)", () => {
    const notZip = new TextEncoder().encode("this is definitely not a zip file");
    expect(() => unzipDocx(notZip)).toThrow(DocxError);
    try {
      unzipDocx(notZip);
    } catch (err) {
      expect((err as DocxError).kind).toBe("not-zip");
    }
  });

  it("rejects a zip that is not a Word document", () => {
    // A valid zip lacking word/document.xml.
    const PizZip = require("pizzip");
    const zip = new PizZip();
    zip.file("hello.txt", "hi");
    const bytes = zip.generate({ type: "uint8array" });
    try {
      unzipDocx(bytes);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DocxError);
      expect((err as DocxError).kind).toBe("not-docx");
    }
  });

  it("rejects an oversized upload without unzipping", () => {
    const big = new Uint8Array(MAX_TEMPLATE_BYTES + 1);
    try {
      unzipDocx(big);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DocxError).kind).toBe("too-large");
    }
  });
});

// ---------------------------------------------------------------------------
// spec 011 — raw .docx upload archive budget (adversarial)
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const CPU_HEAVY_TEST_TIMEOUT_MS = 30_000;

/** Assert `fn` throws a {@link DocxError} with exactly `kind`. */
function expectDocxError(fn: () => unknown, kind: DocxError["kind"]): DocxError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DocxError);
    // The EXACT kind matters: a case that trips a different guard than the one
    // under test is a failing test, not a pass.
    expect((err as DocxError).kind).toBe(kind);
    return err as DocxError;
  }
  throw new Error(`expected a DocxError(${kind}), but nothing was thrown`);
}

/**
 * A minimal but real Word archive, plus whatever hostile members the case adds.
 * Everything below builds actual zip bytes with PizZip and feeds them through
 * the real `unzipDocx` — no stubbing of the archive layer anywhere.
 */
function buildArchive(members: Record<string, string | Uint8Array>, opts?: { docx?: boolean }): Uint8Array {
  const zip = new PizZip();
  if (opts?.docx !== false) zip.file("word/document.xml", "<w:document/>");
  for (const [name, data] of Object.entries(members)) {
    (zip.file as (n: string, d: string | Uint8Array) => unknown)(name, data);
  }
  return zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
}

describe("unzipDocx — archive budget (spec 011)", () => {
  it("template-intake rejects an oversized XML part before any full-text read", () => {
    const bytes = buildArchive({
      "word/document.xml":
        "<w:document><w:altChunk/></w:document>" + " ".repeat(64),
    });
    const originalFile = PizZip.prototype.file;
    let fullTextReads = 0;
    PizZip.prototype.file = function (this: PizZip, ...args: unknown[]) {
      const entry = (
        originalFile as unknown as (
          this: PizZip,
          ...inner: unknown[]
        ) => unknown
      ).apply(this, args);
      if (
        entry &&
        typeof entry === "object" &&
        "asText" in entry &&
        typeof entry.asText === "function"
      ) {
        const originalAsText = entry.asText.bind(entry);
        entry.asText = () => {
          fullTextReads += 1;
          return originalAsText();
        };
      }
      return entry;
    } as typeof PizZip.prototype.file;
    try {
      const err = expectDocxError(
        () =>
          unzipDocx(bytes, {
            ...DOCX_TEMPLATE_INTAKE_BUDGET,
            maxXmlPartUncompressedBytes: 16,
            maxXmlPartCharacters: 16,
          }),
        "xml-part-too-large"
      );
      expect(err.path).toBe("word/document.xml");
      expect(fullTextReads).toBe(0);
    } finally {
      PizZip.prototype.file = originalFile;
    }
  });

  it("POSITIVE CONTROL: a legitimate template with real media still opens", () => {
    // 4 MiB of genuinely incompressible media across two entries — what a real
    // PNG/JPEG looks like to DEFLATE. Comfortably inside every cap, so the
    // guards must be invisible to real templates.
    const media = new Uint8Array(2 * MB);
    crypto.getRandomValues(media);
    const bytes = buildArchive({
      "word/media/image1.png": media,
      "word/media/image2.png": media,
      "word/styles.xml": "<w:styles/>",
    });
    expect(bytes.byteLength).toBeLessThan(MAX_TEMPLATE_BYTES);
    const zip = unzipDocx(bytes);
    expect(zip.file("word/document.xml")).toBeTruthy();
    expect(zip.file("word/media/image1.png")).toBeTruthy();
  });

  it("rejects a REAL zip bomb: one 70 MiB member declared in a ~70 KB archive", () => {
    // The whole point of the task: MAX_TEMPLATE_BYTES sees a tiny upload and
    // waves it through, so the decompressed budget is the only thing standing
    // between this archive and 70 MiB of allocation.
    const bytes = buildArchive({ "word/media/huge.bin": new Uint8Array(70 * MB) });
    expect(bytes.byteLength).toBeLessThan(MAX_TEMPLATE_BYTES);
    const err = expectDocxError(() => unzipDocx(bytes), "entry-too-large");
    expect(err.path).toBe("word/media/huge.bin");
    expect(err.message).toContain(String(DOCX_ARCHIVE_BUDGET.maxSingleEntryUncompressedBytes));
  });

  it("rejects a REAL cumulative zip bomb: 3 x 50 MiB members, each under the per-entry cap", () => {
    // Every member is individually legal (50 MiB < 64 MiB); only the running
    // total (150 MiB > 128 MiB) is not — proving cumulative accounting, not
    // just a per-entry check.
    // Each member compresses ~50:1 — under MAX_DECLARED_COMPRESSION_RATIO, so
    // the ratio guard stays out of the way and the CUMULATIVE cap is provably
    // what fires (a zeros-filled buffer would trip the ratio guard first and
    // this test would pass for the wrong reason).
    const chunk = new Uint8Array(50 * MB);
    for (let i = 0; i < chunk.length; i += 64) {
      crypto.getRandomValues(chunk.subarray(i, Math.min(i + 2, chunk.length)));
    }
    const bytes = buildArchive({
      "word/media/a.bin": chunk,
      "word/media/b.bin": chunk,
      "word/media/c.bin": chunk,
    });
    expect(bytes.byteLength).toBeLessThan(MAX_TEMPLATE_BYTES);
    expectDocxError(() => unzipDocx(bytes), "uncompressed-too-large");
  });

  it("refuses the bomb WITHOUT inflating it (declared-size accounting)", () => {
    // If the guard inflated to measure, this would allocate 70 MiB. Instead the
    // rejection is driven purely by the central-directory declared size, so the
    // member's data is never touched: assert it stays compressed by checking
    // that the SAME archive is still rejected on a second pass (a decompressing
    // implementation would have cached inflated data on the entry).
    const bytes = buildArchive({ "word/media/huge.bin": new Uint8Array(70 * MB) });
    const heapBefore = process.memoryUsage().heapUsed;
    expectDocxError(() => unzipDocx(bytes), "entry-too-large");
    expectDocxError(() => unzipDocx(bytes), "entry-too-large");
    // A 70 MiB inflation would dwarf this bound; the declared-size path costs
    // essentially nothing.
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(32 * MB);
  });

  it("rejects an entry flood past the entry-count cap", () => {
    const members: Record<string, string> = {};
    for (let i = 0; i <= DOCX_ARCHIVE_BUDGET.maxEntryCount; i++) members[`word/media/f${i}.bin`] = "x";
    const bytes = buildArchive(members);
    const err = expectDocxError(() => unzipDocx(bytes), "too-many-entries");
    expect(err.message).toContain(String(DOCX_ARCHIVE_BUDGET.maxEntryCount));
  });

  it("accepts an archive exactly at the entry-count cap (boundary, positive)", () => {
    const members: Record<string, string> = {};
    // document.xml is member 1, so add cap-1 more to land exactly on the cap.
    for (let i = 0; i < DOCX_ARCHIVE_BUDGET.maxEntryCount - 1; i++) members[`word/media/f${i}.bin`] = "x";
    expect(() => unzipDocx(buildArchive(members))).not.toThrow();
  });
});

describe("unzipDocx — hostile entry names (spec 011)", () => {
  const traversal = [
    "../../evil.txt",
    "word/../../../etc/cron.d/evil",
    "/etc/passwd",
    "C:/Windows/System32/evil.dll",
    "word\\document2.xml",
  ];
  for (const name of traversal) {
    it(`rejects the traversal/absolute entry name ${JSON.stringify(name)}`, () => {
      const err = expectDocxError(() => unzipDocx(buildArchive({ [name]: "x" })), "path-traversal");
      expect(err.path).toBe(name);
    });
  }

  it("rejects a newline smuggled into an entry name", () => {
    const name = "word/media/evil\n../../x.png";
    const err = expectDocxError(() => unzipDocx(buildArchive({ [name]: "x" })), "invalid-path");
    expect(err.path).toBe(name);
  });

  it("rejects a NUL-truncation entry name (image.png\\0.exe)", () => {
    // Reads as image.png to a C string API and as .exe to a JS one — the
    // classic double-extension trick, and a name no real archive needs.
    const name = "word/media/image.png\u0000.exe";
    expectDocxError(() => unzipDocx(buildArchive({ [name]: "x" })), "invalid-path");
  });

  it("POSITIVE CONTROL: ordinary nested Word part names pass", () => {
    expect(() =>
      assertSafeDocxEntryName("word/_rels/document.xml.rels")
    ).not.toThrow();
    expect(() => assertSafeDocxEntryName("word/media/image1.png")).not.toThrow();
    expect(() => assertSafeDocxEntryName("[Content_Types].xml")).not.toThrow();
    // "..." is not a parent segment, and a dotted filename is ordinary.
    expect(() => assertSafeDocxEntryName("word/media/a..b.png")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// spec 011 — active-content policy (adversarial)
// ---------------------------------------------------------------------------

describe("unzipDocx — active content is REJECTED, never stripped (spec 011)", () => {
  it("rejects a real vbaProject.bin (a .docm renamed to .docx)", () => {
    // Genuine CFB/OLE2 compound-file signature — the actual first bytes of a
    // Word VBA project storage.
    const cfbHeader = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const bytes = buildArchive({ "word/vbaProject.bin": cfbHeader });
    const err = expectDocxError(() => unzipDocx(bytes), "active-content");
    expect(err.path).toBe("word/vbaProject.bin");
    expect(err.message).toContain("macros");
  });

  it("rejects vbaProject.bin regardless of case", () => {
    expectDocxError(
      () => unzipDocx(buildArchive({ "word/VBAProject.BIN": "x" })),
      "active-content"
    );
  });

  it("rejects the VBA companion data part", () => {
    expectDocxError(() => unzipDocx(buildArchive({ "word/vbaData.xml": "<wne:vbaSuppData/>" })), "active-content");
  });

  it("rejects an ActiveX/OLE control part", () => {
    const err = expectDocxError(
      () =>
        unzipDocx(
          buildArchive({
            "word/activeX/activeX1.xml":
              `<ax:ocx xmlns:ax="http://schemas.microsoft.com/office/2006/activeX" ax:classid="{8BD21D40-EC42-11CE-9E0D-00AA006002F3}"/>`,
            "word/activeX/activeX1.bin": "x",
          })
        ),
      "active-content"
    );
    expect(err.path?.startsWith("word/activeX/")).toBe(true);
  });

  it("rejects an <w:altChunk> import-by-reference in document.xml", () => {
    const zip = new PizZip();
    zip.file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<w:body><w:altChunk r:id="rId99"/></w:body></w:document>`
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="evil.html"/></Relationships>`
    );
    const bytes = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
    const err = expectDocxError(() => unzipDocx(bytes), "active-content");
    expect(err.path).toBe("word/document.xml");
    expect(err.message).toContain("altChunk");
  });

  it("rejects an <w:altChunk> hidden in a header part (not just document.xml)", () => {
    const bytes = buildArchive({
      "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:altChunk r:id="rId7"/></w:hdr>`,
    });
    const err = expectDocxError(() => unzipDocx(bytes), "active-content");
    expect(err.path).toBe("word/header1.xml");
  });

  it("ADVERSARIAL: rejects an altChunk under ANY namespace prefix, both halves", () => {
    // XML binds namespaces by URI, not by prefix. With `x` bound to
    // wordprocessingml, `<x:altChunk>` IS `<w:altChunk>` as far as Word is
    // concerned. The original `<w:altChunk` literal regex saw nothing at all —
    // a measured bypass. Both halves of the import must now be refused
    // independently, because either alone is enough to identify the template.
    const obfuscatedDocument =
      `<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<x:body><x:altChunk r:id="rId99"/></x:body></x:document>`;

    // Half 1 — the ELEMENT alone, with no relationship part anywhere.
    expectDocxError(
      () => unzipDocx(buildArchive({ "word/document.xml": obfuscatedDocument })),
      "active-content"
    );

    // Half 2 — the RELATIONSHIP alone, with a document that names no altChunk.
    expectDocxError(
      () =>
        unzipDocx(
          buildArchive({
            "word/_rels/document.xml.rels":
              `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
              `<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="evil.html"/></Relationships>`,
          })
        ),
      "active-content"
    );
  });

  it("ADVERSARIAL: catches an aFChunk Type obfuscated with a character reference", () => {
    // `&#107;` is `k` to any conforming parser, so this Type resolves to the
    // real aFChunk URI while differing from it as raw text.
    const err = expectDocxError(
      () =>
        unzipDocx(
          buildArchive({
            "word/_rels/document.xml.rels":
              `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
              `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChun&#107;" Target="evil.html"/></Relationships>`,
          })
        ),
      "active-content"
    );
    expect(err.path).toBe("word/_rels/document.xml.rels");
  });

  it("sweeps every .rels part, not just document.xml.rels", () => {
    const err = expectDocxError(
      () =>
        unzipDocx(
          buildArchive({
            "word/_rels/header1.xml.rels":
              `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
              `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="evil.rtf"/></Relationships>`,
          })
        ),
      "active-content"
    );
    expect(err.path).toBe("word/_rels/header1.xml.rels");
  });

  it("POSITIVE CONTROL: ordinary relationship types are left alone", () => {
    const ordinary =
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>` +
      `<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>` +
      `</Relationships>`;
    expect(hasAltChunkRelationship(ordinary)).toBe(false);
    expect(() =>
      unzipDocx(buildArchive({ "word/_rels/document.xml.rels": ordinary }))
    ).not.toThrow();

    // A Target that merely mentions aFChunk is not a relationship TYPE, and a
    // type that merely CONTAINS the token mid-path does not end in it.
    expect(
      hasAltChunkRelationship(
        `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/aFChunk"/>`
      )
    ).toBe(false);
    expect(
      hasAltChunkRelationship(
        `<Relationship Id="rId9" Type="http://example.com/aFChunk/notReally" Target="x"/>`
      )
    ).toBe(false);
  });

  it("POSITIVE CONTROL: an ordinary template with no active content opens", () => {
    const bytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });
    expect(() => unzipDocx(bytes)).not.toThrow();
    // And a part whose NAME merely contains "activex" as a substring elsewhere
    // is not mistaken for the activeX folder.
    expect(() => unzipDocx(buildArchive({ "word/media/activex-logo.png": "x" }))).not.toThrow();
    // "altChunk" appearing as literal document TEXT is not an altChunk element.
    expect(() =>
      unzipDocx(buildDocx({ body: para("The w:altChunk element is documented in ECMA-376.") }))
    ).not.toThrow();
  });
});

describe("collectRiskyFieldInstructions — audit, not rejection (spec 011)", () => {
  it("REJECTS a run-split DDEAUTO field at import (not merely audited)", () => {
    // The classic DDE RCE payload, split across runs exactly as Word writes it.
    // DDE has no legitimate use in an export template and must be refused, not
    // reported. The refusal does NOT rest on the exporter setting
    // `<w:updateFields>` — that flag became conditional (see
    // `update-fields.test.ts`), and `DDE` is deliberately not on the
    // refresh-sensitive list, so without this rejection such a template would
    // export with no flag and no note at all. A DDE field fires on any refresh
    // the reader triggers.
    const bytes = buildDocx({
      body:
        `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
        `<w:r><w:instrText xml:space="preserve"> DDEA</w:instrText></w:r>` +
        `<w:r><w:instrText xml:space="preserve">UTO cmd.exe "/k calc.exe"</w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    });
    const err = expectDocxError(() => unzipDocx(bytes), "active-content");
    expect(err.message).toContain("DDEAUTO");
  });

  it("REJECTS a bare DDE field too", () => {
    const bytes = buildDocx({
      body: `<w:p><w:fldSimple w:instr=" DDE Excel Sheet1 R1C1 "/></w:p>`,
    });
    expectDocxError(() => unzipDocx(bytes), "active-content");
  });

  it("detects INCLUDETEXT in a w:fldSimple instruction attribute", () => {
    const xml = `<w:fldSimple w:instr=" INCLUDETEXT &quot;\\\\\\\\attacker\\\\share\\\\x.docx&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple>`;
    expect(collectRiskyFieldInstructions(xml)).toEqual(["INCLUDETEXT"]);
  });

  it("POSITIVE CONTROL: ordinary fields produce no risk hits", () => {
    const xml =
      `<w:fldSimple w:instr=" PAGE "/>` +
      `<w:fldSimple w:instr=" STYLEREF &quot;Heading 1&quot; "/>` +
      `<w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r>`;
    expect(collectRiskyFieldInstructions(xml)).toEqual([]);
  });

  it("surfaces the hits on the scan result without refusing the template", () => {
    const bytes = buildDocx({
      body:
        para("$scroll.content") +
        `<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;http://attacker.example/x.png&quot; "/></w:p>`,
    });
    const scan = scanTemplate(bytes);
    expect(scan.riskyFieldInstructions).toEqual(["INCLUDEPICTURE"]);
    expect(scan.hasContentPlaceholder).toBe(true);
  });

  it("reports nothing for a clean template", () => {
    const scan = scanTemplate(buildDocx({ body: para("$scroll.title") }));
    expect(scan.riskyFieldInstructions).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// spec 011 round 3 — forged central directory + relationship-based bypasses
// ---------------------------------------------------------------------------

/**
 * Overwrite the uncompressed-size field in an entry's central-directory record
 * AND its local header, producing an archive that LIES about how much it
 * inflates to. This is the shape a real attacker ships: the zip is structurally
 * valid, only the size metadata is false.
 */
function forgeDeclaredSize(zipBytes: Uint8Array, entryName: string, lie: number): Uint8Array {
  const out = new Uint8Array(zipBytes);
  const view = new DataView(out.buffer);
  const name = new TextEncoder().encode(entryName);
  const nameAt = (off: number): boolean => {
    for (let i = 0; i < name.length; i++) if (out[off + i] !== name[i]) return false;
    return true;
  };
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x02014b50 && view.getUint16(i + 28, true) === name.length && nameAt(i + 46)) {
      view.setUint32(i + 24, lie, true);
    }
    if (sig === 0x04034b50 && view.getUint16(i + 26, true) === name.length && nameAt(i + 30)) {
      view.setUint32(i + 22, lie, true);
    }
  }
  return out;
}

describe("unzipDocx — forged central directory (spec 011 round 3)", () => {
  it("refuses a member that under-declares its size, BEFORE inflating it", () => {
    // 200 MiB of spaces compresses to a couple of hundred KiB. Declaring 1 KiB
    // slips under every absolute cap; without the ratio guard PizZip inflates
    // the full payload and only then throws an untyped size-mismatch error.
    const payload = "<w:document>" + " ".repeat(200 * MB) + "</w:document>";
    const zip = new PizZip();
    zip.file("word/document.xml", payload);
    const honest = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
    const liar = forgeDeclaredSize(honest, "word/document.xml", 1024);
    expect(liar.byteLength).toBeLessThan(MAX_TEMPLATE_BYTES);

    const before = process.memoryUsage().rss;
    const err = expectDocxError(() => unzipDocx(liar), "suspicious-compression");
    const grew = (process.memoryUsage().rss - before) / MB;

    expect(err.path).toBe("word/document.xml");
    expect(err.message).toContain("DEFLATE never expands");
    // The proof that nothing inflated: 200 MiB of payload would dwarf this.
    expect(grew).toBeLessThan(64);
  }, CPU_HEAVY_TEST_TIMEOUT_MS);

  it("still refuses the HONEST form of the same bomb (via the absolute cap)", () => {
    const payload = "<w:document>" + " ".repeat(200 * MB) + "</w:document>";
    const zip = new PizZip();
    zip.file("word/document.xml", payload);
    const honest = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
    expectDocxError(() => unzipDocx(honest), "entry-too-large");
  }, CPU_HEAVY_TEST_TIMEOUT_MS);

  it("refuses an implausibly high declared ratio that stays under the absolute caps", () => {
    // 60 MiB declared (< the 64 MiB per-entry cap) from a tiny stream.
    const zip = new PizZip();
    zip.file("word/document.xml", "<w:document/>");
    (zip.file as (n: string, d: Uint8Array) => unknown)("word/media/x.bin", new Uint8Array(60 * MB));
    const bytes = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
    expectDocxError(() => unzipDocx(bytes), "suspicious-compression");
  });

  it("POSITIVE CONTROL: a highly repetitive but legitimate template still opens", () => {
    // 20 000 identical paragraphs compress ~305:1 — the shape that made an
    // earlier 100:1 cap reject real templates. Must pass at 500:1.
    const bytes = buildDocx({ body: `<w:p><w:r><w:t>identical</w:t></w:r></w:p>`.repeat(20000) });
    expect(() => unzipDocx(bytes)).not.toThrow();
  });

  it("POSITIVE CONTROL: ordinary small parts are not tripped by the ratio floor", () => {
    // [Content_Types].xml and friends are tiny, where zip framing dominates and
    // the ratio is meaningless.
    expect(() => unzipDocx(buildDocx({ body: para("hi") }))).not.toThrow();
  });
});

describe("assertNoActiveContent — bypass matrix (spec 011 round 3)", () => {
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
  const R = `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const RELNS = `xmlns="http://schemas.openxmlformats.org/package/2006/relationships"`;

  const rels = (type: string, target: string): string =>
    `<Relationships ${RELNS}><Relationship Id="r9" Type="${type}" Target="${target}"/></Relationships>`;

  // Every one of these was ACCEPTED before the relationship-based rewrite.
  const BYPASSES: Array<[string, Record<string, string>]> = [
    ["altChunk in word/footnotes.xml", { "word/footnotes.xml": `<w:footnotes ${W} ${R}><w:altChunk r:id="r1"/></w:footnotes>` }],
    ["altChunk in word/endnotes.xml", { "word/endnotes.xml": `<w:endnotes ${W} ${R}><w:altChunk r:id="r1"/></w:endnotes>` }],
    ["altChunk in word/comments.xml", { "word/comments.xml": `<w:comments ${W} ${R}><w:altChunk r:id="r1"/></w:comments>` }],
    ["altChunk in word/glossary/document.xml", { "word/glossary/document.xml": `<w:document ${W} ${R}><w:altChunk r:id="r1"/></w:document>` }],
    ["VBA at word/macros/vbaProject.bin", { "word/macros/vbaProject.bin": "MZ" }],
    ["VBA at customXml/vbaProject.bin", { "customXml/vbaProject.bin": "MZ" }],
    ["ActiveX at word/controls/activeX1.xml", { "word/controls/activeX1.xml": "<ax:ocx/>" }],
    ["VBA declared only by relationship type", {
      "word/thing.bin": "MZ",
      "word/_rels/document.xml.rels": rels("http://schemas.microsoft.com/office/2006/relationships/vbaProject", "thing.bin"),
    }],
    ["ActiveX declared only by relationship type", {
      "word/thing.xml": "<ax:ocx/>",
      "word/_rels/document.xml.rels": rels("http://schemas.openxmlformats.org/officeDocument/2006/relationships/control", "thing.xml"),
    }],
  ];

  for (const [label, members] of BYPASSES) {
    it(`rejects: ${label}`, () => {
      expectDocxError(() => unzipDocx(buildArchive(members)), "active-content");
    });
  }

  it("rejects an <x:altChunk> hiding behind a non-w namespace prefix", () => {
    const zip = new PizZip();
    zip.file(
      "word/document.xml",
      `<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${R}>` +
        `<x:body><x:altChunk r:id="r1"/></x:body></x:document>`
    );
    const bytes = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
    expectDocxError(() => unzipDocx(bytes), "active-content");
  });

  it("POSITIVE CONTROL: ordinary relationship types and part names still pass", () => {
    expect(() =>
      unzipDocx(
        buildArchive({
          "word/media/image1.png": "x",
          "word/_rels/document.xml.rels": rels(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
            "media/image1.png"
          ),
        })
      )
    ).not.toThrow();
    // An embedded OLE object is a deliberate ALLOW (legitimate in corporate
    // templates); if that product call is ever revisited, this test states it.
    expect(() =>
      unzipDocx(
        buildArchive({
          "word/embeddings/sheet.xlsx": "x",
          "word/_rels/document.xml.rels": rels(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject",
            "embeddings/sheet.xlsx"
          ),
        })
      )
    ).not.toThrow();
    // A part merely NAMED like a control is fine when it is not one.
    expect(() => unzipDocx(buildArchive({ "word/media/activex-logo.png": "x" }))).not.toThrow();
  });
});
