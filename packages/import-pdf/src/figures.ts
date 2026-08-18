import { sha256Hex } from "@atlcli/core";
import {
  type ImportAsset,
  type ImportBlock,
  type ImportDocumentV2,
  type ImportIssue,
} from "@atlcli/import-core";
import {
  PDF_ASSET_MATERIALIZER_REVISION,
  PDF_FIGURE_POLICY_REVISION,
  type PdfAssetMaterializationRequestV1,
  type PdfDecisionEvidenceV1,
  type PdfFactsAdapter,
  type PdfFactsV1,
  type PdfMaterializedAssetV1,
  type PdfNormalizedRect,
  type PdfPageFactsV1,
  type PdfStructureNodeFact,
} from "./contracts.js";
import { digestPdfCanonical, digestPdfFacts } from "./canonical.js";
import { expandNormalizedRect, rectsTouch } from "./fallbacks.js";
import { PdfImportError } from "./issues.js";
import { taggedRuns } from "./links.js";
import { analyzeGeometryReadingOrder } from "./reading-order.js";
import { flattenStructure, structureRole } from "./structure.js";
import { analyzeUntaggedTable } from "./tables.js";
import { correlateTaggedText, unionRects } from "./text.js";
import { pageHasQualifiedDigitalLayout } from "./untagged.js";

export const PDF_FIGURE_SEMANTICS_SCHEMA_V1 = "atlcli.pdf-figure-semantics/1" as const;

export const PDF_FIGURE_POLICY_V1 = Object.freeze({
  renderDpi: 144,
  maximumAspectRatioError: 0.08,
  visualJoinGap: 0.012,
  minimumVectorWidth: 0.08,
  minimumVectorHeight: 0.05,
  captionMaximumGap: 0.14,
} as const);

export interface PdfFigureBaseSemanticsV1 {
  factsDigest: string;
  document: ImportDocumentV2;
  evidence: PdfDecisionEvidenceV1[];
}

export interface PdfFigureDecisionV1 {
  sourceId: string;
  pageIndex: number;
  blockId: string;
  assetId: string;
  mode: "native-raster" | "rendered-region" | "table-region-fallback";
  bbox: PdfNormalizedRect;
  captionBlockId?: string;
  authorAlt: boolean;
  sha256: string;
}

export interface PdfFigureSemanticsV1 {
  schema: typeof PDF_FIGURE_SEMANTICS_SCHEMA_V1;
  factsDigest: string;
  policyRevision: typeof PDF_FIGURE_POLICY_REVISION;
  document: ImportDocumentV2;
  evidence: PdfDecisionEvidenceV1[];
  figures: PdfFigureDecisionV1[];
  semanticDigest: string;
}

interface VisualCandidate {
  sourceId: string;
  sourceRefs: string[];
  pageIndex: number;
  bbox: PdfNormalizedRect;
  request: PdfAssetMaterializationRequestV1;
  mode: PdfFigureDecisionV1["mode"];
  alt?: string;
  captionBlock?: ImportBlock;
  captionBlockId?: string;
}

interface VisualItem {
  id: string;
  kind: "image" | "path";
  bbox: PdfNormalizedRect;
  objectId?: string;
}

function visualOrder(
  a: { pageIndex?: number; bbox: PdfNormalizedRect },
  b: { pageIndex?: number; bbox: PdfNormalizedRect },
): number {
  const page = (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
  if (page !== 0) return page;
  if (Math.abs(a.bbox.y - b.bbox.y) <= 0.03) return a.bbox.x - b.bbox.x || a.bbox.y - b.bbox.y;
  return a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x;
}

function aspectMatches(page: PdfPageFactsV1, image: PdfPageFactsV1["images"][number]): boolean {
  if (!image.bbox || image.pixelWidth < 1 || image.pixelHeight < 1 || image.bbox.height <= 0) return false;
  const placed = (image.bbox.width * page.widthPoints) / (image.bbox.height * page.heightPoints);
  const pixels = image.pixelWidth / image.pixelHeight;
  return Math.abs(placed - pixels) / Math.max(placed, pixels) <= PDF_FIGURE_POLICY_V1.maximumAspectRatioError;
}

function taggedCandidates(page: PdfPageFactsV1): VisualCandidate[] {
  const candidates: VisualCandidate[] = [];
  const figures = flattenStructure(page.structures).filter((node) => structureRole(node) === "Figure");
  for (const figure of figures) {
    const ownMcids = new Set([...figure.mcids, ...figure.childMcids]);
    const images = page.images.filter((image) => image.mcid !== null && ownMcids.has(image.mcid));
    const paths = page.paths.filter((path) => path.mcid !== null && ownMcids.has(path.mcid));
    const bbox = unionRects([...images.map((image) => image.bbox), ...paths.map((path) => path.bbox)]);
    if (!bbox) continue;
    const caption = figure.children.find((child) => structureRole(child) === "Caption");
    const captionText = caption ? correlateTaggedText(page, caption) : null;
    const captionBlockId = captionText?.text ? `${caption!.id}:caption` : undefined;
    const direct = images.length === 1 && paths.length === 0 && aspectMatches(page, images[0]!);
    const sourceId = figure.id;
    candidates.push({
      sourceId,
      sourceRefs: [figure.id, ...images.map((image) => image.id), ...paths.map((path) => path.id)],
      pageIndex: page.index,
      bbox: direct ? bbox : expandNormalizedRect(bbox),
      request: direct
        ? {
            id: `${sourceId}:asset`,
            pageIndex: page.index,
            kind: "image-object",
            objectId: images[0]!.id,
          }
        : {
            id: `${sourceId}:asset`,
            pageIndex: page.index,
            kind: "rendered-region",
            bbox: expandNormalizedRect(bbox),
            dpi: PDF_FIGURE_POLICY_V1.renderDpi,
          },
      mode: direct ? "native-raster" : "rendered-region",
      ...(figure.alt.trim() ? { alt: figure.alt.trim() } : {}),
      ...(captionBlockId && captionText ? {
        captionBlockId,
        captionBlock: {
          id: captionBlockId,
          type: "paragraph",
          runs: taggedRuns(
            captionText.characters,
            page.annotations,
            captionText.usedActualText ? captionText.text : undefined,
          ).runs,
          sourceRefs: [caption!.id],
        },
      } : {}),
    });
  }
  return candidates;
}

function visualComponents(items: readonly VisualItem[]): VisualItem[][] {
  const remaining = [...items];
  const components: VisualItem[][] = [];
  while (remaining.length > 0) {
    const component = [remaining.shift()!];
    for (let index = 0; index < remaining.length;) {
      if (component.some((item) => rectsTouch(item.bbox, remaining[index]!.bbox, PDF_FIGURE_POLICY_V1.visualJoinGap))) {
        component.push(remaining.splice(index, 1)[0]!);
        index = 0;
      } else index += 1;
    }
    components.push(component);
  }
  return components;
}

function untaggedCandidates(page: PdfPageFactsV1): VisualCandidate[] {
  if (!pageHasQualifiedDigitalLayout(page)) return [];
  const analysis = analyzeGeometryReadingOrder(page);
  const table = analyzeUntaggedTable(page, analysis);
  const tablePaths = new Set(
    table.mode === "native" && table.blocks[0]?.type === "table"
      ? table.blocks[0].sourceRefs ?? []
      : [],
  );
  const items: VisualItem[] = [
    ...page.images.flatMap((image) => image.bbox ? [{
      id: image.id,
      kind: "image" as const,
      bbox: image.bbox,
      objectId: image.id,
    }] : []),
    ...page.paths.flatMap((path) => path.bbox && !tablePaths.has(path.id) ? [{
      id: path.id,
      kind: "path" as const,
      bbox: path.bbox,
    }] : []),
  ];
  const candidates: VisualCandidate[] = [];
  const components = visualComponents(items)
    .map((component) => ({ component, bbox: unionRects(component.map((item) => item.bbox))! }))
    .filter(({ component, bbox }) =>
      component.some((item) => item.kind === "image")
      || (bbox.width >= PDF_FIGURE_POLICY_V1.minimumVectorWidth
        && bbox.height >= PDF_FIGURE_POLICY_V1.minimumVectorHeight)
    )
    .sort((a, b) => visualOrder(a, b));
  const captionFragments = analysis.fragments.filter((fragment) =>
    /^(?:figure|fig\.?|abbildung)\s*\d+/iu.test(fragment.text)
  );
  for (const [index, entry] of components.entries()) {
    const images = entry.component.filter((item) => item.kind === "image");
    const paths = entry.component.filter((item) => item.kind === "path");
    const imageFact = images.length === 1
      ? page.images.find((image) => image.id === images[0]!.id)
      : undefined;
    const direct = images.length === 1 && paths.length === 0 && imageFact && aspectMatches(page, imageFact);
    const sourceId = direct ? imageFact.id : `pdf:p${page.index}:visual:${index}`;
    const caption = captionFragments
      .map((fragment) => ({
        fragment,
        gap: fragment.bbox.y - (entry.bbox.y + entry.bbox.height),
      }))
      .filter(({ gap }) => gap >= -0.01 && gap <= PDF_FIGURE_POLICY_V1.captionMaximumGap)
      .sort((a, b) => a.gap - b.gap)[0]?.fragment;
    candidates.push({
      sourceId,
      sourceRefs: entry.component.map((item) => item.id),
      pageIndex: page.index,
      bbox: direct ? entry.bbox : expandNormalizedRect(entry.bbox),
      request: direct
        ? {
            id: `${sourceId}:asset`,
            pageIndex: page.index,
            kind: "image-object",
            objectId: imageFact.id,
          }
        : {
            id: `${sourceId}:asset`,
            pageIndex: page.index,
            kind: "rendered-region",
            bbox: expandNormalizedRect(entry.bbox),
            dpi: PDF_FIGURE_POLICY_V1.renderDpi,
          },
      mode: direct ? "native-raster" : "rendered-region",
      ...(caption ? { captionBlockId: `${caption.id}:paragraph` } : {}),
    });
  }
  return candidates;
}

function tableFallbackCandidates(base: PdfFigureBaseSemanticsV1): VisualCandidate[] {
  const byPage = new Map<number, PdfDecisionEvidenceV1[]>();
  for (const evidence of base.evidence) {
    if (!evidence.decisionCode.includes("table") || evidence.outcome !== "approximated" || !evidence.locator.bbox) continue;
    byPage.set(evidence.locator.pageIndex, [...(byPage.get(evidence.locator.pageIndex) ?? []), evidence]);
  }
  return [...byPage.entries()].flatMap(([pageIndex, evidence]) => {
    const bbox = unionRects(evidence.map((item) => item.locator.bbox));
    if (!bbox) return [];
    const sourceId = `pdf:p${pageIndex}:table-region-fallback`;
    const expanded = expandNormalizedRect(bbox);
    return [{
      sourceId,
      sourceRefs: evidence.map((item) => item.sourceId),
      pageIndex,
      bbox: expanded,
      request: {
        id: `${sourceId}:asset`,
        pageIndex,
        kind: "rendered-region" as const,
        bbox: expanded,
        dpi: PDF_FIGURE_POLICY_V1.renderDpi,
      },
      mode: "table-region-fallback" as const,
    }];
  });
}

function blockLocation(
  block: ImportBlock,
  evidence: readonly PdfDecisionEvidenceV1[],
): { pageIndex: number; y: number; x: number } {
  const refs = new Set([block.id, ...(block.sourceRefs ?? [])]);
  const matches = evidence.filter((item) =>
    refs.has(item.sourceId) || (item.targetNodeId ? refs.has(item.targetNodeId) : false)
  );
  const box = unionRects(matches.map((item) => item.locator.bbox));
  return {
    pageIndex: matches[0]?.locator.pageIndex ?? 0,
    y: box?.y ?? Number.MAX_SAFE_INTEGER,
    x: box?.x ?? 0,
  };
}

function mergeBlocks(
  baseBlocks: readonly ImportBlock[],
  additions: Array<{ block: ImportBlock; pageIndex: number; y: number; x: number }>,
  evidence: readonly PdfDecisionEvidenceV1[],
): ImportBlock[] {
  const tokens = [
    ...baseBlocks.map((block, index) => ({
      block: { ...block },
      ...blockLocation(block, evidence),
      order: index,
      kind: 1,
    })),
    ...additions.map((addition, index) => ({ ...addition, order: index, kind: 0 })),
  ].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    if (Math.abs(a.y - b.y) <= 0.03) return a.x - b.x || a.kind - b.kind || a.order - b.order;
    return a.y - b.y || a.x - b.x || a.kind - b.kind || a.order - b.order;
  });
  for (const token of tokens) delete token.block.pageBoundaryBefore;
  let previousPage = -1;
  for (const token of tokens) {
    if (token.pageIndex > 0 && token.pageIndex !== previousPage) token.block.pageBoundaryBefore = true;
    previousPage = token.pageIndex;
  }
  return tokens.map((token) => token.block);
}

function sanitizedDigestDocument(document: ImportDocumentV2, assets: readonly PdfMaterializedAssetV1[]) {
  const digests = new Map(assets.map((asset) => [asset.sha256, asset]));
  return {
    ...document,
    assets: document.assets.map((asset) => {
      const digest = asset.id.slice("pdf:asset:".length);
      const materialized = digests.get(digest);
      return {
        id: asset.id,
        sourceRefs: asset.sourceRefs,
        fileName: asset.fileName,
        mediaType: asset.mediaType,
        byteLength: asset.bytes.byteLength,
        sha256: digest,
        width: materialized?.width,
        height: materialized?.height,
      };
    }),
  };
}

export async function preservePdfFigures(
  facts: PdfFactsV1,
  factsDigest: string,
  sourceBytes: Uint8Array,
  adapter: PdfFactsAdapter,
  base: PdfFigureBaseSemanticsV1,
): Promise<PdfFigureSemanticsV1> {
  if (await digestPdfFacts(facts) !== factsDigest || base.factsDigest !== factsDigest) {
    throw new PdfImportError("pdf/provenance-drift", "Figure materialization facts differ from the reviewed semantics.");
  }
  if (await sha256Hex(sourceBytes) !== facts.inputSha256 || sourceBytes.byteLength !== facts.inputBytes) {
    throw new PdfImportError("pdf/provenance-drift", "Figure materialization bytes differ from the analyzed PDF.");
  }
  const candidates = [
    ...facts.pages.flatMap((page) => facts.tagged ? taggedCandidates(page) : untaggedCandidates(page)),
    ...tableFallbackCandidates(base),
  ].sort((a, b) => visualOrder(a, b) || a.sourceId.localeCompare(b.sourceId));
  const materialized = await adapter.materialize(sourceBytes, candidates.map((candidate) => candidate.request));
  if (materialized.length !== candidates.length) {
    throw new PdfImportError("pdf/incomplete", "PDF visual materialization did not return every requested asset.");
  }
  const byRequest = new Map(materialized.map((asset) => [asset.requestId, asset]));
  const documentAssets = new Map<string, ImportAsset>();
  const issues: ImportIssue[] = base.document.issues
    .filter((issue) => issue.code !== "pdf-import/tagged-figure-deferred")
    .map((issue) => ({ ...issue }));
  const evidence = base.evidence.filter((item) => item.decisionCode !== "pdf/tagged-figure-deferred");
  const additions: Array<{ block: ImportBlock; pageIndex: number; y: number; x: number }> = [];
  const figures: PdfFigureDecisionV1[] = [];
  for (const candidate of candidates) {
    const asset = byRequest.get(candidate.request.id);
    if (
      !asset
      || asset.materializerRevision !== PDF_ASSET_MATERIALIZER_REVISION
      || asset.mediaType !== "image/png"
      || await sha256Hex(asset.bytes) !== asset.sha256
    ) throw new PdfImportError("pdf/incomplete", "PDF visual asset failed digest or materializer verification.");
    const assetId = `pdf:asset:${asset.sha256}`;
    if (!documentAssets.has(assetId)) {
      documentAssets.set(assetId, {
        id: assetId,
        sourceRefs: [...candidate.sourceRefs],
        fileName: `pdf-p${String(candidate.pageIndex + 1).padStart(3, "0")}-${asset.sha256.slice(0, 12)}.png`,
        mediaType: "image/png",
        bytes: new Uint8Array(asset.bytes),
      });
    } else {
      const existing = documentAssets.get(assetId)!;
      existing.sourceRefs = [...new Set([...(existing.sourceRefs ?? []), ...candidate.sourceRefs])];
    }
    const blockId = `${candidate.sourceId}:image`;
    const block: ImportBlock = {
      id: blockId,
      type: "image",
      assetId,
      presentation: candidate.mode === "native-raster" ? "figure" : "region-fallback",
      ...(candidate.alt ? { alt: candidate.alt } : {}),
      ...(candidate.captionBlockId ? { captionBlockId: candidate.captionBlockId } : {}),
      sourceRefs: candidate.sourceRefs,
    };
    additions.push({
      block,
      pageIndex: candidate.pageIndex,
      y: candidate.bbox.y,
      x: candidate.bbox.x,
    });
    if (candidate.captionBlock) {
      const captionBox = unionRects(base.evidence
        .filter((item) => candidate.captionBlock!.sourceRefs?.includes(item.sourceId))
        .map((item) => item.locator.bbox));
      additions.push({
        block: candidate.captionBlock,
        pageIndex: candidate.pageIndex,
        y: captionBox?.y ?? candidate.bbox.y + candidate.bbox.height + 0.001,
        x: captionBox?.x ?? candidate.bbox.x,
      });
    }
    const attached = candidate.mode !== "native-raster";
    evidence.push({
      sourceId: candidate.sourceId,
      targetNodeId: blockId,
      locator: {
        pageIndex: candidate.pageIndex,
        bbox: candidate.bbox,
        ...(candidate.request.objectId ? { objectFingerprint: candidate.request.objectId } : {}),
      },
      basis: attached ? ["rendered-region"] : ["image-object"],
      confidence: attached ? 0.9 : 0.99,
      decisionCode: attached ? "pdf/figure-rendered-region-attached" : "pdf/figure-raster-native",
      outcome: attached ? "attached" : "native",
      analyzerRevision: PDF_FIGURE_POLICY_REVISION,
    });
    if (candidate.captionBlock) {
      evidence.push({
        sourceId: candidate.captionBlock.sourceRefs?.[0] ?? candidate.captionBlock.id,
        targetNodeId: candidate.captionBlock.id,
        locator: { pageIndex: candidate.pageIndex },
        basis: ["structure-tree", "marked-content"],
        confidence: 1,
        decisionCode: "pdf/figure-caption-native",
        outcome: "native",
        analyzerRevision: PDF_FIGURE_POLICY_REVISION,
      });
    }
    if (!candidate.alt && candidate.mode !== "table-region-fallback") {
      issues.push({
        code: "pdf-import/figure-alt-missing",
        severity: "warning",
        outcome: "reported",
        message: "The source figure has no author-provided alternative text; no alt text was invented.",
        sourceRefs: [candidate.sourceId],
        context: { pageIndex: candidate.pageIndex },
      });
    }
    if (attached) {
      issues.push({
        code: candidate.mode === "table-region-fallback"
          ? "pdf-import/table-region-fallback-attached"
          : "pdf-import/figure-rendered-region-attached",
        severity: "warning",
        outcome: "attached",
        message: candidate.mode === "table-region-fallback"
          ? "A rendered table region preserves visual fidelity alongside the linearized text."
          : "A vector, clipped, tiled, or composite visual was preserved as a bounded rendered region.",
        sourceRefs: [candidate.sourceId],
        context: { pageIndex: candidate.pageIndex, width: asset.width, height: asset.height },
      });
    }
    figures.push({
      sourceId: candidate.sourceId,
      pageIndex: candidate.pageIndex,
      blockId,
      assetId,
      mode: candidate.mode,
      bbox: candidate.bbox,
      ...(candidate.captionBlockId ? { captionBlockId: candidate.captionBlockId } : {}),
      authorAlt: Boolean(candidate.alt),
      sha256: asset.sha256,
    });
  }
  const document: ImportDocumentV2 = {
    ...base.document,
    blocks: mergeBlocks(base.document.blocks, additions, evidence),
    assets: [...base.document.assets, ...documentAssets.values()],
    issues,
  };
  const digestInput = {
    schema: PDF_FIGURE_SEMANTICS_SCHEMA_V1,
    factsDigest,
    policyRevision: PDF_FIGURE_POLICY_REVISION,
    document: sanitizedDigestDocument(document, materialized),
    evidence,
    figures,
  };
  return {
    schema: PDF_FIGURE_SEMANTICS_SCHEMA_V1,
    factsDigest,
    policyRevision: PDF_FIGURE_POLICY_REVISION,
    document,
    evidence,
    figures,
    semanticDigest: await digestPdfCanonical(digestInput),
  };
}
