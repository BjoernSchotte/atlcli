import {
  assessEditability,
  documentToAdf,
  documentToStorage,
  type EditabilityAssessment,
  type ImportAsset,
  type ImportBlock,
  type ImportDocumentV2,
  type ImportListBlock,
} from "@atlcli/import-core";
import { digestPdfCanonical } from "./canonical.js";
import type { PdfDecisionEvidenceV1, PdfFactsV1 } from "./contracts.js";
import { PdfImportError } from "./issues.js";

export const PDF_SPLIT_POLICY_SCHEMA_V1 = "atlcli.pdf-split-policy/1" as const;
export const PDF_SPLIT_PLAN_SCHEMA_V1 = "atlcli.pdf-split-plan/1" as const;
export const PDF_SPLIT_EDITABILITY_REVISION = "atlcli.import-editability/1" as const;
export const PDF_SPLIT_DEFAULT_TARGET_PAGES = 20;
export const PDF_SPLIT_ABSOLUTE_SOURCE_PAGE_LIMIT = 40;
export const PDF_SPLIT_DEFAULT_MAX_WIKI_PAGES = 50;
export const PDF_SPLIT_ABSOLUTE_MAX_WIKI_PAGES = 200;

export type PdfSplitModeV1 =
  | { kind: "auto" }
  | { kind: "off" }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "pages"; targetSourcePages: number };

export interface PdfSplitPolicyV1 {
  schema: typeof PDF_SPLIT_POLICY_SCHEMA_V1;
  mode: PdfSplitModeV1;
  maxWikiPages: number;
  autoSinglePageMaxSourcePages: 20;
  absoluteSinglePageMaxSourcePages: 40;
  editabilityBudgetRevision: typeof PDF_SPLIT_EDITABILITY_REVISION;
}

export type PdfSplitBasisV1 = "root-index" | "heading" | "size-budget" | "page-range" | "preamble";

export interface PdfPlannedPageEstimateV1 {
  adfBytes: number;
  storageBytes: number;
  nodes: number;
  tableCells: number;
  assets: number;
  editability: EditabilityAssessment["level"];
}

export interface PdfPlannedPageV1 {
  id: string;
  title: string;
  sourcePageIndexes: number[];
  sourcePageLabels: string[];
  splitBasis: PdfSplitBasisV1;
  blocks: ImportBlock[];
  assets: ImportAsset[];
  children: PdfPlannedPageV1[];
  estimate: PdfPlannedPageEstimateV1;
  bodyDigest: string;
}

export interface PdfSplitPlanV1 {
  schema: typeof PDF_SPLIT_PLAN_SCHEMA_V1;
  requested: PdfSplitPolicyV1;
  resolved: {
    kind: "single-page" | "page-tree";
    reason: "short-and-editable" | "explicit-off" | "heading" | "page-range" | "auto-long-or-complex";
  };
  root: PdfPlannedPageV1;
  contentPageCount: number;
  totalWikiPages: number;
  sourceAssignments: Array<{ pageIndex: number; plannedPageId: string }>;
  issues: Array<{ code: string; message: string; context?: Record<string, string | number> }>;
  blockers: string[];
  digest: string;
}

interface AssignedBlock {
  block: ImportBlock;
  pages: number[];
}

interface Segment {
  start: number;
  end: number;
  basis: Exclude<PdfSplitBasisV1, "root-index" | "size-budget">;
  title?: string;
  level?: number;
  parentSegment?: Segment;
  page?: PdfPlannedPageV1;
}

function splitInvalid(message: string, context?: Record<string, string | number>): never {
  throw new PdfImportError("pdf/split-policy-invalid", message, context);
}

export function parsePdfSplitPolicy(split?: string, maxWikiPagesText?: string): PdfSplitPolicyV1 {
  let mode: PdfSplitModeV1;
  const value = split ?? "auto";
  if (value === "auto") mode = { kind: "auto" };
  else if (value === "off") mode = { kind: "off" };
  else if (/^[1-6]$/u.test(value)) mode = { kind: "heading", level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 };
  else {
    const heading = /^heading:([1-6])$/u.exec(value);
    const pages = /^pages:(\d+)$/u.exec(value);
    if (heading) mode = { kind: "heading", level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6 };
    else if (pages && Number(pages[1]) >= 5 && Number(pages[1]) <= 40) {
      mode = { kind: "pages", targetSourcePages: Number(pages[1]) };
    } else splitInvalid("--split for PDF must be auto, off, heading:<1..6>, pages:<5..40>, or the numeric 1..6 alias.");
  }
  const maxWikiPages = maxWikiPagesText === undefined ? PDF_SPLIT_DEFAULT_MAX_WIKI_PAGES : Number(maxWikiPagesText);
  if (!Number.isInteger(maxWikiPages) || maxWikiPages < 1 || maxWikiPages > PDF_SPLIT_ABSOLUTE_MAX_WIKI_PAGES) {
    splitInvalid(`--max-wiki-pages must be an integer from 1 through ${PDF_SPLIT_ABSOLUTE_MAX_WIKI_PAGES}.`);
  }
  return {
    schema: PDF_SPLIT_POLICY_SCHEMA_V1,
    mode,
    maxWikiPages,
    autoSinglePageMaxSourcePages: 20,
    absoluteSinglePageMaxSourcePages: 40,
    editabilityBudgetRevision: PDF_SPLIT_EDITABILITY_REVISION,
  };
}

function text(block: ImportBlock): string {
  if (block.type !== "heading" && block.type !== "paragraph") return "";
  return block.runs.map((run) => run.kind === "text" ? run.text : " ").join("").replace(/\s+/gu, " ").trim();
}

function matchingPages(block: ImportBlock, evidence: readonly PdfDecisionEvidenceV1[]): number[] {
  const ids = new Set([block.id, ...(block.sourceRefs ?? [])]);
  return [...new Set(evidence.filter((item) =>
    ids.has(item.sourceId) || (item.targetNodeId ? ids.has(item.targetNodeId) : false)
  ).map((item) => item.locator.pageIndex))].sort((a, b) => a - b);
}

function assignBlocks(
  document: ImportDocumentV2,
  evidence: readonly PdfDecisionEvidenceV1[],
  pageCount: number,
): AssignedBlock[] {
  let inferredPage = 0;
  return document.blocks.map((block) => {
    if (block.pageBoundaryBefore) inferredPage = Math.min(inferredPage + 1, Math.max(0, pageCount - 1));
    const pages = matchingPages(block, evidence);
    if (pages.length > 0) inferredPage = pages[0]!;
    return { block, pages: pages.length > 0 ? pages : [inferredPage] };
  });
}

function assetIds(blocks: readonly ImportBlock[]): Set<string> {
  const result = new Set<string>();
  const walk = (block: ImportBlock): void => {
    if (block.type === "image") result.add(block.assetId);
    else if (block.type === "list") {
      for (const item of block.items) {
        item.blocks.forEach(walk);
        if (item.child) walk(item.child);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) cell.blocks.forEach(walk);
    } else if (block.type === "blockquote") block.blocks.forEach(walk);
  };
  blocks.forEach(walk);
  return result;
}

function pageLabels(facts: PdfFactsV1, indexes: readonly number[]): string[] {
  return indexes.map((index) => facts.pages[index]?.label ?? String(index + 1));
}

function safeRangeLabel(facts: PdfFactsV1, start: number, end: number): string {
  const all = facts.pages.map((page, index) => page.label ?? String(index + 1));
  const unique = new Set(all).size === all.length;
  const safe = (value: string): boolean => value.length > 0 && value.length <= 40 && !/\p{Cc}/u.test(value);
  const left = unique && safe(all[start]!) ? all[start]! : String(start + 1);
  const right = unique && safe(all[end]!) ? all[end]! : String(end + 1);
  return start === end ? left : `${left}-${right}`;
}

function atomicIntervals(assignments: readonly AssignedBlock[]): Array<{ start: number; end: number }> {
  return assignments.flatMap(({ pages }) => {
    const start = pages[0] ?? 0;
    const end = pages.at(-1) ?? start;
    return end > start ? [{ start, end }] : [];
  });
}

function rangedSegments(
  pageCount: number,
  target: number,
  intervals: readonly { start: number; end: number }[],
): Segment[] {
  const result: Segment[] = [];
  for (let start = 0; start < pageCount;) {
    let end = Math.min(pageCount - 1, start + target - 1);
    let changed = true;
    while (changed) {
      changed = false;
      for (const interval of intervals) {
        if (interval.start <= end && interval.end > end) {
          end = interval.end;
          changed = true;
        }
      }
    }
    if (end - start + 1 > PDF_SPLIT_ABSOLUTE_SOURCE_PAGE_LIMIT) {
      splitInvalid("An atomic table, figure, list, or fallback group exceeds the 40-source-page content limit.", {
        start: start + 1,
        end: end + 1,
      });
    }
    result.push({ start, end, basis: "page-range" });
    start = end + 1;
  }
  return result;
}

function headingSegments(
  rootTitle: string,
  pageCount: number,
  assignments: readonly AssignedBlock[],
  maximumLevel: number,
): Segment[] {
  const headings = assignments.flatMap(({ block, pages }) =>
    block.type === "heading" && block.level <= maximumLevel
      ? [{ page: pages[0] ?? 0, level: block.level, title: text(block) }]
      : []
  ).filter((heading) => heading.title.length > 0)
    .sort((a, b) => a.page - b.page || a.level - b.level);
  const onePerPage = headings.filter((heading, index) => index === 0 || headings[index - 1]!.page !== heading.page);
  if (onePerPage.length === 0) return [];
  const starts = [...new Set([0, ...onePerPage.map((heading) => heading.page)])].sort((a, b) => a - b);
  return starts.map((start, index) => {
    const heading = onePerPage.find((candidate) => candidate.page === start);
    return {
      start,
      end: (starts[index + 1] ?? pageCount) - 1,
      basis: heading ? "heading" : "preamble",
      title: heading?.title ?? `${rootTitle} - Introduction`,
      level: heading?.level ?? 1,
    };
  });
}

function mergeAcrossAtomicIntervals(
  segments: Segment[],
  intervals: readonly { start: number; end: number }[],
): { segments: Segment[]; shifts: number } {
  const result = [...segments];
  let shifts = 0;
  for (const interval of intervals) {
    const first = result.findIndex((segment) => segment.start <= interval.start && segment.end >= interval.start);
    const last = result.findIndex((segment) => segment.start <= interval.end && segment.end >= interval.end);
    if (first >= 0 && last > first) {
      result[first] = { ...result[first]!, end: result[last]!.end };
      result.splice(first + 1, last - first);
      shifts += 1;
    }
  }
  return { segments: result, shifts };
}

function subdivideSegments(
  segments: readonly Segment[],
  target: number,
  intervals: readonly { start: number; end: number }[],
): Segment[] {
  return segments.flatMap((segment) => {
    if (segment.end - segment.start + 1 <= target) return [segment];
    const local = rangedSegments(segment.end - segment.start + 1, target, intervals
      .filter((interval) => interval.start >= segment.start && interval.end <= segment.end)
      .map((interval) => ({ start: interval.start - segment.start, end: interval.end - segment.start })));
    const subdivided: Segment[] = local.map((part, index) => ({
      ...part,
      start: part.start + segment.start,
      end: part.end + segment.start,
      basis: index === 0 ? segment.basis : "page-range",
      ...(index === 0 ? { title: segment.title, level: segment.level } : {}),
    }));
    for (const child of subdivided.slice(1)) child.parentSegment = subdivided[0];
    return subdivided;
  });
}

function documentFor(
  source: ImportDocumentV2,
  assignments: readonly AssignedBlock[],
  start: number,
  end: number,
): ImportDocumentV2 {
  const blocks = assignments.filter(({ pages }) => pages.some((page) => page >= start && page <= end)).map(({ block }) => block);
  const ids = assetIds(blocks);
  return { ...source, blocks, assets: source.assets.filter((asset) => ids.has(asset.id)) };
}

async function plannedPage(
  id: string,
  title: string,
  basis: PdfSplitBasisV1,
  facts: PdfFactsV1,
  document: ImportDocumentV2,
  sourcePageIndexes: number[],
): Promise<PdfPlannedPageV1> {
  const adf = documentToAdf(document);
  const storage = documentToStorage(document);
  const assessment = assessEditability(document.blocks);
  return {
    id,
    title,
    sourcePageIndexes,
    sourcePageLabels: pageLabels(facts, sourcePageIndexes),
    splitBasis: basis,
    blocks: document.blocks,
    assets: document.assets,
    children: [],
    estimate: {
      adfBytes: new TextEncoder().encode(JSON.stringify(adf)).byteLength,
      storageBytes: new TextEncoder().encode(storage).byteLength,
      nodes: assessment.nodeCount,
      tableCells: assessment.tableCells,
      assets: document.assets.length,
      editability: assessment.level,
    },
    bodyDigest: await digestPdfCanonical({ adf, storage }),
  };
}

function resolveTitles(pages: readonly PdfPlannedPageV1[], mode: "fail" | "rename"): void {
  const used = new Set<string>();
  const visit = (page: PdfPlannedPageV1): void => {
    const original = page.title;
    let key = original.normalize("NFC").toLocaleLowerCase("en-US");
    if (used.has(key)) {
      if (mode === "fail") splitInvalid(`PDF split would create duplicate title ${JSON.stringify(page.title)}.`);
      let suffix = 2;
      do {
        page.title = `${original} (${suffix++})`;
        key = page.title.normalize("NFC").toLocaleLowerCase("en-US");
      } while (used.has(key));
    }
    used.add(key);
    page.children.forEach(visit);
  };
  pages.forEach(visit);
}

function publicPage(page: PdfPlannedPageV1): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    sourcePageIndexes: page.sourcePageIndexes,
    sourcePageLabels: page.sourcePageLabels,
    splitBasis: page.splitBasis,
    estimate: page.estimate,
    bodyDigest: page.bodyDigest,
    assetDigests: page.assets.map((asset) => asset.id).sort(),
    children: page.children.map(publicPage),
  };
}

function indexList(pages: readonly PdfPlannedPageV1[], prefix: string): ImportListBlock {
  return {
    id: `${prefix}:list`,
    type: "list",
    ordered: false,
    items: pages.map((page, index) => ({
      blocks: [{
        id: `${prefix}:item:${index}`,
        type: "paragraph",
        runs: [{
          kind: "text",
          text: page.title,
          marks: { reference: { namespace: "pdf-page", target: page.id } },
        }],
      }],
      ...(page.children.length > 0 ? { child: indexList(page.children, `${prefix}:item:${index}`) } : {}),
    })),
  };
}

async function populateRootIndex(root: PdfPlannedPageV1, source: ImportDocumentV2): Promise<void> {
  const blocks: ImportBlock[] = [
    { id: "pdf:index:heading", type: "heading", level: 2, runs: [{ kind: "text", text: "Contents" }] },
    indexList(root.children, "pdf:index"),
  ];
  const document: ImportDocumentV2 = { ...source, titleCandidate: undefined, blocks, assets: [], issues: [] };
  const adf = documentToAdf(document);
  const storage = documentToStorage(document);
  const assessment = assessEditability(blocks);
  root.blocks = blocks;
  root.assets = [];
  root.estimate = {
    adfBytes: new TextEncoder().encode(JSON.stringify(adf)).byteLength,
    storageBytes: new TextEncoder().encode(storage).byteLength,
    nodes: assessment.nodeCount,
    tableCells: assessment.tableCells,
    assets: 0,
    editability: assessment.level,
  };
  root.bodyDigest = await digestPdfCanonical({ adf, storage });
}

export async function planPdfSplit(
  facts: PdfFactsV1,
  document: ImportDocumentV2,
  evidence: readonly PdfDecisionEvidenceV1[],
  options: {
    rootTitle: string;
    policy: PdfSplitPolicyV1;
    titleConflict?: "fail" | "rename";
  },
): Promise<PdfSplitPlanV1> {
  if (facts.pageCount < 1 || facts.pages.length !== facts.pageCount) {
    throw new PdfImportError("pdf/incomplete", "Split planning requires complete page facts.");
  }
  const assignments = assignBlocks(document, evidence, facts.pageCount);
  const intervals = atomicIntervals(assignments);
  const whole = documentFor(document, assignments, 0, facts.pageCount - 1);
  const wholeAssessment = assessEditability(whole.blocks);
  const mode = options.policy.mode;
  const single = mode.kind === "off"
    || (mode.kind === "auto"
      && facts.pageCount <= options.policy.autoSinglePageMaxSourcePages
      && wholeAssessment.level === "ok");
  if (mode.kind === "off" && facts.pageCount > options.policy.absoluteSinglePageMaxSourcePages) {
    splitInvalid("--split off cannot place more than 40 source pages on one wiki page.", { pages: facts.pageCount });
  }
  if (mode.kind === "off" && wholeAssessment.level === "risk") {
    splitInvalid("--split off exceeds the target editability risk budget; use auto or pages:<5..40>.");
  }
  const issues: PdfSplitPlanV1["issues"] = [];
  const blockers: string[] = [];
  let root: PdfPlannedPageV1;
  let resolved: PdfSplitPlanV1["resolved"];
  const contentPages: PdfPlannedPageV1[] = [];
  if (single) {
    root = await plannedPage(
      "pdf-page-root",
      options.rootTitle,
      "size-budget",
      facts,
      whole,
      Array.from({ length: facts.pageCount }, (_, index) => index),
    );
    contentPages.push(root);
    resolved = {
      kind: "single-page",
      reason: mode.kind === "off" ? "explicit-off" : "short-and-editable",
    };
  } else {
    let segments: Segment[];
    if (mode.kind === "pages") {
      segments = rangedSegments(facts.pageCount, mode.targetSourcePages, intervals);
      const shifted = segments.filter((segment, index) =>
        segment.end - segment.start + 1 > mode.targetSourcePages && index < segments.length - 1
      ).length;
      if (shifted > 0) issues.push({
        code: "pdf-import/split-boundary-shifted",
        message: "A page-range boundary moved to keep an atomic table, figure, list, or fallback group intact.",
        context: { occurrences: shifted },
      });
      resolved = { kind: "page-tree", reason: "page-range" };
    } else {
      const headingLevel = mode.kind === "heading" ? mode.level : 6;
      segments = headingSegments(options.rootTitle, facts.pageCount, assignments, headingLevel);
      if (mode.kind === "heading" && segments.length === 0) {
        splitInvalid("The requested heading split has no qualifying recovered headings; use auto or pages:<5..40>.");
      }
      if (segments.length === 0) segments = rangedSegments(facts.pageCount, PDF_SPLIT_DEFAULT_TARGET_PAGES, intervals);
      const merged = mergeAcrossAtomicIntervals(segments, intervals);
      segments = merged.segments;
      if (merged.shifts > 0) issues.push({
        code: "pdf-import/split-boundary-shifted",
        message: "A split boundary moved to keep an atomic table, figure, list, or fallback group intact.",
        context: { occurrences: merged.shifts },
      });
      if (mode.kind === "heading") {
        const oversized = segments.find((segment) => segment.end - segment.start + 1 > PDF_SPLIT_ABSOLUTE_SOURCE_PAGE_LIMIT);
        if (oversized) splitInvalid("A heading leaf exceeds 40 source pages; use auto or pages:<5..40>.");
      } else segments = subdivideSegments(segments, PDF_SPLIT_DEFAULT_TARGET_PAGES, intervals);
      resolved = { kind: "page-tree", reason: mode.kind === "heading" ? "heading" : "auto-long-or-complex" };
    }
    const empty: ImportDocumentV2 = { ...document, titleCandidate: undefined, blocks: [], assets: [] };
    root = await plannedPage("pdf-page-root", options.rootTitle, "root-index", facts, empty, []);
    const stack: Array<{ level: number; page: PdfPlannedPageV1 }> = [];
    for (const [index, segment] of segments.entries()) {
      const pages = Array.from({ length: segment.end - segment.start + 1 }, (_, offset) => segment.start + offset);
      const title = segment.title ?? `${options.rootTitle} - Pages ${safeRangeLabel(facts, segment.start, segment.end)}`;
      const page = await plannedPage(
        `pdf-page-${String(segment.start + 1).padStart(3, "0")}-${String(segment.end + 1).padStart(3, "0")}`,
        title,
        segment.basis,
        facts,
        documentFor(document, assignments, segment.start, segment.end),
        pages,
      );
      segment.page = page;
      contentPages.push(page);
      const level = segment.level ?? 1;
      while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop();
      const parent = segment.parentSegment?.page ?? stack.at(-1)?.page ?? root;
      parent.children.push(page);
      if (!segment.parentSegment && segment.basis === "heading") stack.push({ level, page });
      if (page.sourcePageIndexes.length > PDF_SPLIT_ABSOLUTE_SOURCE_PAGE_LIMIT) {
        blockers.push(`${page.title}: exceeds the 40-source-page content limit.`);
      }
      if (page.estimate.editability === "risk") blockers.push(`${page.title}: target editability is risk.`);
      if (index === 0 && segment.basis === "preamble") issues.push({
        code: "pdf-import/split-preamble-child",
        message: "Preamble content is assigned to an explicit introductory child; the root remains a compact index.",
      });
    }
    resolveTitles([root], options.titleConflict ?? "fail");
    await populateRootIndex(root, document);
  }
  const sourceAssignments = contentPages.flatMap((page) =>
    page.sourcePageIndexes.map((pageIndex) => ({ pageIndex, plannedPageId: page.id }))
  ).sort((a, b) => a.pageIndex - b.pageIndex);
  const assigned = sourceAssignments.map((item) => item.pageIndex);
  if (assigned.length !== facts.pageCount || assigned.some((page, index) => page !== index)) {
    throw new PdfImportError("pdf/incomplete", "Split planning duplicated or omitted one or more source pages.");
  }
  const totalWikiPages = resolved.kind === "single-page" ? 1 : contentPages.length + 1;
  if (totalWikiPages > PDF_SPLIT_ABSOLUTE_MAX_WIKI_PAGES) {
    splitInvalid(`Resolved PDF tree exceeds the absolute ${PDF_SPLIT_ABSOLUTE_MAX_WIKI_PAGES}-page transaction limit.`, {
      pages: totalWikiPages,
    });
  }
  if (totalWikiPages > options.policy.maxWikiPages) {
    blockers.push(
      `Resolved PDF tree has ${totalWikiPages} wiki pages, above --max-wiki-pages ${options.policy.maxWikiPages}.`,
    );
  }
  const digestInput = {
    schema: PDF_SPLIT_PLAN_SCHEMA_V1,
    requested: options.policy,
    resolved,
    root: publicPage(root),
    contentPageCount: contentPages.length,
    totalWikiPages,
    sourceAssignments,
    issues,
    blockers,
  };
  return { ...digestInput, root, digest: await digestPdfCanonical(digestInput) };
}

export function summarizePdfPlannedPage(page: PdfPlannedPageV1): Record<string, unknown> {
  return publicPage(page);
}

/**
 * Derive the exact publication plan after remote title preflight. The user
 * explicitly selected `title-conflict=rename`; source assignments, page ids,
 * blocks and assets remain unchanged, while the root index and plan digest are
 * rebound to the deterministic target titles.
 */
export async function derivePdfSplitTitleRenames(
  plan: PdfSplitPlanV1,
  renames: ReadonlyMap<string, string>,
): Promise<PdfSplitPlanV1> {
  const clone = (page: PdfPlannedPageV1): PdfPlannedPageV1 => ({
    ...page,
    title: renames.get(page.id) ?? page.title,
    blocks: [...page.blocks],
    assets: [...page.assets],
    children: page.children.map(clone),
    sourcePageIndexes: [...page.sourcePageIndexes],
    sourcePageLabels: [...page.sourcePageLabels],
    estimate: { ...page.estimate },
  });
  const root = clone(plan.root);
  await populateRootIndex(root, {
    schema: "atlcli.import-document/2",
    sourceKind: "pdf",
    blocks: [],
    assets: [],
    issues: [],
  });
  const digestInput = {
    schema: plan.schema,
    requested: plan.requested,
    resolved: plan.resolved,
    root: publicPage(root),
    contentPageCount: plan.contentPageCount,
    totalWikiPages: plan.totalWikiPages,
    sourceAssignments: plan.sourceAssignments,
    issues: plan.issues,
    blockers: plan.blockers,
  };
  return { ...plan, root, digest: await digestPdfCanonical(digestInput) };
}
