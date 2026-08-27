#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportBlock, ImportRun } from "@atlcli/import-core";
import {
  buildPdfImportReviewV2,
  parsePdfSplitPolicy,
  type PdfDecisionEvidenceV2,
  type PdfImportReviewV2,
} from "../../packages/import-pdf/src/index.js";
import { createNodePdfiumFactsAdapterV2 } from "../../packages/import-pdf/src/node.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_ROOT = resolve(ROOT, "specs/pdf-import-quality/fixtures");
const MANIFEST_PATH = resolve(FIXTURE_ROOT, "manifest.json");

type ExpectedBlockType = "heading" | "paragraph" | "list-paragraph" | "table-row" | "table-cell" | "reported";

export interface PdfQualityExpectedBlock {
  id: string;
  pageIndex: number;
  type: ExpectedBlockType;
  depth?: number;
  text: string;
}

export interface PdfQualityExpectedBoundary {
  id: string;
  pageIndex: number;
  leftCharacterIndex: number;
  rightCharacterIndex: number;
  action: "insert-space" | "join-line" | "dehyphenate" | "retain-hyphen" | "no-space";
  basis: string[];
}

export interface PdfQualityExpectedSpan {
  pageIndex: number;
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
  rowspan: number;
  colspan: number;
}

export interface PdfQualityManifestEntry {
  id: string;
  path: string;
  class: "tagged" | "digital-untagged";
  criticalNegative: boolean;
  qualityFamilies: string[];
  producer: { family: string };
  pages: number;
  expected: {
    orderedBlocks: PdfQualityExpectedBlock[];
    boundaries: PdfQualityExpectedBoundary[];
    ownership: {
      localizedRepairRegions: number;
      unlocalizablePages: number[];
      fallbackPages: number[];
      duplicateCharacterOwners: number;
    };
    safeLinks: string[];
    requiredIssueCodes?: string[];
    tableSpans?: PdfQualityExpectedSpan[];
  };
}

export interface PdfQualityManifest {
  schema: string;
  fixtures: PdfQualityManifestEntry[];
}

type ObservedBlockType = Exclude<ExpectedBlockType, "reported" | "table-cell">;

export interface PdfQualityObservedBlock {
  pageIndex: number;
  type: ObservedBlockType;
  depth: number;
  text: string;
}

export interface PdfQualityObservation {
  fixtureId: string;
  blocks: PdfQualityObservedBlock[];
  spans: PdfQualityExpectedSpan[];
  links: string[];
  issueCodes: string[];
  review: PdfImportReviewV2;
}

interface MatchCounts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
}

export interface PdfQualityFixtureResult {
  fixtureId: string;
  producerFamily: string;
  class: PdfQualityManifestEntry["class"];
  criticalNegative: boolean;
  accountedPageRate: number;
  unreportedVisibleCharacterLoss: number;
  duplicateCharacterOwnership: number;
  falseNativeCount: number;
  exactFragmentedTextRate: number | null;
  wordBoundaryPrecision: number;
  wordBoundaryRecall: number;
  exactOrderedBlockPairRate: number;
  taggedListF1: number | null;
  taggedTableCellTextF1: number | null;
  explicitSpanF1: number | null;
  expectedBoundaryExact: boolean;
  fallbackExact: boolean;
  requiredIssuesExact: boolean;
  unresolvedBoundaryInNativeBlockCount: number;
  unsafeLinkPromotedCount: number;
  failureCodes: string[];
  passed: boolean;
  counts: {
    pages: number;
    expectedBlocks: number;
    observedBlocks: number;
    expectedBoundaries: number;
    observedBoundaries: number;
  };
}

export interface PdfQualityResult {
  schema: "atlcli.import-pdf-quality/1";
  passed: boolean;
  fixtures: PdfQualityFixtureResult[];
  aggregate: {
    accountedPageRate: number;
    unreportedVisibleCharacterLoss: number;
    duplicateCharacterOwnership: number;
    falseNativeCount: number;
    exactFragmentedTextRate: number;
    wordBoundaryPrecision: number;
    wordBoundaryRecall: number;
    exactOrderedBlockPairRate: number;
    taggedListF1: number;
    taggedTableCellTextF1: number;
    explicitSpanF1: number;
    unresolvedBoundaryInNativeBlockCount: number;
    unsafeLinkPromotedCount: number;
  };
}

function textOfRuns(runs: readonly ImportRun[]): string {
  return runs.map((run) => run.kind === "text" ? run.text : "\n").join("").normalize("NFC");
}

function textOfBlock(block: ImportBlock): string {
  return block.type === "heading" || block.type === "paragraph" ? textOfRuns(block.runs) : "";
}

function pageFor(
  refs: readonly string[],
  evidence: readonly PdfDecisionEvidenceV2[],
  fallbackPageIndex: number,
): number {
  const match = evidence.find((entry) =>
    refs.includes(entry.sourceId)
    || Boolean(entry.targetNodeId && refs.includes(entry.targetNodeId))
  );
  return match?.locator.pageIndex ?? fallbackPageIndex;
}

function flattenBlocks(
  blocks: readonly ImportBlock[],
  evidence: readonly PdfDecisionEvidenceV2[],
  depth = 0,
  fallbackPageIndex = 0,
  state: { tableIndexes: Map<number, number> } = { tableIndexes: new Map() },
): { blocks: PdfQualityObservedBlock[]; spans: PdfQualityExpectedSpan[] } {
  const observed: PdfQualityObservedBlock[] = [];
  const spans: PdfQualityExpectedSpan[] = [];
  for (const block of blocks) {
    const refs = [block.id, ...(block.sourceRefs ?? [])];
    const pageIndex = pageFor(refs, evidence, fallbackPageIndex);
    if (block.type === "heading" || block.type === "paragraph") {
      observed.push({ pageIndex, type: block.type, depth, text: textOfBlock(block) });
      continue;
    }
    if (block.type === "list") {
      for (const item of block.items) {
        const itemBlocks = flattenBlocks(item.blocks, evidence, depth, pageIndex, state);
        observed.push(...itemBlocks.blocks.map((entry) => ({ ...entry, type: "list-paragraph" as const })));
        spans.push(...itemBlocks.spans);
        if (item.child) {
          const child = flattenBlocks([item.child], evidence, depth + 1, pageIndex, state);
          observed.push(...child.blocks);
          spans.push(...child.spans);
        }
      }
      continue;
    }
    if (block.type === "table") {
      const tableIndex = state.tableIndexes.get(pageIndex) ?? 0;
      state.tableIndexes.set(pageIndex, tableIndex + 1);
      for (const [rowIndex, row] of block.rows.entries()) {
        const cells = row.cells.map((cell) => cell.blocks.map(textOfBlock).join("\n"));
        observed.push({
          pageIndex,
          type: "table-row",
          depth,
          text: cells.join(" | ").normalize("NFC"),
        });
        for (const [columnIndex, cell] of row.cells.entries()) {
          const rowspan = cell.rowspan ?? 1;
          const colspan = cell.colspan ?? 1;
          if (rowspan > 1 || colspan > 1) {
            spans.push({ pageIndex, tableIndex, rowIndex, columnIndex, rowspan, colspan });
          }
        }
      }
    }
  }
  return { blocks: observed, spans };
}

function linksInBlock(block: ImportBlock): string[] {
  if (block.type === "heading" || block.type === "paragraph") {
    return block.runs.flatMap((run) => run.kind === "text" && run.marks?.link?.href
      ? [run.marks.link.href]
      : []);
  }
  if (block.type === "list") {
    return block.items.flatMap((item) => [
      ...item.blocks.flatMap(linksInBlock),
      ...(item.child ? linksInBlock(item.child) : []),
    ]);
  }
  if (block.type === "table") {
    return block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.flatMap(linksInBlock)));
  }
  return [];
}

export async function readPdfQualityManifest(): Promise<PdfQualityManifest> {
  const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as PdfQualityManifest;
  if (parsed.schema !== "atlcli.import-pdf.quality-fixture/v1" || !Array.isArray(parsed.fixtures)) {
    throw new Error("PDF quality manifest has an unsupported schema.");
  }
  return parsed;
}

export async function collectPdfQualityObservations(
  manifest: PdfQualityManifest,
): Promise<PdfQualityObservation[]> {
  const adapter = await createNodePdfiumFactsAdapterV2();
  const observations: PdfQualityObservation[] = [];
  for (const fixture of manifest.fixtures) {
    const sourceBytes = new Uint8Array(await readFile(resolve(FIXTURE_ROOT, fixture.path)));
    const review = await buildPdfImportReviewV2(sourceBytes, adapter, {
      target: {
        spaceKey: "DOCSY",
        title: `Neutral quality ${fixture.id}`,
        deployment: "cloud",
        supportsPageTree: true,
        evidence: "profile",
      },
      splitPolicy: parsePdfSplitPolicy("off"),
      scanPolicy: "report",
      unsupported: "report",
    });
    const flattened = flattenBlocks(review.document.blocks, review.evidence);
    observations.push({
      fixtureId: fixture.id,
      blocks: flattened.blocks,
      spans: flattened.spans,
      links: review.document.blocks.flatMap(linksInBlock),
      issueCodes: review.document.issues.map((issue) => issue.code),
      review,
    });
  }
  return observations;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function multisetMatches(expected: readonly string[], actual: readonly string[]): MatchCounts {
  const available = new Map<string, number>();
  for (const key of actual) available.set(key, (available.get(key) ?? 0) + 1);
  let truePositive = 0;
  for (const key of expected) {
    const remaining = available.get(key) ?? 0;
    if (remaining > 0) {
      truePositive += 1;
      available.set(key, remaining - 1);
    }
  }
  return {
    truePositive,
    falsePositive: actual.length - truePositive,
    falseNegative: expected.length - truePositive,
  };
}

function f1(counts: MatchCounts): number {
  const precision = ratio(counts.truePositive, counts.truePositive + counts.falsePositive);
  const recall = ratio(counts.truePositive, counts.truePositive + counts.falseNegative);
  return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
}

function canonicalCharacters(value: string): string[] {
  return [...value.normalize("NFC")].filter((character) => !/[\s\u00ad]/u.test(character));
}

function whitespaceBoundaryPositions(value: string): Set<number> {
  const characters = [...value.normalize("NFC")];
  const positions = new Set<number>();
  let visible = 0;
  let whitespaceAfterVisible = false;
  for (const character of characters) {
    if (/[\s\u00ad]/u.test(character)) {
      if (visible > 0) whitespaceAfterVisible = true;
      continue;
    }
    if (whitespaceAfterVisible) positions.add(visible);
    visible += 1;
    whitespaceAfterVisible = false;
  }
  return positions;
}

function wordBoundaryMatches(expected: string, actual: string): MatchCounts {
  const expectedPositions = whitespaceBoundaryPositions(expected);
  const actualPositions = whitespaceBoundaryPositions(actual);
  if (canonicalCharacters(expected).join("") !== canonicalCharacters(actual).join("")) {
    return {
      truePositive: 0,
      falsePositive: Math.max(1, actualPositions.size),
      falseNegative: Math.max(1, expectedPositions.size),
    };
  }
  const truePositive = [...expectedPositions].filter((position) => actualPositions.has(position)).length;
  return {
    truePositive,
    falsePositive: actualPositions.size - truePositive,
    falseNegative: expectedPositions.size - truePositive,
  };
}

function expectedBoundaryExact(
  expected: readonly PdfQualityExpectedBoundary[],
  review: PdfImportReviewV2,
): boolean {
  return expected.every((truth) => review.boundaries.some((actual) =>
    review.evidence.some((entry) =>
      entry.locator.pageIndex === truth.pageIndex && entry.boundaryDecisionIds.includes(actual.id)
    )
    && actual.leftCharacterIndex === truth.leftCharacterIndex
    && actual.rightCharacterIndex === truth.rightCharacterIndex
    && actual.action === truth.action
    && JSON.stringify(actual.basis) === JSON.stringify(truth.basis)
  ));
}

function retainedInOrder(expected: readonly PdfQualityExpectedBlock[], actual: string): boolean {
  let offset = 0;
  for (const block of expected) {
    if (block.type === "reported") continue;
    const found = actual.indexOf(block.text.normalize("NFC"), offset);
    if (found < 0) return false;
    offset = found + block.text.length;
  }
  return true;
}

function exactOrderedBlockMatches(
  expected: readonly PdfQualityExpectedBlock[],
  actual: readonly PdfQualityObservedBlock[],
  criticalNegative: boolean,
): MatchCounts {
  const comparable = expected.filter((block) => block.type !== "reported" && block.type !== "table-cell");
  if (criticalNegative) {
    const retained = retainedInOrder(expected, actual.map((block) => block.text).join("\n"));
    return { truePositive: retained ? comparable.length : 0, falsePositive: 0, falseNegative: retained ? 0 : comparable.length };
  }
  let truePositive = 0;
  const length = Math.min(comparable.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    const truth = comparable[index]!;
    const observed = actual[index]!;
    if (
      truth.pageIndex === observed.pageIndex
      && truth.type === observed.type
      && (truth.depth ?? 0) === observed.depth
      && truth.text.normalize("NFC") === observed.text
    ) truePositive += 1;
  }
  return {
    truePositive,
    falsePositive: actual.length - truePositive,
    falseNegative: comparable.length - truePositive,
  };
}

function spanKey(span: PdfQualityExpectedSpan): string {
  return [span.pageIndex, span.tableIndex, span.rowIndex, span.columnIndex, span.rowspan, span.colspan].join(":");
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

function arrayEqual(left: readonly number[], right: readonly number[]): boolean {
  return JSON.stringify(sortedNumbers(left)) === JSON.stringify(sortedNumbers(right));
}

function evaluateFixture(
  fixture: PdfQualityManifestEntry,
  observation: PdfQualityObservation,
): { result: PdfQualityFixtureResult; boundary: MatchCounts; blocks: MatchCounts; list: MatchCounts; table: MatchCounts; spans: MatchCounts } {
  const { review } = observation;
  const expectedBlocks = fixture.expected.orderedBlocks.filter((block) => block.type !== "reported");
  const expectedText = expectedBlocks.map((block) => block.text).join("\n");
  const observedText = observation.blocks.map((block) => block.text).join("\n");
  const boundary = wordBoundaryMatches(expectedText, observedText);
  const blocks = exactOrderedBlockMatches(fixture.expected.orderedBlocks, observation.blocks, fixture.criticalNegative);
  const expectedLists = expectedBlocks.filter((block) => block.type === "list-paragraph")
    .map((block) => `${block.pageIndex}:${block.depth ?? 0}:${block.text.normalize("NFC")}`);
  const actualLists = observation.blocks.filter((block) => block.type === "list-paragraph")
    .map((block) => `${block.pageIndex}:${block.depth}:${block.text}`);
  const list = multisetMatches(expectedLists, actualLists);
  const expectedTableCells = expectedBlocks.filter((block) => block.type === "table-row")
    .flatMap((block) => block.text.split(" | ").map((text) => `${block.pageIndex}:${text.normalize("NFC")}`));
  const actualTableCells = observation.blocks.filter((block) => block.type === "table-row")
    .flatMap((block) => block.text.split(" | ").map((text) => `${block.pageIndex}:${text}`));
  const table = multisetMatches(expectedTableCells, actualTableCells);
  const spans = multisetMatches(
    (fixture.expected.tableSpans ?? []).map(spanKey),
    observation.spans.map(spanKey),
  );
  const visible = review.pages.reduce((sum, page) => sum + page.visibleCharacterCount, 0);
  const uniquelyOwned = review.pages.reduce((sum, page) => sum + page.uniquelyOwnedCharacterCount, 0);
  const accountedPages = review.pages.filter((page) =>
    page.visibleCharacterCount === page.uniquelyOwnedCharacterCount
  ).length;
  const duplicateCharacterOwnership = review.pages.reduce((sum, page) =>
    sum + page.duplicateOwnershipAttemptCount
  , 0);
  const expectedReported = fixture.expected.orderedBlocks.filter((block) => block.type === "reported");
  let falseNativeCount = expectedReported.filter((truth) => observation.blocks.some((block) =>
    block.text === truth.text.normalize("NFC")
  )).length;
  if (
    fixture.qualityFamilies.includes("nested-table-negative")
    && observation.blocks.some((block) => block.type === "table-row")
  ) falseNativeCount += 1;
  if (
    fixture.qualityFamilies.includes("multiple-nested-lists-negative")
    && observation.blocks.some((block) => block.type === "list-paragraph" && block.depth > 0)
  ) falseNativeCount += 1;
  const expectedFallbackPages = fixture.expected.ownership.fallbackPages;
  const actualFallbackPages = review.pages.filter((page) =>
    page.fallbackScope === "region" || page.fallbackScope === "page"
  ).map((page) => page.pageIndex);
  const actualUnlocalizablePages = review.pages.filter((page) => page.fallbackScope === "page")
    .map((page) => page.pageIndex);
  const fallbackExact = arrayEqual(expectedFallbackPages, actualFallbackPages)
    && arrayEqual(fixture.expected.ownership.unlocalizablePages, actualUnlocalizablePages)
    && review.pages.reduce((sum, page) => sum + page.geometryRepairRegionCount, 0)
      === fixture.expected.ownership.localizedRepairRegions;
  const requiredIssuesExact = (fixture.expected.requiredIssueCodes ?? []).every((code) =>
    observation.issueCodes.includes(code)
  );
  const unresolvedIds = new Set(review.boundaries.filter((item) => item.action === "unresolved").map((item) => item.id));
  const unresolvedBoundaryInNativeBlockCount = review.evidence.filter((entry) =>
    entry.outcome === "native" && entry.boundaryDecisionIds.some((id) => unresolvedIds.has(id))
  ).length;
  const allowedLinks = new Set(fixture.expected.safeLinks);
  const unsafeLinkPromotedCount = observation.links.filter((href) => !allowedLinks.has(href)).length;
  const boundaryPrecision = ratio(boundary.truePositive, boundary.truePositive + boundary.falsePositive);
  const boundaryRecall = ratio(boundary.truePositive, boundary.truePositive + boundary.falseNegative);
  const orderedRate = ratio(blocks.truePositive, blocks.truePositive + blocks.falsePositive + blocks.falseNegative);
  const listScore = fixture.class === "tagged" ? f1(list) : null;
  const tableScore = fixture.class === "tagged" ? f1(table) : null;
  const spanScore = fixture.class === "tagged" ? f1(spans) : null;
  const fragmentedRate = fixture.qualityFamilies.includes("split-text-objects") ? orderedRate : null;
  const failureCodes: string[] = [];
  if (review.pages.length !== fixture.pages || accountedPages !== fixture.pages) failureCodes.push("accounted-pages");
  if (visible - uniquelyOwned !== 0) failureCodes.push("unreported-visible-character-loss");
  if (duplicateCharacterOwnership !== fixture.expected.ownership.duplicateCharacterOwners) failureCodes.push("duplicate-character-ownership");
  if (falseNativeCount !== 0) failureCodes.push("false-native-negative");
  if (fragmentedRate !== null && fragmentedRate !== 1) failureCodes.push("fragmented-exact-text");
  const boundaryMinimum = fixture.class === "tagged" ? 0.995 : 0.98;
  if (boundaryPrecision < boundaryMinimum) failureCodes.push("word-boundary-precision");
  if (boundaryRecall < boundaryMinimum) failureCodes.push("word-boundary-recall");
  const blockMinimum = fixture.class === "tagged" ? 0.99 : 0.96;
  if (orderedRate < blockMinimum) failureCodes.push("ordered-block-pairs");
  if (listScore !== null && listScore < 0.99) failureCodes.push("tagged-list-f1");
  if (tableScore !== null && tableScore < 0.99) failureCodes.push("tagged-table-cell-f1");
  if (spanScore !== null && spanScore !== 1) failureCodes.push("explicit-span-f1");
  const boundariesExact = expectedBoundaryExact(fixture.expected.boundaries, review);
  if (!boundariesExact) failureCodes.push("expected-boundary-exact");
  if (!fallbackExact) failureCodes.push("fallback-outcome");
  if (!requiredIssuesExact) failureCodes.push("required-issues");
  if (unresolvedBoundaryInNativeBlockCount !== 0) failureCodes.push("unresolved-native-boundary");
  if (unsafeLinkPromotedCount !== 0) failureCodes.push("unsafe-link-promoted");
  const result: PdfQualityFixtureResult = {
    fixtureId: fixture.id,
    producerFamily: fixture.producer.family,
    class: fixture.class,
    criticalNegative: fixture.criticalNegative,
    accountedPageRate: ratio(accountedPages, fixture.pages),
    unreportedVisibleCharacterLoss: visible - uniquelyOwned,
    duplicateCharacterOwnership,
    falseNativeCount,
    exactFragmentedTextRate: fragmentedRate,
    wordBoundaryPrecision: boundaryPrecision,
    wordBoundaryRecall: boundaryRecall,
    exactOrderedBlockPairRate: orderedRate,
    taggedListF1: listScore,
    taggedTableCellTextF1: tableScore,
    explicitSpanF1: spanScore,
    expectedBoundaryExact: boundariesExact,
    fallbackExact,
    requiredIssuesExact,
    unresolvedBoundaryInNativeBlockCount,
    unsafeLinkPromotedCount,
    failureCodes,
    passed: failureCodes.length === 0,
    counts: {
      pages: review.pages.length,
      expectedBlocks: expectedBlocks.length,
      observedBlocks: observation.blocks.length,
      expectedBoundaries: fixture.expected.boundaries.length,
      observedBoundaries: review.boundaries.length,
    },
  };
  return { result, boundary, blocks, list, table, spans };
}

export function evaluatePdfQuality(
  manifest: PdfQualityManifest,
  observations: readonly PdfQualityObservation[],
): PdfQualityResult {
  const byFixture = new Map(observations.map((observation) => [observation.fixtureId, observation]));
  const evaluated = manifest.fixtures.map((fixture) => {
    const observation = byFixture.get(fixture.id);
    if (!observation) throw new Error(`Missing PDF quality observation for fixture ${fixture.id}.`);
    return evaluateFixture(fixture, observation);
  });
  const all = evaluated.map((entry) => entry.result);
  const sum = (selector: (entry: PdfQualityFixtureResult) => number): number =>
    all.reduce((total, entry) => total + selector(entry), 0);
  const boundary = evaluated.reduce<MatchCounts>((total, entry) => ({
    truePositive: total.truePositive + entry.boundary.truePositive,
    falsePositive: total.falsePositive + entry.boundary.falsePositive,
    falseNegative: total.falseNegative + entry.boundary.falseNegative,
  }), { truePositive: 0, falsePositive: 0, falseNegative: 0 });
  const combined = (key: "blocks" | "list" | "table" | "spans", taggedOnly = false): MatchCounts =>
    evaluated.filter((entry) => !taggedOnly || entry.result.class === "tagged")
      .reduce<MatchCounts>((total, entry) => ({
        truePositive: total.truePositive + entry[key].truePositive,
        falsePositive: total.falsePositive + entry[key].falsePositive,
        falseNegative: total.falseNegative + entry[key].falseNegative,
      }), { truePositive: 0, falsePositive: 0, falseNegative: 0 });
  const block = combined("blocks");
  const fragmented = all.filter((entry) => entry.exactFragmentedTextRate !== null);
  return {
    schema: "atlcli.import-pdf-quality/1",
    passed: all.every((entry) => entry.passed),
    fixtures: all,
    aggregate: {
      accountedPageRate: ratio(sum((entry) => entry.accountedPageRate * entry.counts.pages), sum((entry) => entry.counts.pages)),
      unreportedVisibleCharacterLoss: sum((entry) => entry.unreportedVisibleCharacterLoss),
      duplicateCharacterOwnership: sum((entry) => entry.duplicateCharacterOwnership),
      falseNativeCount: sum((entry) => entry.falseNativeCount),
      exactFragmentedTextRate: ratio(fragmented.filter((entry) => entry.exactFragmentedTextRate === 1).length, fragmented.length),
      wordBoundaryPrecision: ratio(boundary.truePositive, boundary.truePositive + boundary.falsePositive),
      wordBoundaryRecall: ratio(boundary.truePositive, boundary.truePositive + boundary.falseNegative),
      exactOrderedBlockPairRate: ratio(block.truePositive, block.truePositive + block.falsePositive + block.falseNegative),
      taggedListF1: f1(combined("list", true)),
      taggedTableCellTextF1: f1(combined("table", true)),
      explicitSpanF1: f1(combined("spans", true)),
      unresolvedBoundaryInNativeBlockCount: sum((entry) => entry.unresolvedBoundaryInNativeBlockCount),
      unsafeLinkPromotedCount: sum((entry) => entry.unsafeLinkPromotedCount),
    },
  };
}

export async function runPdfQuality(): Promise<PdfQualityResult> {
  const manifest = await readPdfQualityManifest();
  return evaluatePdfQuality(manifest, await collectPdfQualityObservations(manifest));
}

if (import.meta.main) {
  const result = await runPdfQuality();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
