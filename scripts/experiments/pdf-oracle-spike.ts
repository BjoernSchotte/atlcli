#!/usr/bin/env bun
/**
 * Temporary multi-engine PDF import architecture spike.
 *
 * PDFium remains the production analyzer. PDF.js, PDFBox, Poppler and
 * pdfplumber are projected into body-free diagnostic summaries only; they are
 * never disguised as PdfFactsV2 and never reach Confluence publication.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ImportBlock, ImportRun } from "@atlcli/import-core";
import {
  buildPdfImportReviewV3,
  parsePdfSplitPolicy,
  type PdfFactsV2,
  type PdfStructureNodeFactV2,
} from "../../packages/import-pdf/src/index.js";
import { createNodePdfiumFactsAdapterV2 } from "../../packages/import-pdf/src/node.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const JAVA_ORACLE = resolve(ROOT, "scripts/experiments/pdf-oracle/PdfBoxStructureOracle.java");
const PYTHON_ORACLE = resolve(ROOT, "scripts/experiments/pdf-oracle/pdfplumber_oracle.py");

export interface PdfOracleSpikeOptions {
  input: string;
  label: string;
  pdfboxJar: string;
  python: string;
  java: string;
  javac: string;
  pdftotext: string;
  format: "full" | "summary";
}

export interface PdfBoxTableOracle {
  index: number;
  rowCount: number;
  cellCount: number;
  headerCellCount: number;
  dataCellCount: number;
  emptyCellCount: number;
  unresolvedCellCount: number;
  pages: number[];
  rowCellCounts: number[];
}

export interface PdfBoxStructureOracle {
  schema: "atlcli.pdfbox-structure-oracle/1";
  engine: string;
  pages: number;
  tagged: boolean;
  nodeCount: number;
  kidCounts: { element: number; mcid: number; object: number; unknown: number };
  cycleCount: number;
  crossPageElementEdgeCount: number;
  roleCounts: Record<string, number>;
  tables: PdfBoxTableOracle[];
  materializedCellCount: number;
  materializedMcidReferenceCount: number;
  materializedTextTokens: number;
}

interface PdfBoxMaterializedTableOracle extends PdfBoxTableOracle {
  materializedRows: string[][];
  materializedReferences: string[][][];
}

interface PdfBoxMaterializedStructureOracle extends Omit<
  PdfBoxStructureOracle,
  "tables" | "materializedCellCount" | "materializedMcidReferenceCount" | "materializedTextTokens"
> {
  tables: PdfBoxMaterializedTableOracle[];
}

export interface PdfPlumberTableOracle {
  bbox: [number, number, number, number];
  rows: number;
  columns: number;
  emptyCells: number;
}

export interface PdfPlumberGeometryOracle {
  schema: "atlcli.pdfplumber-geometry-oracle/1";
  engine: string;
  pages: Array<{
    pageIndex: number;
    characterCount: number;
    lineCount: number;
    rectangleCount: number;
    curveCount: number;
    lineTables: PdfPlumberTableOracle[];
    textTables: PdfPlumberTableOracle[];
  }>;
}

export interface PdfJsOracleSummary {
  schema: "atlcli.pdfjs-oracle/1";
  engine: string;
  pages: Array<{
    pageIndex: number;
    structureRoles: Record<string, number>;
    structureContentLeaves: number;
    textItems: number;
    markedContentBegins: number;
  }>;
}

export interface PopplerOracleSummary {
  schema: "atlcli.poppler-oracle/1";
  engine: string;
  pages: Array<{ pageIndex: number; blocks: number; lines: number; words: number }>;
  textCharacters: number;
  textTokens: number;
}

export interface PdfiumImportSummary {
  schema: "atlcli.pdfium-import-summary/1";
  engine: string;
  classification: PdfFactsV2["classification"];
  tagged: boolean;
  pages: number;
  structureRoleCounts: Record<string, number>;
  unresolvedStructureKids: number;
  blocks: Record<string, number>;
  tables: Array<{
    rows: number;
    cells: number;
    headerCells: number;
    emptyCells: number;
    rowCellCounts: number[];
  }>;
  pageFallbacks: number;
  regionFallbacks: number;
  unresolvedBoundaries: number;
  unownedCharacters: number;
  duplicateOwnershipAttempts: number;
  issueCodes: Record<string, number>;
  factsTextTokens: number;
  semanticTextTokens: number;
}

export interface PdfOracleSpikeReport {
  schema: "atlcli.pdf-oracle-spike/1";
  source: { label: string; privateSafe: true };
  current: PdfiumImportSummary;
  oracles: {
    pdfjs: PdfJsOracleSummary;
    pdfbox: PdfBoxStructureOracle;
    poppler: PopplerOracleSummary;
    pdfplumber: PdfPlumberGeometryOracle;
  };
  comparisons: {
    pdfiumFactsVsPopplerTokenPrecision: number;
    pdfiumFactsVsPopplerTokenRecall: number;
    semanticVsPopplerTokenPrecision: number;
    semanticVsPopplerTokenRecall: number;
    pdfiumVsPdfjsStructureRoleDelta: number;
    pdfiumVsPdfboxStructureRoleDelta: number;
    pdfboxLogicalTables: number;
    pdfboxMultiPageTables: number;
    pdfboxTableMcidReferencesCoveredByPdfiumFacts: number;
    pdfboxTableTokensCoveredByPdfiumFacts: number;
    pdfboxTableTokensCoveredByCurrentSemantics: number;
    pdfplumberLineTables: number;
    currentEditableTables: number;
  };
  findings: string[];
  actionableOracleAdvantage: boolean;
  targetArchitectureCarries: boolean;
}

interface TextComparison {
  precision: number;
  recall: number;
}

function usage(): never {
  throw new Error(
    "usage: bun --conditions=development scripts/experiments/pdf-oracle-spike.ts "
      + "--input <pdf> --label <safe-label> --pdfbox-jar <jar> [--python <python>]",
  );
}

function parseArgs(argv: string[]): PdfOracleSpikeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    values.set(name.slice(2), value);
  }
  const input = values.get("input");
  const label = values.get("label");
  const pdfboxJar = values.get("pdfbox-jar");
  if (!input || !label || !pdfboxJar) usage();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(label)) {
    throw new Error("--label must be a non-identifying lowercase slug");
  }
  return {
    input: resolve(input),
    label,
    pdfboxJar: resolve(pdfboxJar),
    python: values.get("python") ?? process.env.ATLCLI_PDF_ORACLE_PYTHON ?? "python3",
    java: values.get("java") ?? "java",
    javac: values.get("javac") ?? "javac",
    pdftotext: values.get("pdftotext") ?? "pdftotext",
    format: values.get("format") === "summary" ? "summary" : "full",
  };
}

async function runBodyFree(
  command: string,
  args: string[],
  label: string,
  options: { maxBuffer?: number } = {},
): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unknown";
    throw new Error(`${label} failed with exit code ${code}`);
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function walkPdfiumStructures(
  nodes: readonly PdfStructureNodeFactV2[],
  roleCounts: Record<string, number>,
): number {
  let unresolved = 0;
  for (const node of nodes) {
    increment(roleCounts, node.type);
    for (const kid of node.kids) {
      if (kid.kind === "element") unresolved += walkPdfiumStructures([kid.node], roleCounts);
      else if (kid.kind === "unresolved") unresolved += 1;
    }
  }
  return unresolved;
}

function textOfRuns(runs: readonly ImportRun[]): string {
  return runs.map((run) => run.kind === "text" ? run.text : "\n").join("");
}

function collectImportBlocks(
  blocks: readonly ImportBlock[],
  blockCounts: Record<string, number>,
  tables: PdfiumImportSummary["tables"],
  text: string[],
): void {
  for (const block of blocks) {
    increment(blockCounts, block.type);
    if (block.type === "heading" || block.type === "paragraph") {
      text.push(textOfRuns(block.runs));
    } else if (block.type === "code") {
      text.push(block.text);
    } else if (block.type === "table") {
      const cells = block.rows.flatMap((row) => row.cells);
      tables.push({
        rows: block.rows.length,
        cells: cells.length,
        headerCells: cells.filter((cell) => cell.header).length,
        emptyCells: cells.filter((cell) => {
          const cellText: string[] = [];
          collectImportBlocks(cell.blocks, {}, [], cellText);
          return cellText.join("").trim().length === 0;
        }).length,
        rowCellCounts: block.rows.map((row) => row.cells.length),
      });
      for (const cell of cells) collectImportBlocks(cell.blocks, blockCounts, tables, text);
    } else if (block.type === "list") {
      for (const item of block.items) {
        collectImportBlocks(item.blocks, blockCounts, tables, text);
        if (item.child) collectImportBlocks([item.child], blockCounts, tables, text);
      }
    } else if (block.type === "blockquote" || block.type === "disclosure") {
      collectImportBlocks(block.blocks, blockCounts, tables, text);
    }
  }
}

export function normalizedTokens(value: string): string[] {
  return value.normalize("NFC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function compareTokenMultisets(candidate: string, oracle: string): TextComparison {
  const candidateCounts = new Map<string, number>();
  const oracleCounts = new Map<string, number>();
  for (const token of normalizedTokens(candidate)) candidateCounts.set(token, (candidateCounts.get(token) ?? 0) + 1);
  for (const token of normalizedTokens(oracle)) oracleCounts.set(token, (oracleCounts.get(token) ?? 0) + 1);
  let matched = 0;
  for (const [token, count] of candidateCounts) matched += Math.min(count, oracleCounts.get(token) ?? 0);
  const candidateTotal = [...candidateCounts.values()].reduce((sum, count) => sum + count, 0);
  const oracleTotal = [...oracleCounts.values()].reduce((sum, count) => sum + count, 0);
  return {
    precision: candidateTotal === 0 ? (oracleTotal === 0 ? 1 : 0) : matched / candidateTotal,
    recall: oracleTotal === 0 ? (candidateTotal === 0 ? 1 : 0) : matched / oracleTotal,
  };
}

async function pdfiumSummary(bytes: Uint8Array): Promise<{
  summary: PdfiumImportSummary;
  factsText: string;
  semanticText: string;
  mcidKeys: Set<string>;
}> {
  const adapter = await createNodePdfiumFactsAdapterV2();
  const review = await buildPdfImportReviewV3(bytes, adapter, {
    target: {
      spaceKey: "DOCSY",
      title: "Body-free PDF oracle spike",
      deployment: "cloud",
      supportsPageTree: true,
      evidence: "profile",
    },
    splitPolicy: parsePdfSplitPolicy("off"),
    scanPolicy: "report",
    unsupported: "report",
    attachSource: false,
  });
  const structureRoleCounts: Record<string, number> = {};
  let unresolvedStructureKids = 0;
  for (const page of review.facts.pages) {
    unresolvedStructureKids += walkPdfiumStructures(page.structures, structureRoleCounts);
  }
  const blocks: Record<string, number> = {};
  const tables: PdfiumImportSummary["tables"] = [];
  const semanticTextParts: string[] = [];
  collectImportBlocks(review.document.blocks, blocks, tables, semanticTextParts);
  const issueCodes: Record<string, number> = {};
  for (const issue of review.document.issues) increment(issueCodes, issue.code);
  const factsText = review.facts.pages.map((page) => page.text).join("\f");
  const semanticText = semanticTextParts.join("\n");
  const mcidKeys = new Set<string>();
  for (const page of review.facts.pages) {
    for (const character of page.characters) {
      if (character.mcid !== null) mcidKeys.add(`${page.index}:${character.mcid}`);
    }
  }
  return {
    summary: {
      schema: "atlcli.pdfium-import-summary/1",
      engine: `${review.facts.provenance.engine} ${review.facts.provenance.engineVersion}`,
      classification: review.facts.classification,
      tagged: review.facts.tagged,
      pages: review.facts.pageCount,
      structureRoleCounts: sortedCounts(structureRoleCounts),
      unresolvedStructureKids,
      blocks: sortedCounts(blocks),
      tables,
      pageFallbacks: review.pages.filter((page) => page.fallbackScope === "page").length,
      regionFallbacks: review.pages.filter((page) => page.fallbackScope === "region").length,
      unresolvedBoundaries: review.pages.reduce((sum, page) => sum + page.unresolvedBoundaryCount, 0),
      unownedCharacters: review.pages.reduce((sum, page) => sum + page.unownedCharacterCount, 0),
      duplicateOwnershipAttempts: review.pages.reduce(
        (sum, page) => sum + page.duplicateOwnershipAttemptCount,
        0,
      ),
      issueCodes: sortedCounts(issueCodes),
      factsTextTokens: normalizedTokens(factsText).length,
      semanticTextTokens: normalizedTokens(semanticText).length,
    },
    factsText,
    semanticText,
    mcidKeys,
  };
}

function walkPdfJsStructure(
  value: unknown,
  roleCounts: Record<string, number>,
  state: { contentLeaves: number },
): void {
  if (!value || typeof value !== "object") return;
  const node = value as { role?: unknown; type?: unknown; children?: unknown };
  if (typeof node.role === "string") increment(roleCounts, node.role);
  if (node.type === "content") state.contentLeaves += 1;
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkPdfJsStructure(child, roleCounts, state);
  }
}

async function pdfJsSummary(bytes: Uint8Array): Promise<PdfJsOracleSummary> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await task.promise;
  try {
    const pages: PdfJsOracleSummary["pages"] = [];
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1);
      const roleCounts: Record<string, number> = {};
      const state = { contentLeaves: 0 };
      walkPdfJsStructure(await page.getStructTree(), roleCounts, state);
      const content = await page.getTextContent({ includeMarkedContent: true });
      let textItems = 0;
      let markedContentBegins = 0;
      for (const item of content.items as Array<Record<string, unknown>>) {
        if (typeof item.str === "string") textItems += 1;
        else if (item.type === "beginMarkedContent" || item.type === "beginMarkedContentProps") {
          markedContentBegins += 1;
        }
      }
      pages.push({
        pageIndex,
        structureRoles: sortedCounts(roleCounts),
        structureContentLeaves: state.contentLeaves,
        textItems,
        markedContentBegins,
      });
      page.cleanup();
    }
    return { schema: "atlcli.pdfjs-oracle/1", engine: `PDF.js ${pdfjs.version}`, pages };
  } finally {
    document.cleanup();
    await task.destroy();
  }
}

async function pdfBoxSummary(
  options: PdfOracleSpikeOptions,
  workDirectory: string,
): Promise<{ summary: PdfBoxStructureOracle; tableText: string; referenceKeys: string[] }> {
  const classes = join(workDirectory, "pdfbox-classes");
  await mkdir(classes, { recursive: true });
  await runBodyFree(options.javac, ["-cp", options.pdfboxJar, "-d", classes, JAVA_ORACLE], "PDFBox oracle compile");
  const stdout = await runBodyFree(
    options.java,
    [
      "-cp",
      `${options.pdfboxJar}${delimiter}${classes}`,
      "PdfBoxStructureOracle",
      options.input,
      "--materialize",
    ],
    "PDFBox oracle",
  );
  const materialized = JSON.parse(stdout) as PdfBoxMaterializedStructureOracle;
  const tableText = materialized.tables
    .flatMap((table) => table.materializedRows.flat())
    .join("\n");
  const referenceKeys = materialized.tables
    .flatMap((table) => table.materializedReferences.flat(2));
  return {
    summary: {
      ...materialized,
      tables: materialized.tables.map((table) => ({
        index: table.index,
        rowCount: table.rowCount,
        cellCount: table.cellCount,
        headerCellCount: table.headerCellCount,
        dataCellCount: table.dataCellCount,
        emptyCellCount: table.emptyCellCount,
        unresolvedCellCount: table.unresolvedCellCount,
        pages: table.pages,
        rowCellCounts: table.rowCellCounts,
      })),
      materializedCellCount: materialized.tables.reduce((sum, table) => sum + table.cellCount, 0),
      materializedMcidReferenceCount: referenceKeys.length,
      materializedTextTokens: normalizedTokens(tableText).length,
    },
    tableText,
    referenceKeys,
  };
}

async function pdfPlumberSummary(options: PdfOracleSpikeOptions): Promise<PdfPlumberGeometryOracle> {
  const stdout = await runBodyFree(options.python, [PYTHON_ORACLE, options.input], "pdfplumber oracle");
  return JSON.parse(stdout) as PdfPlumberGeometryOracle;
}

async function popplerSummary(
  options: PdfOracleSpikeOptions,
  workDirectory: string,
): Promise<{ summary: PopplerOracleSummary; text: string }> {
  const bboxPath = join(workDirectory, "poppler-bbox.html");
  await runBodyFree(options.pdftotext, ["-q", "-bbox-layout", "-enc", "UTF-8", options.input, bboxPath], "Poppler bbox");
  const bbox = await readFile(bboxPath, "utf8");
  const pageParts = bbox.split(/<page\b/gu).slice(1);
  const pages = pageParts.map((page, pageIndex) => ({
    pageIndex,
    blocks: (page.match(/<block\b/gu) ?? []).length,
    lines: (page.match(/<line\b/gu) ?? []).length,
    words: (page.match(/<word\b/gu) ?? []).length,
  }));
  const text = await runBodyFree(
    options.pdftotext,
    ["-q", "-layout", "-enc", "UTF-8", options.input, "-"],
    "Poppler text",
  );
  return {
    summary: {
      schema: "atlcli.poppler-oracle/1",
      engine: "Poppler pdftotext 26.03.0",
      pages,
      textCharacters: [...text].length,
      textTokens: normalizedTokens(text).length,
    },
    text,
  };
}

export function roleCountDelta(left: Record<string, number>, right: Record<string, number>): number {
  const roles = new Set([...Object.keys(left), ...Object.keys(right)]);
  let delta = 0;
  for (const role of roles) delta += Math.abs((left[role] ?? 0) - (right[role] ?? 0));
  return delta;
}

function combinedPdfJsRoles(summary: PdfJsOracleSummary): Record<string, number> {
  const result: Record<string, number> = {};
  for (const page of summary.pages) {
    for (const [role, count] of Object.entries(page.structureRoles)) {
      if (role === "Root") continue;
      result[role] = (result[role] ?? 0) + count;
    }
  }
  return result;
}

export function assessArchitecture(input: {
  current: PdfiumImportSummary;
  pdfbox: PdfBoxStructureOracle;
  pdfplumber: PdfPlumberGeometryOracle;
  comparisons: Omit<PdfOracleSpikeReport["comparisons"], "pdfiumVsPdfjsStructureRoleDelta" | "pdfiumVsPdfboxStructureRoleDelta">;
}): { findings: string[]; carries: boolean } {
  const findings: string[] = [];
  if (input.pdfbox.tables.some((table) => table.pages.length > 1)) {
    findings.push("oracle/full-document-multipage-table-visible");
  }
  if (input.comparisons.pdfboxLogicalTables > input.comparisons.currentEditableTables) {
    findings.push("oracle/full-structure-table-advantage");
  }
  if (input.comparisons.pdfplumberLineTables > input.comparisons.currentEditableTables) {
    findings.push("oracle/local-grid-advantage");
  }
  if (input.current.pageFallbacks > 0 || input.current.regionFallbacks > 0) {
    findings.push("current/visual-fallback-present");
  }
  if (input.comparisons.semanticVsPopplerTokenRecall < 0.995) {
    findings.push("current/semantic-token-delta-needs-semantic-oracle");
  }
  if (input.current.unresolvedStructureKids > 0 && input.pdfbox.kidCounts.unknown === 0) {
    findings.push("oracle/full-structure-resolves-pdfium-gap");
  }
  if (
    input.pdfbox.materializedMcidReferenceCount > 0
    && input.comparisons.pdfboxTableMcidReferencesCoveredByPdfiumFacts < 1
  ) {
    findings.push("oracle/cross-engine-mcid-coverage-gap");
  }
  if (findings.length === 0) findings.push("oracle/no-measured-advantage-on-this-input");
  return {
    findings,
    carries: findings.some((finding) => finding.startsWith("oracle/") && finding !== "oracle/no-measured-advantage-on-this-input"),
  };
}

export async function buildPdfOracleSpikeReport(
  options: PdfOracleSpikeOptions,
): Promise<PdfOracleSpikeReport> {
  const workDirectory = await mkdtemp(join(tmpdir(), "atlcli-pdf-oracle-"));
  try {
    const bytes = new Uint8Array(await readFile(options.input));
    const current = await pdfiumSummary(bytes);
    const [pdfjs, pdfboxMaterialized, poppler, pdfplumber] = await Promise.all([
      pdfJsSummary(bytes),
      pdfBoxSummary(options, workDirectory),
      popplerSummary(options, workDirectory),
      pdfPlumberSummary(options),
    ]);
    const factsTextComparison = compareTokenMultisets(current.factsText, poppler.text);
    const semanticTextComparison = compareTokenMultisets(current.semanticText, poppler.text);
    const pdfbox = pdfboxMaterialized.summary;
    const tableFactsComparison = compareTokenMultisets(current.factsText, pdfboxMaterialized.tableText);
    const tableSemanticComparison = compareTokenMultisets(
      current.semanticText,
      pdfboxMaterialized.tableText,
    );
    const hasMaterializedTableText = pdfbox.materializedTextTokens > 0;
    const coveredTableMcidReferences = pdfboxMaterialized.referenceKeys.filter(
      (key) => current.mcidKeys.has(key),
    ).length;
    const partialComparisons = {
      pdfiumFactsVsPopplerTokenPrecision: factsTextComparison.precision,
      pdfiumFactsVsPopplerTokenRecall: factsTextComparison.recall,
      semanticVsPopplerTokenPrecision: semanticTextComparison.precision,
      semanticVsPopplerTokenRecall: semanticTextComparison.recall,
      pdfboxLogicalTables: pdfbox.tables.length,
      pdfboxMultiPageTables: pdfbox.tables.filter((table) => table.pages.length > 1).length,
      pdfboxTableMcidReferencesCoveredByPdfiumFacts: pdfboxMaterialized.referenceKeys.length === 0
        ? 1
        : coveredTableMcidReferences / pdfboxMaterialized.referenceKeys.length,
      pdfboxTableTokensCoveredByPdfiumFacts: hasMaterializedTableText ? tableFactsComparison.recall : 1,
      pdfboxTableTokensCoveredByCurrentSemantics: hasMaterializedTableText
        ? tableSemanticComparison.recall
        : 1,
      pdfplumberLineTables: pdfplumber.pages.reduce((sum, page) => sum + page.lineTables.length, 0),
      currentEditableTables: current.summary.tables.length,
    };
    const comparisons: PdfOracleSpikeReport["comparisons"] = {
      ...partialComparisons,
      pdfiumVsPdfjsStructureRoleDelta: roleCountDelta(
        current.summary.structureRoleCounts,
        combinedPdfJsRoles(pdfjs),
      ),
      pdfiumVsPdfboxStructureRoleDelta: roleCountDelta(
        current.summary.structureRoleCounts,
        pdfbox.roleCounts,
      ),
    };
    const assessment = assessArchitecture({
      current: current.summary,
      pdfbox,
      pdfplumber,
      comparisons: partialComparisons,
    });
    const pageCountsAgree = current.summary.pages === pdfjs.pages.length
      && current.summary.pages === pdfbox.pages
      && current.summary.pages === poppler.summary.pages.length
      && current.summary.pages === pdfplumber.pages.length;
    return {
      schema: "atlcli.pdf-oracle-spike/1",
      source: { label: options.label, privateSafe: true },
      current: current.summary,
      oracles: { pdfjs, pdfbox, poppler: poppler.summary, pdfplumber },
      comparisons,
      findings: assessment.findings,
      actionableOracleAdvantage: assessment.carries,
      targetArchitectureCarries: pageCountsAgree && pdfbox.cycleCount === 0,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildPdfOracleSpikeReport(options);
  const output = options.format === "summary"
    ? {
        schema: report.schema,
        source: report.source,
        current: {
          engine: report.current.engine,
          classification: report.current.classification,
          pages: report.current.pages,
          tables: report.current.tables.length,
          pageFallbacks: report.current.pageFallbacks,
          regionFallbacks: report.current.regionFallbacks,
          unresolvedStructureKids: report.current.unresolvedStructureKids,
          unresolvedBoundaries: report.current.unresolvedBoundaries,
          unownedCharacters: report.current.unownedCharacters,
          duplicateOwnershipAttempts: report.current.duplicateOwnershipAttempts,
        },
        oracles: {
          pdfjs: { engine: report.oracles.pdfjs.engine },
          pdfbox: {
            engine: report.oracles.pdfbox.engine,
            tables: report.oracles.pdfbox.tables.length,
            multiPageTables: report.oracles.pdfbox.tables.filter((table) => table.pages.length > 1).length,
            materializedCells: report.oracles.pdfbox.materializedCellCount,
            materializedMcidReferences: report.oracles.pdfbox.materializedMcidReferenceCount,
            materializedTextTokens: report.oracles.pdfbox.materializedTextTokens,
            emptyCells: report.oracles.pdfbox.tables.reduce((sum, table) => sum + table.emptyCellCount, 0),
            unknownKids: report.oracles.pdfbox.kidCounts.unknown,
          },
          poppler: { engine: report.oracles.poppler.engine },
          pdfplumber: {
            engine: report.oracles.pdfplumber.engine,
            lineTables: report.oracles.pdfplumber.pages.reduce((sum, page) => sum + page.lineTables.length, 0),
          },
        },
        comparisons: report.comparisons,
        findings: report.findings,
        actionableOracleAdvantage: report.actionableOracleAdvantage,
        targetArchitectureCarries: report.targetArchitectureCarries,
      }
    : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) await main();
