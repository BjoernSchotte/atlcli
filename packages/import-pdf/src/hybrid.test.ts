import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { documentToAdf, documentToStorage, type ImportBlock } from "@atlcli/import-core";
import {
  PDF_GEOMETRY_POLICY_REVISION_V2,
  PDF_HYBRID_POLICY_REVISION_V2,
} from "./contracts.js";
import { digestPdfFactsV2 } from "./canonical.js";
import { auditPdfCharacterOwnershipV2, normalizeHybridPdfFactsV2 } from "./hybrid.js";
import { createNodePdfiumFactsAdapterV2 } from "./node.js";
import { buildPdfImportReviewV2, pdfImportReviewReport } from "./review.js";
import { parsePdfSplitPolicy } from "./split.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");

function textOf(block: ImportBlock): string {
  if (block.type !== "heading" && block.type !== "paragraph") return block.type;
  return block.runs.map((run) => run.kind === "text" ? run.text : "\n").join("");
}

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(fixtureRoot, name)));
}

async function review(
  name: string,
  options: {
    readingOrder?: "auto" | "tags" | "geometry";
    scanPolicy?: "fail" | "page-image" | "report";
  } = {},
) {
  return buildPdfImportReviewV2(
    await fixture(name),
    await createNodePdfiumFactsAdapterV2(),
    {
      target: {
        spaceKey: "DOCSY",
        title: "Neutral Hybrid Review",
        deployment: "cloud",
        supportsPageTree: true,
        evidence: "profile",
      },
      splitPolicy: parsePdfSplitPolicy("off"),
      ...options,
    },
  );
}

describe("PDF hybrid semantic reconciliation", () => {
  it("repairs localized untagged residue once and exposes body-free ownership metrics", async () => {
    const first = await review("independent-fragmented-tagged.pdf");
    const repeated = await review("independent-fragmented-tagged.pdf");

    expect(first.document.blocks.map((block) => [block.type, textOf(block)])).toEqual([
      ["heading", "Neutral Harbor Evidence"],
      ["paragraph", "Harbor signals remain clear."],
      ["paragraph", "Seasonal coordination stays stable."],
      ["paragraph", "مرحبا بالميناء"],
      ["paragraph", "港の信号"],
      ["paragraph", "office"],
      ["paragraph", "German Umlaute: Äpfel, Öl, Ufer."],
      ["paragraph", "Localized unmarked repair note."],
    ]);
    expect(first.pages).toEqual([expect.objectContaining({
      fallback: "none",
      fallbackScope: "none",
      visibleCharacterCount: 158,
      uniquelyOwnedCharacterCount: 158,
      explicitBoundaryCount: 14,
      inferredBoundaryCount: 12,
      unresolvedBoundaryCount: 0,
      geometryRepairedCharacterCount: 28,
      geometryRepairRegionCount: 1,
      duplicateOwnershipAttemptCount: 0,
      residualReportedCharacterCount: 0,
      normalizedFallbackArea: 0,
    })]);
    expect(first.evidence.filter((entry) => entry.decisionCode === "pdf/hybrid-geometry-repair"))
      .toHaveLength(1);
    expect(first.document.issues.map((issue) => issue.code)).not.toContain(
      "pdf-import/tagged-text-unclaimed",
    );
    expect(new Set(first.ownership.map((entry) => `${entry.pageIndex}:${entry.characterIndex}`)).size)
      .toBe(first.ownership.length);
    expect(first.ownership.filter((entry) => entry.basis === "geometry")).toHaveLength(28);
    expect(documentToAdf(first.document).content).toHaveLength(8);
    expect(documentToStorage(first.document)).toContain("Localized unmarked repair note.");
    expect(first.semanticDigest).toBe(repeated.semanticDigest);
    expect(first.issueDigest).toBe(repeated.issueDigest);
    expect(first.planDigest).toBe(repeated.planDigest);
    expect(first.split.digest).toBe(repeated.split.digest);
    expect(first.split.sourceAssignments).toEqual([{ pageIndex: 0, plannedPageId: "pdf-page-root" }]);

    const report = pdfImportReviewReport(first) as {
      quality: { visibleCharacterCount: number; uniquelyOwnedCharacterCount: number };
    };
    expect(report.quality).toMatchObject({
      visibleCharacterCount: 158,
      uniquelyOwnedCharacterCount: 158,
    });
    expect(JSON.stringify(report.quality)).not.toContain("Localized unmarked repair note.");
  });

  it("keeps explicit tags and geometry routing distinct from automatic hybrid repair", async () => {
    const tagged = await review("independent-fragmented-tagged.pdf", {
      readingOrder: "tags",
      scanPolicy: "report",
    });
    expect(tagged.pages[0]).toMatchObject({
      fallback: "reported",
      fallbackScope: "page",
      fallbackReasons: ["unclaimed-visible-text"],
      geometryRepairedCharacterCount: 0,
      residualReportedCharacterCount: 28,
    });
    expect(tagged.evidence.some((entry) => entry.analyzerRevision === PDF_HYBRID_POLICY_REVISION_V2))
      .toBe(false);

    const geometry = await review("independent-fragmented-tagged.pdf", {
      readingOrder: "geometry",
      scanPolicy: "report",
    });
    expect(geometry.evidence.some((entry) => entry.analyzerRevision === PDF_HYBRID_POLICY_REVISION_V2))
      .toBe(false);
    expect(geometry.evidence.some((entry) => entry.analyzerRevision === PDF_GEOMETRY_POLICY_REVISION_V2))
      .toBe(true);
  });

  it("detects conflicting ownership attempts while retaining one deterministic final owner", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const analyzed = await adapter.analyze(await fixture("independent-fragmented-tagged.pdf"));
    const normalized = await normalizeHybridPdfFactsV2(analyzed.facts, analyzed.factsDigest);
    const claimed = normalized.evidence.find((entry) =>
      entry.targetNodeId && (entry.locator.characterIndexes?.length ?? 0) > 0
    )!;
    const audit = auditPdfCharacterOwnershipV2(analyzed.facts, [
      ...normalized.evidence,
      { ...claimed, sourceId: `${claimed.sourceId}:conflict`, targetNodeId: `${claimed.targetNodeId}:conflict` },
    ]);

    expect(audit.duplicateOwnershipAttemptCount).toBe(claimed.locator.characterIndexes!.filter((index) =>
      analyzed.facts.pages[0]!.characters[index]!.value.replace(/[\s\u00ad]/gu, "").length > 0
    ).length);
    expect(audit.duplicateOwnershipAttemptsByPage).toEqual([{
      pageIndex: 0,
      count: audit.duplicateOwnershipAttemptCount,
    }]);
    expect(audit.ownership).toHaveLength(normalized.ownership.length);
  });

  it("keeps distant residual regions separate instead of forming one oversized crop", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const analyzed = await adapter.analyze(await fixture("independent-fragmented-tagged.pdf"));
    const facts = structuredClone(analyzed.facts);
    const residual = facts.pages[0]!.characters.filter((character) =>
      character.mcid === null && character.bbox !== null
    );
    const split = Math.ceil(residual.length / 2);
    for (const character of residual.slice(split)) {
      if (character.bbox) character.bbox = { ...character.bbox, y: 0.98 };
    }

    const normalized = await normalizeHybridPdfFactsV2(facts, await digestPdfFactsV2(facts));
    const repairs = normalized.evidence.filter((entry) =>
      entry.decisionCode === "pdf/hybrid-geometry-repair"
    );
    expect(normalized.pageOutcomes[0]).toMatchObject({
      mode: "hybrid-repaired",
      geometryRepairRegionCount: 2,
      fallbackScope: "none",
      duplicateOwnershipAttemptCount: 0,
    });
    expect(repairs).toHaveLength(2);
    expect(repairs[0]!.locator.bbox!.y).not.toBeCloseTo(repairs[1]!.locator.bbox!.y);
  });

  it("retains page fallback for dispersed residue and closes it only when attached", async () => {
    const reported = await review("independent-negative-tagged.pdf", { scanPolicy: "report" });
    expect(reported.pages[0]).toMatchObject({
      fallback: "reported",
      fallbackScope: "page",
      fallbackReasons: ["dispersed-residual-regions"],
      visibleCharacterCount: 160,
      uniquelyOwnedCharacterCount: 160,
      geometryRepairedCharacterCount: 0,
      geometryRepairRegionCount: 0,
      duplicateOwnershipAttemptCount: 0,
      residualReportedCharacterCount: 91,
      normalizedFallbackArea: 1,
    });
    expect(reported.ownership.filter((entry) => entry.outcome === "reported")).toHaveLength(91);
    expect(reported.evidence).toContainEqual(expect.objectContaining({
      decisionCode: "pdf/hybrid-page-fallback-required",
      outcome: "reported",
    }));

    const attached = await review("independent-negative-tagged.pdf", { scanPolicy: "page-image" });
    expect(attached.pages[0]).toMatchObject({
      fallback: "page-image",
      fallbackScope: "page",
      residualReportedCharacterCount: 0,
      normalizedFallbackArea: 1,
    });
    expect(attached.ownership.every((entry) => entry.basis === "fallback" && entry.outcome === "attached"))
      .toBe(true);
    expect(attached.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/hybrid-page-fallback-required",
      outcome: "attached",
    }));
    expect(attached.evidence).toContainEqual(expect.objectContaining({
      decisionCode: "pdf/page-image-fallback-attached",
      outcome: "attached",
    }));
  });
});
