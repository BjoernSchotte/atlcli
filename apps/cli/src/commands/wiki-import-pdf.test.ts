import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleWikiImport } from "./wiki-import.js";
import { buildDocxFixture, p, r } from "../../../../packages/import-docx/src/test-support.js";

const fixtureRoot = resolve(import.meta.dir, "../../../../specs/import-pdf-mvp/fixtures");

describe("wiki import PDF review-first planning", () => {
  let directory: string;
  let stdout: string[];
  let writeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "wiki-import-pdf-test-"));
    stdout = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });

  async function expectFailure(
    args: string[],
    flags: Record<string, string | boolean | string[]>,
    message: string,
  ): Promise<void> {
    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never);
    try {
      await handleWikiImport(args, flags, { json: true }).catch(() => {});
      expect(exitCode).toBe(1);
      expect(stdout.join("")).toContain(message);
    } finally {
      exitSpy.mockRestore();
    }
  }

  it("previews a short PDF offline with deterministic standard JSON and no body bytes", async () => {
    const file = resolve(fixtureRoot, "simple-untagged.pdf");
    await handleWikiImport([file], { space: "DOCSY", json: true }, { json: true });
    const first = JSON.parse(stdout.join(""));
    stdout.length = 0;
    await handleWikiImport([file], { space: "DOCSY", json: true }, { json: true });
    const second = JSON.parse(stdout.join(""));
    expect(first.mode).toBe("pdf-preview");
    expect(first.schema).toBe("atlcli.pdf-import-review/2");
    expect(first.source).toMatchObject({ pageCount: 1, classification: "digital-untagged" });
    expect(first.target).toMatchObject({ spaceKey: "DOCSY", title: "simple-untagged", deployment: "unresolved-offline" });
    expect(first.split.resolved.kind).toBe("single-page");
    expect(first.split.totalWikiPages).toBe(1);
    expect(first.digests).toEqual(second.digests);
    expect(first.quality).toMatchObject({ unresolvedBoundaryCount: 0 });
    expect(first.quality.boundaryDecisionCount).toBeGreaterThan(0);
    expect(first.pages[0].boundaryDecisionCount).toBe(first.quality.boundaryDecisionCount);
    expect(first.document).toBeUndefined();
    expect(first.facts).toBeUndefined();
    expect(first.split.root.blocks).toBeUndefined();
    expect(first.content.outline[0]).toEqual({ level: 1, text: "Quarterly Garden Notes" });
  });

  it("defaults a 100-page PDF to a bounded index tree with every page assigned once", async () => {
    await handleWikiImport(
      [resolve(fixtureRoot, "heading-rich-100.pdf")],
      { format: "pdf", space: "DOCSY", json: true },
      { json: true },
    );
    const result = JSON.parse(stdout.join(""));
    expect(result.split.resolved.kind).toBe("page-tree");
    expect(result.split.totalWikiPages).toBe(9);
    expect(result.split.root.splitBasis).toBe("root-index");
    expect(result.split.sourceAssignments).toHaveLength(100);
    expect(result.split.sourceAssignments.map((item: { pageIndex: number }) => item.pageIndex)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    const collect = (page: { sourcePageIndexes: number[]; children: typeof page[] }): number[] => [
      page.sourcePageIndexes.length,
      ...page.children.flatMap(collect),
    ];
    expect(Math.max(...collect(result.split.root))).toBeLessThanOrEqual(20);
  });

  it("renders a terminal page-tree and attachment disclosure without printing body text", async () => {
    await handleWikiImport(
      [resolve(fixtureRoot, "heading-poor-100.pdf")],
      { space: "DOCSY", "attach-source": true },
      { json: false },
    );
    const text = stdout.join("");
    expect(text).toContain("PDF import preview");
    expect(text).toContain("6 wiki page(s)");
    expect(text).toContain("Original PDF attachment: opted in");
    expect(text).toContain("Dry preview only");
  });

  it("reports scan blockers by default and materializes an explicit page-image fallback", async () => {
    const file = resolve(fixtureRoot, "scan.pdf");
    await handleWikiImport([file], { space: "DOCSY", json: true }, { json: true });
    const blocked = JSON.parse(stdout.join(""));
    expect(blocked.pages[0].fallback).toBe("required");
    expect(blocked.blockers.join(" ")).toContain("scan-policy fail");
    stdout.length = 0;
    await handleWikiImport(
      [file],
      { space: "DOCSY", "scan-policy": "page-image", json: true },
      { json: true },
    );
    const image = JSON.parse(stdout.join(""));
    expect(image.pages[0].fallback).toBe("page-image");
    expect(image.options).toMatchObject({ visualFallback: "inline", visualFallbackPlacement: "inline" });
    expect(image.assets).toHaveLength(1);
    expect(image.assets[0]).toMatchObject({ mediaType: "image/png" });
  });

  it("offers explicit auto, inline, collapsed, and appendix visual fallback placement", async () => {
    const file = resolve(fixtureRoot, "scan.pdf");
    for (const [mode, placement, disclosure, heading] of [
      ["auto", "collapsed", 1, false],
      ["inline", "inline", 0, false],
      ["collapsed", "collapsed", 1, false],
      ["appendix", "appendix", 1, true],
    ] as const) {
      stdout.length = 0;
      await handleWikiImport(
        [file],
        { space: "DOCSY", "visual-fallback": mode, json: true },
        { json: true },
      );
      const result = JSON.parse(stdout.join(""));
      expect(result.options).toMatchObject({
        scanPolicy: "page-image",
        visualFallback: mode,
        visualFallbackPlacement: placement,
      });
      expect(result.content.blockCounts.disclosure ?? 0).toBe(disclosure);
      expect(result.content.outline.some((item: { text: string }) => item.text === "Original visual views")).toBe(heading);
      expect(result.blockers).toEqual([]);
    }
  });

  it("rejects format mismatch, cross-format flags, unsafe split values, and confirm+dry-run before writes", async () => {
    const fakePdf = join(directory, "wrong.pdf");
    writeFileSync(fakePdf, buildDocxFixture({ body: p(r("Doc")) }));
    await expectFailure([fakePdf], { space: "DOCSY", json: true }, "Format mismatch");
    stdout.length = 0;
    await expectFailure(
      [resolve(fixtureRoot, "simple-untagged.pdf")],
      { space: "DOCSY", revisions: "accept", json: true },
      "DOCX-only",
    );
    stdout.length = 0;
    const docx = join(directory, "document.docx");
    writeFileSync(docx, buildDocxFixture({ body: p(r("Doc")) }));
    await expectFailure([docx], { space: "DOCSY", "scan-policy": "fail", json: true }, "PDF-only");
    stdout.length = 0;
    await expectFailure(
      [resolve(fixtureRoot, "simple-untagged.pdf")],
      { space: "DOCSY", split: "pages:4", json: true },
      "pages:<5..40>",
    );
    stdout.length = 0;
    await expectFailure(
      [resolve(fixtureRoot, "simple-untagged.pdf")],
      { space: "DOCSY", "max-wiki-pages": true, json: true },
      "--max-wiki-pages requires a value",
    );
    stdout.length = 0;
    await expectFailure(
      [resolve(fixtureRoot, "simple-untagged.pdf")],
      { space: "DOCSY", confirm: true, "dry-run": true, json: true },
      "mutually exclusive",
    );
    stdout.length = 0;
    await expectFailure(
      [resolve(fixtureRoot, "scan.pdf")],
      { space: "DOCSY", "visual-fallback": "auto", "scan-policy": "report", json: true },
      "requires --scan-policy page-image",
    );
  });
});
