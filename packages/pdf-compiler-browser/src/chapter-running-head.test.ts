/**
 * Chapter running head ("Kolumnentitel") — `features.header.mode: "chapter"`.
 *
 * A spec 012 follow-up (see that folder's PLAN.md): the built-in template's
 * running head had exactly two behaviors — the document title + space key, or a
 * fixed `headerText` string. Neither is chapter-aware, so a 57-page tree export
 * repeated the root page title on every page. `"chapter"` is the third mode.
 *
 * A second follow-up (2026-07-20, user review of the M1 acceptance artifacts)
 * refined *which* chapter a page names when several chapters begin on one page:
 * the FIRST one, not the last. See the "first on the page" section below.
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
  validatePdfOutput,
  type ExportBlock,
  type PdfExportMetadata,
  type PdfTemplateSettings,
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
import { BrowserPdfCompiler, PDF_BROWSER_COMPILER_VERSION } from "./index.js";

/**
 * The Typst constructs the chapter mode is built on (all verified below).
 *
 * `CHAPTER_QUERY` is the chapter *set* — every outlined level-1 heading.
 * `OPENING_ON_PAGE` / `STILL_RUNNING` split it by page index, and the head is
 * the FIRST of the ones opening on this page, else the LAST of the ones already
 * running.
 */
const CHAPTER_QUERY = "query(heading.where(level: 1)).filter(h => h.outlined)";
const OPENING_ON_PAGE = "chapters.filter(h => h.location().page() == here().page())";
const STILL_RUNNING = "chapters.filter(h => h.location().page() < here().page())";
const FIRST_ON_PAGE = "if opening.len() > 0 { opening.first().body }";

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

/**
 * Three chapters short enough that all three BEGIN on the same body page — the
 * case the first-on-page rule is about. Asserted, not assumed: the tests that
 * use it check the resulting page count.
 */
function crowdedPage(): ExportBlock[] {
  return [
    heading("Alpha Chapter"),
    paragraph("Alpha is a stub chapter: a single line of body copy."),
    heading("Beta Chapter"),
    paragraph("Beta is a stub chapter: a single line of body copy."),
    heading("Gamma Chapter"),
    paragraph("Gamma is a stub chapter: a single line of body copy."),
  ];
}

/**
 * The equivalence fixture: one chapter per page, which is what `composeChapters`
 * produces with its default per-chapter `pageBreak`. Under this layout the
 * pre-refinement rule ("last outlined level-1 heading at or before this page")
 * and the refined rule ("first one opening on this page, else the still-running
 * one") select the same heading on every page.
 *
 * KEEP BYTE-STABLE: {@link ONE_PER_PAGE_PRE_REFINEMENT_DIGEST} is a digest of
 * this exact fixture. Editing the blocks, the metadata, or the manifest
 * invalidates the pinned number and the equivalence proof with it.
 */
const ONE_PER_PAGE_CHAPTERS = ["Alpha", "Beta", "Gamma", "Delta"] as const;

const ONE_PER_PAGE_BLOCKS: ExportBlock[] = ONE_PER_PAGE_CHAPTERS.flatMap((name, index) => [
  ...(index === 0 ? [] : [{ type: "pageBreak" } as ExportBlock]),
  heading(`${name} Chapter`),
  paragraph(`${name} body copy, short enough to leave the page well before its foot.`),
]);

const ONE_PER_PAGE_METADATA: PdfExportMetadata = {
  title: "One Chapter Per Page",
  space: "DOCSY",
  version: 3,
  author: "Ada Lovelace",
  exporter: "atlcli",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-19T00:00:00.000Z"),
};

/**
 * sha256 of {@link ONE_PER_PAGE_BLOCKS} rendered in `chapter` mode through the
 * built-in manifest by the PRE-REFINEMENT rule, i.e. by
 *
 *   let started = query(heading.where(level: 1))
 *     .filter(h => h.outlined and h.location().page() <= here().page())
 *   let chapter-head = if started.len() > 0 { started.last().body } else { meta.title }
 *
 * Provenance: captured from `origin/main` at commit
 * `62a003134bb139270441be907bd1572ed41c7c4a` (PR #66, the commit immediately
 * before the first-on-page refinement) with the pinned compiler
 * {@link PINNED_COMPILER}, by compiling this fixture with that checkout's
 * unmodified `packages/pdf/src/template.ts`. The refined rule reproducing this
 * digest byte-for-byte is the proof that the normal one-chapter-per-page case
 * did not regress.
 *
 * A change here is NOT a re-baselining candidate: it means the refinement
 * altered output in the very case it was supposed to leave alone.
 */
const ONE_PER_PAGE_PRE_REFINEMENT_DIGEST =
  "90bef12c83c654c059f5cc3918b21469c3640c7dad78683676b7766b02023ca0";

/** Digests are only comparable within one compiler version. */
const PINNED_COMPILER = "typst.ts 0.7.0 / Typst 0.14.2";

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
  templateManifest: TemplateManifest,
  settings?: PdfTemplateSettings
): Promise<Uint8Array> {
  const prepared = await preparePdfDocument(blocks, {
    resolve: async () => {
      throw new Error("this fixture has no external assets");
    },
  });
  const bundle = serializePdfDocument(prepared, {
    metadata: meta,
    templateManifest,
    ...(settings === undefined ? {} : { settings }),
  });
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
    // Invariant 1: a chapter that OPENS on this page must be selected. `here()`
    // in a page header resolves to the TOP of the page, so a `.before(here())`
    // selector excludes such a chapter and lags one page behind at every
    // chapter opening. Verified against the pinned compiler; the page-index
    // equality comparison is the construct that survived.
    expect(source).toContain(OPENING_ON_PAGE);
    expect(source).not.toContain(".before(here())");
    // Invariant 3: first-on-page, and the still-running chapter as the fallback
    // for a page no chapter opens on.
    expect(source).toContain(FIRST_ON_PAGE);
    expect(source).toContain(STILL_RUNNING);
    expect(source).toContain("running.last().body");
    // ...never `.last()` over the headings opening on this page.
    expect(source).not.toContain("opening.last()");
    // The space key stays on the right and the hairline is unchanged.
    expect(source).toContain("grid(columns: (1fr, auto), chapter-head, meta.space)");
    expect(source).toContain("line(length: 100%,");
  });

  it("chapter mode keeps the outlined filter that excludes the ToC heading", () => {
    // Invariant 2, asserted on the source as well as behaviorally (the fallback
    // test below is the render-level regression guard). `outline()` emits its
    // own level-1 heading; it is the only one with `outlined: false`.
    const source = createAtlcliTypstTemplate(manifestWithHeaderMode("chapter").design!);
    expect(source).toContain("h.outlined");
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
  // (d) several chapters on one page -> the FIRST of them
  // -------------------------------------------------------------------------
  //
  // Refinement of 2026-07-20 (user review of the M1 acceptance artifacts). The
  // head sits at the TOP of the page and the content directly below it starts
  // with the first chapter that begins there, so naming a later one contradicts
  // what the reader sees. It is also the dictionary/guide-word convention.

  it("names the FIRST chapter when several chapters begin on the same page", async () => {
    // Three short chapters share one body page (asserted). Header-bearing pages
    // are the ToC page (fallback -> document title) and that one body page. With
    // the document title set to the FIRST chapter, title mode reads
    // "Alpha Chapter" on both, and chapter mode can only agree if the body page
    // resolves to "Alpha Chapter" too. The previous `.last()` rule resolved it
    // to "Gamma Chapter" and this assertion fails under it.
    const blocks = crowdedPage();
    const meta = metadata("Alpha Chapter");
    const chaptered = await render(blocks, meta, manifestWithHeaderMode("chapter"));
    // cover + ToC + one body page + closing page: all three chapters share a page.
    expect(validatePdfOutput(chaptered).pageCount).toBe(4);
    const titled = await render(blocks, meta, manifestWithHeaderMode("title"));
    expect(digest(chaptered)).toBe(digest(titled));
  }, 180_000);

  it("does NOT name the last chapter when several chapters begin on the same page", async () => {
    // The mirrored control. Same fixture, document title set to the LAST chapter
    // instead: chapter mode must now DIFFER from title mode, because the body
    // page reads "Alpha Chapter" while the title-mode head reads "Gamma
    // Chapter". Without this control the test above would also pass for a rule
    // that ignored chapters entirely and always emitted the document title.
    const blocks = crowdedPage();
    const meta = metadata("Gamma Chapter");
    const titled = await render(blocks, meta, manifestWithHeaderMode("title"));
    const chaptered = await render(blocks, meta, manifestWithHeaderMode("chapter"));
    expect(digest(chaptered)).not.toBe(digest(titled));
  }, 180_000);

  // -------------------------------------------------------------------------
  // (e) the two page kinds, isolated
  // -------------------------------------------------------------------------

  it("a chapter that OPENS on a page heads that page (invariant 1, isolated)", async () => {
    // One short chapter: the only body page is the page the chapter opens on.
    // Document title differs from the chapter, so title mode heads that page
    // "Unrelated Document" and chapter mode must head it "Alpha Chapter" — the
    // renders differ, and the opening page is the ONLY page that can account for
    // it (the ToC page falls back to the document title in both modes). A
    // `.before(here())` selector, which excludes a chapter opening on this very
    // page, would make the two renders equal and fail here.
    const blocks = [heading("Alpha Chapter"), paragraph("A chapter short enough to fit its page.")];
    const opening = await render(blocks, metadata("Unrelated Document"), manifestWithHeaderMode("chapter"));
    expect(validatePdfOutput(opening).pageCount).toBe(4);
    const titled = await render(blocks, metadata("Unrelated Document"), manifestWithHeaderMode("title"));
    expect(digest(opening)).not.toBe(digest(titled));

    // ...and the positive pins it to exactly the chapter's own text.
    const meta = metadata("Alpha Chapter");
    expect(digest(await render(blocks, meta, manifestWithHeaderMode("chapter")))).toBe(
      digest(await render(blocks, meta, manifestWithHeaderMode("title")))
    );
  }, 240_000);

  it("a CONTINUATION page heads the still-running chapter (isolated)", async () => {
    // Cover and outline are switched off, so the chapter opens on page 1 — where
    // the header is suppressed — and the closing page is the last. Every
    // header-bearing page is therefore a pure continuation page of "Alpha
    // Chapter": no chapter begins on it. If the still-running branch were
    // missing (a page with no chapter opening on it falling through to the
    // document-title fallback) these two renders would be EQUAL, so the
    // inequality is attributable to continuation pages and nothing else.
    const blocks = [heading("Alpha Chapter"), ...filler("alpha"), ...filler("alpha continued")];
    const bare: PdfTemplateSettings = { cover: false, outline: false };
    const chaptered = await render(blocks, metadata("Unrelated Document"), manifestWithHeaderMode("chapter"), bare);
    // >= 4 pages means at least two header-bearing continuation pages exist.
    expect(validatePdfOutput(chaptered).pageCount).toBeGreaterThanOrEqual(4);
    const titled = await render(blocks, metadata("Unrelated Document"), manifestWithHeaderMode("title"), bare);
    expect(digest(chaptered)).not.toBe(digest(titled));

    // ...and the positive pins those continuation heads to the chapter's text.
    const meta = metadata("Alpha Chapter");
    expect(digest(await render(blocks, meta, manifestWithHeaderMode("chapter"), bare))).toBe(
      digest(await render(blocks, meta, manifestWithHeaderMode("title"), bare))
    );
  }, 240_000);

  // -------------------------------------------------------------------------
  // (f) equivalence with the pre-refinement rule in the normal case
  // -------------------------------------------------------------------------

  it("a one-chapter-per-page document is byte-identical to the pre-refinement render", async () => {
    // For documents with at most ONE chapter starting per page — the normal
    // case, since `composeChapters` inserts a pageBreak per chapter by default —
    // "first chapter opening on this page" and "last heading at or before this
    // page" select the same heading, so the refinement must be a no-op.
    //
    // The old rule cannot be executed any more, so the proof is a pinned digest
    // of a render produced by it. See ONE_PER_PAGE_PRE_REFINEMENT_DIGEST for the
    // provenance of that number.
    const chaptered = await render(
      ONE_PER_PAGE_BLOCKS,
      ONE_PER_PAGE_METADATA,
      manifestWithHeaderMode("chapter")
    );
    // cover + ToC + one page per chapter + closing page: exactly one chapter
    // starts on each body page, which is the precondition the claim is about.
    expect(validatePdfOutput(chaptered).pageCount).toBe(3 + ONE_PER_PAGE_CHAPTERS.length);
    expect(PDF_BROWSER_COMPILER_VERSION).toBe(PINNED_COMPILER);
    expect(digest(chaptered)).toBe(ONE_PER_PAGE_PRE_REFINEMENT_DIGEST);

    // Guard the fixture: the head really does track the chapters here (the
    // document title matches none of them), so the digest above is not the
    // trivially chapter-independent title-mode output.
    const titled = await render(
      ONE_PER_PAGE_BLOCKS,
      ONE_PER_PAGE_METADATA,
      manifestWithHeaderMode("title")
    );
    expect(digest(chaptered)).not.toBe(digest(titled));
  }, 240_000);

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
