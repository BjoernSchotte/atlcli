import {
  formatAdfDateTimestamp,
  inlineMediaDisplayText,
  mediaFallbackDisplayText,
  mentionDisplayText,
  resolveCalloutIcon,
  smartCardDisplayText,
  statusDisplayText,
  type AdfAnnotationIdentity,
} from "@atlcli/confluence";
import type { TemplateManifest } from "@atlcli/template-pack";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
import { PDF_FONT_COVERAGE_V1 } from "./font-coverage.generated.js";
import { PDF_RUNTIME_ASSETS, type PdfRuntimeFontAsset } from "./runtime-assets.js";
import type { ResolvedPdfSettings } from "./settings.js";
import type {
  PdfExportMetadata,
  PreparedPdfBlock,
  PreparedPdfCaption,
  PreparedPdfDocument,
  PreparedPdfInlineNode,
} from "./types.js";

export type PdfFontRequirementReasonKindV1 =
  | "document-style"
  | "fallback"
  | "full-bundle-conformance"
  | "renderer-synthetic"
  | "template-role";

export interface PdfFontRequirementReasonV1 {
  kind: PdfFontRequirementReasonKindV1;
  /** Stable renderer location or role; never contains document text. */
  detail: string;
}

export interface ResolvedPdfFontAssetRequirementV1 {
  assetId: string;
  source: "canonical" | "custom";
  family: string;
  style: "normal" | "italic";
  weight: number;
  sha256: string;
  fileName?: string;
  reasons: readonly PdfFontRequirementReasonV1[];
}

/**
 * Byte-free, URL-free semantic result transported with a prepared PDF bundle.
 * Hosts only map `assetId` to their statically discoverable asset adapter.
 */
export interface ResolvedPdfFontRequirementsV1 {
  schema: "atlcli.pdf-font-requirements/1";
  template: { id: string; version: string };
  /** Deterministic active-compiler cache key. */
  key: string;
  assets: readonly ResolvedPdfFontAssetRequirementV1[];
}

export interface ResolvePdfFontRequirementsInputV1 {
  document: PreparedPdfDocument;
  metadata: PdfExportMetadata;
  settings: ResolvedPdfSettings;
  manifest?: TemplateManifest;
}

interface TextDemand {
  value: string;
  family: string;
  reason: PdfFontRequirementReasonV1;
}

type FontStyle = PdfRuntimeFontAsset["style"];

const coverageByFile: ReadonlyMap<
  string,
  (typeof PDF_FONT_COVERAGE_V1)[number]
> = new Map(
  PDF_FONT_COVERAGE_V1.map((entry) => [entry.fileName, entry] as const),
);

function reasonKey(reason: PdfFontRequirementReasonV1): string {
  return `${reason.kind}:${reason.detail}`;
}

function weightNumber(weight: string | undefined): number {
  switch (weight) {
    case "medium":
      return 500;
    case "semibold":
      return 600;
    case "bold":
      return 700;
    case "regular":
    case undefined:
      return 400;
    default:
      return 400;
  }
}

function covers(asset: PdfRuntimeFontAsset, codePoint: number): boolean {
  const coverage = coverageByFile.get(asset.fileName);
  if (!coverage || coverage.sha256 !== asset.sha256) {
    throw new Error(
      `PDF font coverage metadata is missing or stale for ${asset.assetId}.`,
    );
  }
  let low = 0;
  let high = coverage.ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [start, end] = coverage.ranges[middle]!;
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

function faceCandidates(
  family: string,
  style: FontStyle,
  weight: number,
): PdfRuntimeFontAsset[] {
  const familyFaces = PDF_RUNTIME_ASSETS.fonts.filter(
    (asset) => asset.family === family,
  );
  const exact = familyFaces.filter(
    (asset) => asset.style === style && asset.weight === weight,
  );
  if (exact.length > 0) return exact;

  const sameStyle = familyFaces.filter((asset) => asset.style === style);
  const distances = sameStyle.map((asset) => Math.abs(asset.weight - weight));
  const nearestDistance = Math.min(...distances);
  const nearest = sameStyle.filter(
    (asset) => Math.abs(asset.weight - weight) === nearestDistance,
  );
  // Typst may synthesize a combined bold-italic request from either the italic
  // face or the requested normal weight. Retain both plausible candidates.
  if (style === "italic") {
    for (const asset of familyFaces) {
      if (
        asset.style === "normal" &&
        asset.weight === weight &&
        !nearest.includes(asset)
      ) {
        nearest.push(asset);
      }
    }
  }
  return nearest;
}

function annotationsOf(
  node: PreparedPdfInlineNode,
): readonly AdfAnnotationIdentity[] {
  return "annotations" in node ? (node.annotations ?? []) : [];
}

function annotationText(
  annotations: readonly AdfAnnotationIdentity[],
  addText: (
    value: string,
    family: string,
    style: FontStyle,
    weight: number,
    reason: PdfFontRequirementReasonV1,
  ) => void,
  bodyFamily: string,
): void {
  for (const annotation of annotations) {
    if (!annotation.comment) continue;
    addText(
      annotation.comment.bodyText,
      bodyFamily,
      "normal",
      400,
      { kind: "renderer-synthetic", detail: "comment-body" },
    );
    addText(
      annotation.comment.status === "resolved" ? "Resolved — " : "",
      bodyFamily,
      "normal",
      400,
      { kind: "renderer-synthetic", detail: "comment-status" },
    );
    for (const reply of annotation.comment.replies) {
      addText(
        `Reply: ${reply.bodyText}`,
        bodyFamily,
        "italic",
        400,
        { kind: "renderer-synthetic", detail: "comment-reply" },
      );
    }
  }
}

function exportedDateLabel(metadata: PdfExportMetadata): string {
  const requested = [metadata.language, metadata.region]
    .filter(Boolean)
    .join("-") || "en";
  try {
    return new Intl.DateTimeFormat(requested, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(metadata.exportedAt);
  } catch {
    return new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(metadata.exportedAt);
  }
}

export function resolvePdfFontRequirementsV1(
  input: ResolvePdfFontRequirementsInputV1,
): ResolvedPdfFontRequirementsV1 {
  const manifest = input.manifest ?? BUILTIN_PDF_TEMPLATE_MANIFEST;
  const design = input.settings.design;
  const familyFor = (role: "body" | "heading" | "mono"): string =>
    design.typography.fonts[role];
  const bodyFamily = familyFor("body");
  const headingFamily = familyFor("heading");
  const monoFamily = familyFor("mono");
  const reasonsByAsset = new Map<
    string,
    Map<string, PdfFontRequirementReasonV1>
  >();
  const textDemands: TextDemand[] = [];

  const addAsset = (
    asset: PdfRuntimeFontAsset,
    reason: PdfFontRequirementReasonV1,
  ): void => {
    const reasons = reasonsByAsset.get(asset.assetId) ?? new Map();
    reasons.set(reasonKey(reason), reason);
    reasonsByAsset.set(asset.assetId, reasons);
  };
  const addFace = (
    family: string,
    style: FontStyle,
    weight: number,
    reason: PdfFontRequirementReasonV1,
  ): void => {
    const candidates = faceCandidates(family, style, weight);
    if (candidates.length === 0) {
      throw new Error(
        `Resolved PDF template requires unavailable font face ${family} ${style} ${weight}.`,
      );
    }
    for (const candidate of candidates) addAsset(candidate, reason);
  };
  const addText = (
    value: string,
    family: string,
    style: FontStyle,
    weight: number,
    reason: PdfFontRequirementReasonV1,
  ): void => {
    if (value === "") return;
    addFace(family, style, weight, reason);
    textDemands.push({ value, family, reason });
  };
  const addRole = (
    roleName: string,
    inheritedFamily: string,
    reasonKind: PdfFontRequirementReasonKindV1 = "template-role",
  ): string => {
    const role = design.typography.roles[roleName];
    if (!role) {
      throw new Error(`Resolved PDF template is missing typography role "${roleName}".`);
    }
    const family = role.font ? familyFor(role.font) : inheritedFamily;
    addFace(family, "normal", weightNumber(role.weight), {
      kind: reasonKind,
      detail: roleName,
    });
    return family;
  };

  // Renderer-owned page furniture. These facts are reachable even when the
  // document body is empty, and therefore cannot come from a block-kind scan.
  addText(input.metadata.title, bodyFamily, "normal", 400, {
    kind: "template-role",
    detail: "body",
  });
  addFace(headingFamily, "normal", 400, {
    kind: "renderer-synthetic",
    detail: "page-furniture",
  });
  addRole("runningHead", headingFamily);
  addText(input.settings.headerText ?? input.metadata.title, headingFamily, "normal", 400, {
    kind: "renderer-synthetic",
    detail: "running-header",
  });
  addText(
    input.settings.footerText ?? input.settings.organizationName ?? "1",
    headingFamily,
    "normal",
    400,
    { kind: "renderer-synthetic", detail: "running-footer" },
  );

  if (input.settings.cover) {
    addRole("coverEyebrow", headingFamily);
    const coverTitleFamily = addRole("coverTitle", bodyFamily);
    addRole("coverMetaLabel", headingFamily);
    addRole("coverMetaValue", headingFamily);
    addText(input.metadata.title, coverTitleFamily, "normal", weightNumber(
      design.typography.roles.coverTitle?.weight,
    ), { kind: "renderer-synthetic", detail: "cover-title" });
    addText(
      [
        input.settings.organizationName,
        input.metadata.space ?? "Confluence",
        input.metadata.version === undefined ? "—" : `v${input.metadata.version}`,
        exportedDateLabel(input.metadata),
        input.metadata.exporter ?? input.metadata.author ?? "atlcli",
      ].filter((value): value is string => value !== undefined).join(" "),
      headingFamily,
      "normal",
      400,
      { kind: "renderer-synthetic", detail: "cover-metadata" },
    );
  }

  addRole("closingEyebrow", headingFamily);
  const closingTitleFamily = addRole("closingTitle", bodyFamily);
  addRole("closingMetaLabel", headingFamily);
  addRole("closingMetaValue", headingFamily);
  addRole("colophon", headingFamily);
  addFace(headingFamily, "normal", 600, {
    kind: "renderer-synthetic",
    detail: "closing-colophon-link",
  });
  addText(input.metadata.title, closingTitleFamily, "normal", weightNumber(
    design.typography.roles.closingTitle?.weight,
  ), { kind: "renderer-synthetic", detail: "closing-title" });
  addText(
    Object.values(input.settings.labels).join(" "),
    headingFamily,
    "normal",
    400,
    { kind: "renderer-synthetic", detail: "localized-labels" },
  );
  if (input.settings.watermark) {
    addText(
      input.settings.watermark.text,
      headingFamily,
      "normal",
      700,
      { kind: "renderer-synthetic", detail: "watermark" },
    );
  }

  const walkCaption = (caption: PreparedPdfCaption | undefined): void => {
    if (caption) walkInline(caption.content, bodyFamily, "caption");
  };
  const walkInline = (
    nodes: PreparedPdfInlineNode[],
    inheritedFamily: string,
    location: string,
  ): void => {
    for (const node of nodes) {
      switch (node.type) {
        case "text": {
          const marks = new Set(node.marks ?? []);
          const family = marks.has("code") ? monoFamily : inheritedFamily;
          const style = marks.has("italic") && !marks.has("code")
            ? "italic"
            : "normal";
          const weight = marks.has("bold") ? 700 : 400;
          addText(node.text, family, style, weight, {
            kind: "document-style",
            detail: marks.has("code")
              ? `${location}:inline-code`
              : `${location}:${style}-${weight}`,
          });
          annotationText(annotationsOf(node), addText, bodyFamily);
          break;
        }
        case "link":
          walkInline(node.content, inheritedFamily, `${location}:link`);
          break;
        case "mention":
          addText(`@${mentionDisplayText(node)}`, inheritedFamily, "normal", 400, {
            kind: "document-style",
            detail: `${location}:mention`,
          });
          break;
        case "date":
          addText(
            formatAdfDateTimestamp(
              node.timestamp,
              [input.metadata.language, input.metadata.region]
                .filter(Boolean)
                .join("-") || "en",
            ),
            inheritedFamily,
            "normal",
            400,
            { kind: "renderer-synthetic", detail: `${location}:date` },
          );
          break;
        case "status":
          addText(statusDisplayText(node), monoFamily, "normal", 700, {
            kind: "document-style",
            detail: `${location}:status`,
          });
          break;
        case "smartCard":
          addText(
            smartCardDisplayText(node.card),
            inheritedFamily,
            "normal",
            400,
            { kind: "document-style", detail: `${location}:smart-card` },
          );
          break;
        case "media":
          if (!node.assetPath) {
            addText(
              `[${inlineMediaDisplayText(node)}]`,
              inheritedFamily,
              "normal",
              400,
              { kind: "renderer-synthetic", detail: `${location}:media-fallback` },
            );
          }
          annotationText(annotationsOf(node), addText, bodyFamily);
          break;
        case "placeholder":
        case "lineBreak":
          break;
      }
    }
  };
  const walkBlocks = (
    blocks: PreparedPdfBlock[],
    inheritedFamily: string,
    location: string,
  ): void => {
    for (const [index, block] of blocks.entries()) {
      const path = `${location}.${index}.${block.type}`;
      switch (block.type) {
        case "heading": {
          const role = `h${Math.min(block.level, 3)}`;
          const family = addRole(role, headingFamily);
          walkInline(block.content, family, path);
          break;
        }
        case "paragraph": {
          const family = block.presentation?.fontSize === "small"
            ? addRole("adfSmallText", inheritedFamily)
            : inheritedFamily;
          walkInline(block.content, family, path);
          break;
        }
        case "smartCard":
          addText(
            smartCardDisplayText(block.card),
            inheritedFamily,
            "normal",
            400,
            { kind: "document-style", detail: path },
          );
          break;
        case "codeBlock":
          addText(block.code, monoFamily, "normal", 400, {
            kind: "document-style",
            detail: `${path}:code`,
          });
          if (block.title) {
            addText(block.title, inheritedFamily, "normal", 700, {
              kind: "document-style",
              detail: `${path}:title`,
            });
          }
          walkCaption(block.caption);
          break;
        case "diagram":
          if (block.title) {
            addText(block.title, inheritedFamily, "normal", 700, {
              kind: "document-style",
              detail: `${path}:title`,
            });
          }
          walkCaption(block.caption);
          break;
        case "callout": {
          const icon = resolveCalloutIcon(block);
          if (icon) {
            addText(
              icon.source === "explicit" ? icon.text : icon.icon.symbol,
              headingFamily,
              "normal",
              600,
              { kind: "renderer-synthetic", detail: `${path}:callout-icon` },
            );
          }
          if (block.title) {
            addText(block.title, headingFamily, "normal", 600, {
              kind: "document-style",
              detail: `${path}:title`,
            });
          }
          walkBlocks(block.content, headingFamily, path);
          break;
        }
        case "expand":
          if (block.title) {
            addText(block.title, inheritedFamily, "normal", 400, {
              kind: "document-style",
              detail: `${path}:title`,
            });
          }
          walkBlocks(block.content, inheritedFamily, path);
          break;
        case "list":
          if (block.ordered) addRole("numbering", headingFamily);
          else {
            addText("—•◦", headingFamily, "normal", 400, {
              kind: "renderer-synthetic",
              detail: `${path}:list-markers`,
            });
          }
          for (const [itemIndex, item] of block.items.entries()) {
            if (item.kind === "task" || block.listKind === "task") {
              const family = addRole("taskMarker", headingFamily);
              addText("☐☑", family, "normal", weightNumber(
                design.typography.roles.taskMarker?.weight,
              ), { kind: "renderer-synthetic", detail: `${path}:task-marker` });
            } else if (item.kind === "decision" || block.listKind === "decision") {
              const family = addRole("taskMarker", headingFamily);
              addText("◆◇", family, "normal", weightNumber(
                design.typography.roles.taskMarker?.weight,
              ), { kind: "renderer-synthetic", detail: `${path}:decision-marker` });
            }
            walkBlocks(item.content, inheritedFamily, `${path}.item${itemIndex}`);
          }
          break;
        case "layout":
          for (const [columnIndex, column] of block.columns.entries()) {
            walkBlocks(
              column.content,
              inheritedFamily,
              `${path}.column${columnIndex}`,
            );
          }
          break;
        case "table": {
          const cellFamily = addRole("tableCell", headingFamily);
          walkCaption(block.caption);
          for (const [rowIndex, row] of block.rows.entries()) {
            for (const [cellIndex, cell] of row.cells.entries()) {
              walkBlocks(
                cell.content,
                cellFamily,
                `${path}.row${rowIndex}.cell${cellIndex}`,
              );
            }
          }
          break;
        }
        case "image":
          if (!block.assetPath) {
            addText(block.fallbackLabel, inheritedFamily, "normal", 400, {
              kind: "renderer-synthetic",
              detail: `${path}:image-fallback`,
            });
          }
          walkCaption(block.caption);
          annotationText(block.annotations ?? [], addText, bodyFamily);
          break;
        case "mediaFallback":
          addText(
            mediaFallbackDisplayText(block),
            inheritedFamily,
            "normal",
            400,
            { kind: "renderer-synthetic", detail: `${path}:media-fallback` },
          );
          walkCaption(block.caption);
          annotationText(block.annotations ?? [], addText, bodyFamily);
          break;
        case "blockquote":
        case "orientation":
          walkBlocks(block.content, inheritedFamily, path);
          break;
        case "unknown":
          if (block.body) walkBlocks(block.body, inheritedFamily, `${path}.body`);
          for (const [frameIndex, frame] of (block.extensionFrames ?? []).entries()) {
            walkBlocks(frame.content, inheritedFamily, `${path}.frame${frameIndex}`);
          }
          if (!block.body && block.plainBodyHighlight) {
            addText(
              block.plainBodyHighlight.lines
                .flatMap((line) => line.map((token) => token.text))
                .join("\n"),
              monoFamily,
              "normal",
              400,
              { kind: "document-style", detail: `${path}:plain-body-code` },
            );
          } else if (!block.body && (block.extensionFrames?.length ?? 0) === 0) {
            addText(
              `Unsupported macro: ${block.macroName}`,
              inheritedFamily,
              "italic",
              400,
              { kind: "renderer-synthetic", detail: `${path}:placeholder` },
            );
          }
          break;
        case "divider":
        case "pageBreak":
        case "anchor":
          break;
      }
    }
  };

  walkBlocks(input.document.blocks, bodyFamily, "blocks");

  const selectedPrimary = (): PdfRuntimeFontAsset[] =>
    PDF_RUNTIME_ASSETS.fonts.filter(
      (asset) =>
        reasonsByAsset.has(asset.assetId) &&
        asset.family !== "Noto Sans Symbols2" &&
        asset.family !== "Noto Emoji",
    );
  const fallbackOrder = ["Noto Sans Symbols2", "Noto Emoji"] as const;
  for (const demand of textDemands) {
    const primary = selectedPrimary().filter(
      (asset) => asset.family === demand.family,
    );
    for (const character of demand.value) {
      const codePoint = character.codePointAt(0)!;
      if (primary.some((asset) => covers(asset, codePoint))) continue;
      for (const fallbackFamily of fallbackOrder) {
        const fallback = PDF_RUNTIME_ASSETS.fonts.find(
          (asset) =>
            asset.family === fallbackFamily && covers(asset, codePoint),
        );
        if (!fallback) continue;
        addAsset(fallback, {
          kind: "fallback",
          detail:
            fallbackFamily === "Noto Emoji"
              ? "unicode-emoji"
              : "unicode-symbol",
        });
        break;
      }
    }
  }

  const assets = PDF_RUNTIME_ASSETS.fonts
    .filter((asset) => reasonsByAsset.has(asset.assetId))
    .map((asset): ResolvedPdfFontAssetRequirementV1 => ({
      assetId: asset.assetId,
      source: "canonical",
      family: asset.family,
      style: asset.style,
      weight: asset.weight,
      sha256: asset.sha256,
      fileName: asset.fileName,
      reasons: [...reasonsByAsset.get(asset.assetId)!.values()].sort((left, right) =>
        reasonKey(left).localeCompare(reasonKey(right))
      ),
    }));
  return {
    schema: "atlcli.pdf-font-requirements/1",
    template: { id: manifest.id, version: manifest.version },
    key: assets
      .map((asset) => `${asset.assetId}@${asset.sha256}`)
      .join("|"),
    assets,
  };
}

export function resolveFullPdfFontRequirementsV1(
  manifest: TemplateManifest = BUILTIN_PDF_TEMPLATE_MANIFEST,
): ResolvedPdfFontRequirementsV1 {
  const reason: PdfFontRequirementReasonV1 = {
    kind: "full-bundle-conformance",
    detail: "explicit-full-canonical-bundle",
  };
  const assets = PDF_RUNTIME_ASSETS.fonts.map(
    (asset): ResolvedPdfFontAssetRequirementV1 => ({
      assetId: asset.assetId,
      source: "canonical",
      family: asset.family,
      style: asset.style,
      weight: asset.weight,
      sha256: asset.sha256,
      fileName: asset.fileName,
      reasons: [reason],
    }),
  );
  return {
    schema: "atlcli.pdf-font-requirements/1",
    template: { id: manifest.id, version: manifest.version },
    key: assets
      .map((asset) => `${asset.assetId}@${asset.sha256}`)
      .join("|"),
    assets,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertResolvedPdfFontRequirementsV1(
  value: unknown,
): asserts value is ResolvedPdfFontRequirementsV1 {
  if (!isRecord(value) || value.schema !== "atlcli.pdf-font-requirements/1") {
    throw new Error("Unsupported PDF font-requirement schema.");
  }
  if (
    !isRecord(value.template) ||
    typeof value.template.id !== "string" ||
    value.template.id === "" ||
    typeof value.template.version !== "string" ||
    value.template.version === "" ||
    typeof value.key !== "string" ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("Malformed PDF font-requirement contract.");
  }
  const assets = value.assets;
  if (value.key !== assets
    .map((asset) =>
      isRecord(asset) ? `${String(asset.assetId)}@${String(asset.sha256)}` : ""
    )
    .join("|")) {
    throw new Error("PDF font-requirement key does not match its ordered assets.");
  }
  const seen = new Set<string>();
  let previousCanonicalIndex = -1;
  for (const requirement of assets) {
    if (
      !isRecord(requirement) ||
      typeof requirement.assetId !== "string" ||
      (requirement.source !== "canonical" &&
        requirement.source !== "custom") ||
      typeof requirement.family !== "string" ||
      (requirement.style !== "normal" && requirement.style !== "italic") ||
      typeof requirement.weight !== "number" ||
      !Number.isFinite(requirement.weight) ||
      typeof requirement.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(requirement.sha256) ||
      !Array.isArray(requirement.reasons) ||
      requirement.reasons.some(
        (reason) =>
          !isRecord(reason) ||
          ![
            "document-style",
            "fallback",
            "full-bundle-conformance",
            "renderer-synthetic",
            "template-role",
          ].includes(String(reason.kind)) ||
          typeof reason.detail !== "string" ||
          reason.detail === "",
      )
    ) {
      throw new Error("Malformed PDF font asset requirement.");
    }
    if (seen.has(requirement.assetId)) {
      throw new Error(`Duplicate PDF font requirement ${requirement.assetId}.`);
    }
    seen.add(requirement.assetId);
    if (requirement.source === "custom") {
      // The type reserves custom identities for the approved FontSource path,
      // but current template-pack validation still rejects non-bundled fonts.
      throw new Error(
        `Custom PDF font requirement ${requirement.assetId} has no active host intake adapter.`,
      );
    }
    const canonicalIndex = PDF_RUNTIME_ASSETS.fonts.findIndex(
      (asset) => asset.assetId === requirement.assetId,
    );
    const canonical = PDF_RUNTIME_ASSETS.fonts[canonicalIndex];
    if (
      !canonical ||
      canonical.sha256 !== requirement.sha256 ||
      canonical.family !== requirement.family ||
      canonical.style !== requirement.style ||
      canonical.weight !== requirement.weight
    ) {
      throw new Error(
        `PDF font requirement ${requirement.assetId} does not match the canonical manifest.`,
      );
    }
    if (canonicalIndex <= previousCanonicalIndex) {
      throw new Error(
        "PDF font requirements are not in canonical manifest order.",
      );
    }
    previousCanonicalIndex = canonicalIndex;
  }
}
