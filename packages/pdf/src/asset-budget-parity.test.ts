/**
 * Asset-budget parity (spec 002) — the SAME multi-image fixture pushed through
 * both `runExport` (DOCX) and `runPdfExport` (PDF) breaches the shared budget
 * identically: same error type ({@link AssetBudgetExceededError}), same
 * largest-first offender list, same abort-before-output behavior. This is the
 * proof the {@link AssetBudget} contract is actually shared, not just similarly
 * named. No mocks — real engines, in-memory ports.
 */
import { describe, expect, it } from "bun:test";
import {
  AssetBudgetExceededError,
  type AssetBudgetOffender,
  type ExportBlock,
} from "@atlcli/confluence";
import { runExport } from "@atlcli/docx";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { runPdfExport } from "./run-export.js";
import type { PdfAssetResolver } from "./types.js";

const MIB = 1024 * 1024;
const IMAGE_BYTES = 18 * MIB; // three of these (54 MiB) breach the 50 MiB cap.

/** A big-but-valid PNG: real signature + IHDR header, zero-padded to `size`. */
function bigPng(size: number, uniqueHeight: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
    0, 0, 0, 1, // width = 1
    0, 0, 0, uniqueHeight, // height (varied → distinct bytes, no dedup)
  ]);
  return bytes;
}

// Three distinct attachment images on three pages.
const FIXTURE = [
  { filename: "a.png", pageId: "10", bytes: bigPng(IMAGE_BYTES, 1) },
  { filename: "b.png", pageId: "20", bytes: bigPng(IMAGE_BYTES, 2) },
  { filename: "c.png", pageId: "30", bytes: bigPng(IMAGE_BYTES, 3) },
];

const IMAGE_BLOCKS: ExportBlock[] = FIXTURE.map((f) => ({
  type: "image",
  source: { kind: "attachment", filename: f.filename, pageId: f.pageId },
  alt: f.filename,
}));

const bytesFor = (filename: string | undefined): Uint8Array => {
  const found = FIXTURE.find((f) => f.filename === filename);
  if (!found) throw new Error(`no fixture bytes for ${filename}`);
  return found.bytes;
};

/** Normalize offenders for comparison (drop object identity). */
const shape = (offenders: readonly AssetBudgetOffender[]): Array<[string, string | undefined, number]> =>
  offenders.map((o) => [o.filename, o.pageId, o.sizeBytes]);

describe("asset-budget parity (spec 002)", () => {
  it("both engines throw AssetBudgetExceededError with the identical offender list", async () => {
    // ---- DOCX via runExport ----
    const templateBytes = buildDocx({ body: para("$scroll.content") });
    let docxError: unknown;
    try {
      await runExport(
        {
          details: { id: "10", title: "Root", storage: "", spaceKey: "DOC" },
          template: { name: "t.docx", modificationDate: new Date(0) },
          blocks: IMAGE_BLOCKS,
        },
        {
          templates: { getBytes: async () => templateBytes },
          assets: { fetch: async (ref) => bytesFor(ref.filename) },
          output: { emit: async () => {} },
        }
      );
    } catch (error) {
      docxError = error;
    }

    // ---- PDF via runPdfExport ----
    const resolver: PdfAssetResolver = {
      resolve: async (ref) => ({ bytes: bytesFor(ref.filename), mediaType: "image/png" }),
    };
    let pdfError: unknown;
    try {
      await runPdfExport(
        {
          blocks: IMAGE_BLOCKS,
          metadata: { title: "Root", exportedAt: new Date(0) },
          filename: "root.pdf",
        },
        {
          assets: resolver,
          // Never reached — prepare fails on the budget first.
          compiler: { compile: async () => { throw new Error("compiler should not run"); } },
          output: { emit: async () => {} },
        }
      );
    } catch (error) {
      pdfError = error;
    }

    // Same error type from both entry points.
    expect(docxError).toBeInstanceOf(AssetBudgetExceededError);
    expect(pdfError).toBeInstanceOf(AssetBudgetExceededError);
    const docx = docxError as AssetBudgetExceededError;
    const pdf = pdfError as AssetBudgetExceededError;

    // Same abort accounting.
    expect(docx.limitBytes).toBe(pdf.limitBytes);
    expect(docx.totalBytes).toBe(pdf.totalBytes);
    expect(docx.totalBytes).toBe(3 * IMAGE_BYTES);

    // Same offender list content (largest-first; equal sizes → filename asc).
    expect(shape(docx.offenders)).toEqual(shape(pdf.offenders));
    expect(shape(docx.offenders)).toEqual([
      ["a.png", "10", IMAGE_BYTES],
      ["b.png", "20", IMAGE_BYTES],
      ["c.png", "30", IMAGE_BYTES],
    ]);
  });

  it("DOCX diagram bytes count against the SAME shared budget (fatal on breach)", async () => {
    // Diagram-heavy fixture: three distinct mermaid diagrams whose rasterized
    // PNG fallbacks (3 × 18 MiB) breach the shared 50 MiB total. The breach is
    // the same fatal AssetBudgetExceededError with the same cap as the image
    // parity above — never a per-diagram "rendered as source" warning.
    //
    // Byte-identical CROSS-engine parity does not apply to diagrams by
    // construction: the PDF engine embeds only the rendered SVG (already
    // budgeted through the shared addAsset/AssetBudget path in prepare.ts),
    // while DOCX embeds the SVG plus its mandatory rasterized PNG fallback —
    // different artifacts, same contract (same AssetBudget, same cap, same
    // fatal semantics).
    const diagrams: ExportBlock[] = [1, 2, 3].map((i) => ({
      type: "codeBlock",
      language: "mermaid",
      code: `graph TD\n  A${i}-->B${i}`,
    }));
    let raster = 0;
    let docxError: unknown;
    try {
      await runExport(
        {
          details: { id: "10", title: "Root", storage: "", spaceKey: "DOC" },
          template: { name: "t.docx", modificationDate: new Date(0) },
          blocks: diagrams,
        },
        {
          templates: { getBytes: async () => buildDocx({ body: para("$scroll.content") }) },
          rasterizer: { rasterize: async () => bigPng(IMAGE_BYTES, ++raster) },
          output: { emit: async () => {} },
        }
      );
    } catch (error) {
      docxError = error;
    }
    expect(docxError).toBeInstanceOf(AssetBudgetExceededError);
    const breach = docxError as AssetBudgetExceededError;
    expect(breach.limitBytes).toBe(50 * MIB);
    // The rasterized PNG fallbacks are what breached; they are in the list.
    expect(breach.offenders.filter((o) => o.filename === "diagram.png").length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
