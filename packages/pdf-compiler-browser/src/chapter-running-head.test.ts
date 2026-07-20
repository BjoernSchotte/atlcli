/**
 * Chapter running head ("Kolumnentitel") — `features.header.mode: "chapter"`.
 *
 * A spec 012 follow-up (see that folder's PLAN.md): the built-in template's
 * running head had exactly two behaviors — the document title + space key, or a
 * fixed `headerText` string. Neither is chapter-aware, so a 57-page tree export
 * repeated the root page title on every page. `"chapter"` is the third mode.
 *
 * ## Why the assertions look the way they do
 *
 * Typst subsets its fonts and emits glyph ids, so header text is NOT recoverable
 * from the compiled PDF's content streams (only heading text reaches the outline
 * and structure tree, and the running head is in neither). Extracting it would
 * mean reimplementing a font-subset decoder — so instead these tests use
 * **byte-equality between two real renders that are constructed to agree only if
 * the header resolves to a specific string**. That is a stronger claim than a
 * substring match, not a weaker one: any other resolution (empty head, wrong
 * chapter, a stale chapter) changes the header content and therefore the bytes.
 *
 * Nothing is mocked: real compiler, real fonts, real manifest validation.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  type ExportBlock,
  type PdfExportMetadata,
} from "@atlcli/pdf/browser";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
  createAtlcliTypstTemplate,
  serializePdfDocument,
} from "@atlcli/pdf/internal";
import {
  validateManifest,
  type DesignHeaderMode,
  type TemplateManifest,
} from "@atlcli/template-pack";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

/** The Typst construct the chapter mode is built on (verified below). */
const CHAPTER_QUERY =
  "query(heading.where(level: 1)).filter(h => h.outlined and h.location().page() <= here().page())";

/**
 * A validated built-in manifest with an explicit running-head mode. Re-runs the
 * real import gate, so a mode the schema rejects never reaches a render here.
 */
function manifestWithHeaderMode(mode: DesignHeaderMode | undefined): TemplateManifest {
  const raw = structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST) as TemplateManifest;
  if (mode === undefined) delete raw.design!.features.header.mode;
  else raw.design!.features.header.mode = mode;
  return validateManifest(raw);
}

function paragraph(text: string): ExportBlock {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function heading(text: string): ExportBlock {
  return { type: "heading", level: 1, content: [{ type: "text", text }] };
}

/** Enough body copy that a chapter reliably spans more than one page. */
function filler(tag: string): ExportBlock[] {
  return Array.from({ length: 26 }, (_, i) =>
    paragraph(
      `${tag} paragraph ${i}. Body copy that fills the measure so the chapter ` +
        "runs past a single page and the running head is exercised on a page " +
        "that does not itself carry the chapter opening."
    )
  );
}

function metadata(title: string): PdfExportMetadata {
  return {
    title,
    space: "DOCSY",
    version: 3,
    author: "Ada Lovelace",
    exporter: "atlcli",
    language: "en",
    region: "GB",
    exportedAt: new Date("2026-07-19T00:00:00.000Z"),
  };
}

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer());
}

let compiler: BrowserPdfCompiler;

async function render(
  blocks: ExportBlock[],
  meta: PdfExportMetadata,
  templateManifest: TemplateManifest
): Promise<Uint8Array> {
  const prepared = await preparePdfDocument(blocks, {
    resolve: async () => {
      throw new Error("this fixture has no external assets");
    },
  });
  const bundle = serializePdfDocument(prepared, { metadata: meta, templateManifest });
  const result = await compiler.compile(bundle);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`compile failed: ${JSON.stringify(errors)}`);
  return result.pdf!;
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("chapter running head (real compiler)", () => {
  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    await ensureVendoredTypst();
    const [wasm, ...fonts] = await Promise.all([
      packageBytes("@atlcli/pdf-compiler-browser/wasm"),
      ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
    ]);
    compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
  }, 120_000);

  // -------------------------------------------------------------------------
  // (a) the default path is untouched
  // -------------------------------------------------------------------------

  it("the default design emits the historical title header and no chapter query", () => {
    const source = createAtlcliTypstTemplate();
    expect(source).toContain("grid(columns: (1fr, auto), meta.title, meta.space)");
    expect(source).not.toContain(CHAPTER_QUERY);
    expect(source).not.toContain("chapter-head");
    // The built-in ships without a mode at all — absent means "title".
    expect(BUILTIN_PDF_TEMPLATE_MANIFEST.design!.features.header.mode).toBeUndefined();
  });

  it("an explicit title mode generates source identical to an absent mode", () => {
    // Proves the new field cannot perturb the default path: the pinned
    // pre-migration digest in template-migration-parity.test.ts is rendered from
    // exactly this source.
    expect(createAtlcliTypstTemplate(manifestWithHeaderMode("title").design!)).toBe(
      createAtlcliTypstTemplate(manifestWithHeaderMode(undefined).design!)
    );
  });

  it("custom mode resolves like title mode (an explicit headerText still wins)", () => {
    // `custom` is declarative: `headerText` already outranks the mode in every
    // branch, so it must not introduce a second, divergent code path.
    expect(createAtlcliTypstTemplate(manifestWithHeaderMode("custom").design!)).toBe(
      createAtlcliTypstTemplate(manifestWithHeaderMode(undefined).design!)
    );
  });

  it("the default document renders byte-identically with and without an explicit title mode", async () => {
    const blocks = [heading("Alpha Chapter"), ...filler("alpha")];
    const meta = metadata("Some Document");
    const absent = await render(blocks, meta, manifestWithHeaderMode(undefined));
    const explicit = await render(blocks, meta, manifestWithHeaderMode("title"));
    expect(digest(explicit)).toBe(digest(absent));
  }, 180_000);

  // -------------------------------------------------------------------------
  // (b) chapter mode renders the CURRENT chapter
  // -------------------------------------------------------------------------

  it("chapter mode emits the verified page-index query, not the lagging before(here()) form", () => {
    const source = createAtlcliTypstTemplate(manifestWithHeaderMode("chapter").design!);
    expect(source).toContain(CHAPTER_QUERY);
    // `here()` in a page header resolves to the TOP of the page, so a
    // `.before(here())` selector excludes a chapter that opens on that page and
    // lags one page behind at every chapter opening. Verified against the pinned
    // compiler; the page-index comparison is the construct that survived.
    expect(source).not.toContain(".before(here())");
    // The space key stays on the right and the hairline is unchanged.
    expect(source).toContain("grid(columns: (1fr, auto), chapter-head, meta.space)");
    expect(source).toContain("line(length: 100%,");
  });

  it("a single chapter whose title equals the document title renders identically in both modes", async () => {
    // The decisive positive: if the chapter head resolved to anything other than
    // the chapter heading's own text ("Alpha Chapter"), these two renders would
    // differ. Equality pins the header content to exactly that string.
    const blocks = [heading("Alpha Chapter"), ...filler("alpha")];
    const meta = metadata("Alpha Chapter");
    const titled = await render(blocks, meta, manifestWithHeaderMode("title"));
    const chaptered = await render(blocks, meta, manifestWithHeaderMode("chapter"));
    expect(digest(chaptered)).toBe(digest(titled));
  }, 180_000);

  it("a second chapter changes the running head on its own pages", async () => {
    // Same document, same document title as the FIRST chapter. In title mode the
    // head is "Alpha Chapter" on every page; in chapter mode the Zeta pages must
    // read "Zeta Chapter". Different bytes therefore prove the head TRACKS the
    // current chapter rather than being a constant.
    const blocks = [
      heading("Alpha Chapter"),
      ...filler("alpha"),
      heading("Zeta Chapter"),
      ...filler("zeta"),
    ];
    const meta = metadata("Alpha Chapter");
    const titled = await render(blocks, meta, manifestWithHeaderMode("title"));
    const chaptered = await render(blocks, meta, manifestWithHeaderMode("chapter"));
    expect(digest(chaptered)).not.toBe(digest(titled));
  }, 180_000);

  it("the FIRST chapter's pages read the first chapter, not the document title", async () => {
    // Mirror of the test above: the document title now matches the SECOND
    // chapter, so in title mode every page reads "Zeta Chapter" while in chapter
    // mode the Alpha pages must read "Alpha Chapter". Together the two tests
    // prove each chapter's pages carry that chapter's own heading — a head that
    // latched onto one chapter (or onto the title) would pass at most one.
    const blocks = [
      heading("Alpha Chapter"),
      ...filler("alpha"),
      heading("Zeta Chapter"),
      ...filler("zeta"),
    ];
    const meta = metadata("Zeta Chapter");
    const titled = await render(blocks, meta, manifestWithHeaderMode("title"));
    const chaptered = await render(blocks, meta, manifestWithHeaderMode("chapter"));
    expect(digest(chaptered)).not.toBe(digest(titled));
  }, 180_000);

  // -------------------------------------------------------------------------
  // (c) the no-preceding-heading fallback
  // -------------------------------------------------------------------------

  it("falls back to the document title when no chapter heading precedes the page", async () => {
    // A document with NO level-1 heading at all: every page's chapter query is
    // empty. Byte-equality with title mode proves the fallback renders the
    // document title — an empty head would change the header content and the
    // bytes.
    //
    // This is also the regression guard for the table of contents: `outline`
    // renders its own level-1 heading ("Contents", the only one with
    // `outlined: false`), and the outline is ON in this fixture. Before the
    // `h.outlined` filter this test failed, because every page of every
    // document was titled "Contents".
    const blocks = [...filler("front matter")];
    const meta = metadata("Front Matter Only");
    const titled = await render(blocks, meta, manifestWithHeaderMode("title"));
    const chaptered = await render(blocks, meta, manifestWithHeaderMode("chapter"));
    expect(digest(chaptered)).toBe(digest(titled));
  }, 180_000);

  it("falls back on the pages that precede the first level-1 heading", async () => {
    // Front matter first, then a chapter whose text differs from the title. The
    // front-matter pages must keep showing the document title while the chapter
    // pages switch — so the two modes differ, but only because of the chapter
    // pages (the fallback case above already pinned the front-matter half).
    const blocks = [...filler("front matter"), heading("Zeta Chapter"), ...filler("zeta")];
    const meta = metadata("Front Matter Only");
    const titled = await render(blocks, meta, manifestWithHeaderMode("title"));
    const chaptered = await render(blocks, meta, manifestWithHeaderMode("chapter"));
    expect(digest(chaptered)).not.toBe(digest(titled));
  }, 180_000);

  // -------------------------------------------------------------------------
  // Manuscript ships the mode
  // -------------------------------------------------------------------------

  it("Manuscript declares the chapter mode and renders it through the unchanged engine", async () => {
    expect(MANUSCRIPT_PDF_TEMPLATE_MANIFEST.design!.features.header.mode).toBe("chapter");
    const source = createAtlcliTypstTemplate(MANUSCRIPT_PDF_TEMPLATE_MANIFEST.design!);
    expect(source).toContain(CHAPTER_QUERY);

    // The chapter title genuinely reaches Manuscript's header: same
    // equal-title / differing-title pair as above, run through Manuscript.
    const meta = metadata("Alpha Chapter");
    const manuscriptTitleMode = validateManifest({
      ...structuredClone(MANUSCRIPT_PDF_TEMPLATE_MANIFEST),
      design: {
        ...structuredClone(MANUSCRIPT_PDF_TEMPLATE_MANIFEST.design!),
        features: {
          ...structuredClone(MANUSCRIPT_PDF_TEMPLATE_MANIFEST.design!.features),
          header: { enabled: true, mode: "title" },
        },
      },
    } as TemplateManifest);

    const single = [heading("Alpha Chapter"), ...filler("alpha")];
    expect(digest(await render(single, meta, MANUSCRIPT_PDF_TEMPLATE_MANIFEST))).toBe(
      digest(await render(single, meta, manuscriptTitleMode))
    );

    const multi = [heading("Alpha Chapter"), ...filler("alpha"), heading("Zeta Chapter"), ...filler("zeta")];
    expect(digest(await render(multi, meta, MANUSCRIPT_PDF_TEMPLATE_MANIFEST))).not.toBe(
      digest(await render(multi, meta, manuscriptTitleMode))
    );
  }, 240_000);
});
