import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticDigest } from "./canonical.ts";
import { analyzeWithPdfium } from "./pdfium.ts";
import type { PdfFacts, StructureNode } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../fixtures");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(FIXTURES, name)));
}

async function isolatedPdfjsFixture(name: string): Promise<PdfFacts> {
  const child = Bun.spawn([
    process.execPath,
    "--conditions=development",
    resolve(HERE, "pdfjs-child.ts"),
    resolve(FIXTURES, name),
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Isolated PDF.js probe failed with exit ${exitCode}: ${stderr.trim()}`);
  }
  return JSON.parse(stdout) as PdfFacts;
}

function flatten(nodes: StructureNode[]): StructureNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

describe("PDF-00 PDFium facts contract", () => {
  test("extracts complete simple text, geometry, link, and deterministic semantics", async () => {
    const bytes = await fixture("simple-untagged.pdf");
    const first = await analyzeWithPdfium(bytes);
    const second = await analyzeWithPdfium(bytes);
    expect(first.classification).toBe("digital-untagged");
    expect(first.pages[0]?.text).toContain("Quarterly Garden Notes");
    expect(first.pages[0]?.text).toContain("twelve neutral test trees");
    expect(first.pages[0]?.characters.every((character) => character.box !== null || character.value.trim() === "")).toBe(true);
    expect(first.pages[0]?.annotations).toHaveLength(1);
    expect(first.pages[0]?.annotations[0]?.uri).toBe("https://example.com/garden-notes");
    expect(semanticDigest(first)).toBe(semanticDigest(second));
  });

  test("correlates tagged roles, MCIDs, table spans, figure alt, image, outline, and URI", async () => {
    const facts = await analyzeWithPdfium(await fixture("complex-tagged.pdf"));
    const nodes = flatten(facts.pages[0]?.structures ?? []);
    const cells = nodes.filter((node) => node.type === "TH" || node.type === "TD");
    expect(facts.tagged).toBe(true);
    expect(new Set(facts.pages[0]?.characters.map((character) => character.mcid).filter((mcid) => mcid >= 0))).toEqual(new Set([0, 1, 2, 3, 4, 5, 7]));
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.attributes.some((attribute) => attribute.name === "RowSpan" && attribute.value === 1))).toBe(true);
    expect(cells.every((cell) => cell.attributes.some((attribute) => attribute.name === "ColSpan" && attribute.value === 1))).toBe(true);
    expect(nodes.find((node) => node.type === "Figure")?.alt).toBe("Green square sample tile");
    expect(facts.pages[0]?.images).toHaveLength(1);
    expect(facts.pages[0]?.images[0]?.mcid).toBe(6);
    expect(facts.outlines).toEqual([{ title: "Structured Garden Report", pageIndex: 0 }]);
    expect(facts.pages[0]?.annotations[0]?.uri).toBe("https://example.com/structured-garden");
  });

  test("classifies scan and mixed pages without pretending OCR", async () => {
    const scan = await analyzeWithPdfium(await fixture("scan.pdf"));
    const mixed = await analyzeWithPdfium(await fixture("mixed.pdf"));
    expect(scan.classification).toBe("scan");
    expect(scan.pages[0]?.text).toBe("");
    expect(scan.pages[0]?.images).toHaveLength(1);
    expect(mixed.classification).toBe("mixed");
    expect(mixed.pages.map((page) => page.kind)).toEqual(["digital", "image-only"]);
  });

  test("reports but does not execute actions or extract attachments", async () => {
    const facts = await analyzeWithPdfium(await fixture("adversarial-actions.pdf"));
    expect(facts.javascriptActionCount).toBe(1);
    expect(facts.attachmentCount).toBe(1);
    expect(facts.pages[0]?.text).not.toContain("neutral fixture action");
    expect(facts.pages[0]?.text).not.toContain("Embedded neutral fixture");
  });

  test("rejects an encrypted PDF without a password", async () => {
    const facts = await analyzeWithPdfium(await fixture("encrypted.pdf"));
    expect(facts.classification).toBe("encrypted");
    expect(facts.loadError).toBe(4);
    expect(facts.pages).toHaveLength(0);
  });

  test("releases every acquired lifecycle stage after injected failures", async () => {
    const bytes = await fixture("complex-tagged.pdf");
    for (const failAt of [
      "after-init",
      "after-input",
      "after-load",
      "after-page-load",
      "after-text-page",
      "after-structure-tree",
      "after-annotation",
      "after-bitmap",
      "before-finalize",
    ] as const) {
      await expect(analyzeWithPdfium(bytes, "", { failAt })).rejects.toThrow(`injected PDFium failure at ${failAt}`);
      const recovery = await analyzeWithPdfium(bytes);
      expect(recovery.pageCount).toBe(1);
      expect(recovery.memory?.wasmPeakBytes).toBe(recovery.memory?.wasmInitialBytes);
      expect(recovery.memory?.wasmFinalBytes).toBe(recovery.memory?.wasmInitialBytes);
    }
    const controller = new AbortController();
    controller.abort(new Error("neutral cancellation"));
    await expect(analyzeWithPdfium(bytes, "", { signal: controller.signal })).rejects.toThrow("neutral cancellation");
  });

  test("accounts for every source page in both 100-page controls", async () => {
    for (const name of ["heading-rich-100.pdf", "heading-poor-100.pdf"]) {
      const facts = await analyzeWithPdfium(await fixture(name));
      expect(facts.pageCount).toBe(100);
      expect(facts.pages).toHaveLength(100);
      expect(facts.pages.map((page) => page.index)).toEqual(Array.from({ length: 100 }, (_, index) => index));
      for (let page = 1; page <= 100; page += 1) {
        expect(facts.pages[page - 1]?.text).toContain(`PAGE-${String(page).padStart(3, "0")}`);
      }
    }
  }, 30_000);
});

describe("PDF-00 viewer-only PDF.js baseline", () => {
  test("matches core tagged tokens, roles, image, annotation, and outline", async () => {
    const facts = await isolatedPdfjsFixture("complex-tagged.pdf");
    const roles = flatten(facts.pages[0]?.structures ?? []).map((node) => node.type);
    expect(facts.pages[0]?.text).toContain("Structured Garden Report");
    expect(roles).toEqual(expect.arrayContaining(["H1", "Table", "TH", "TD", "Figure", "Caption"]));
    expect(facts.pages[0]?.images).toHaveLength(1);
    expect(facts.pages[0]?.annotations).toHaveLength(1);
    expect(facts.outlines).toEqual([{ title: "Structured Garden Report", pageIndex: 0 }]);
  });
});
