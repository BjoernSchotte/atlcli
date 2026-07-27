import { sha256Hex } from "@atlcli/core";
import {
  DOCX_TEMPLATE_INTAKE_BUDGET,
  unzipDocx,
} from "@atlcli/docx/scan";
import {
  validateTemplateDiagnostic,
  validateTemplateImportProgressEvent,
  type TemplateDiagnosticV1,
  type TemplateImportProgressEventV1,
  type TemplateMessageRegistryV1,
} from "@atlcli/pdf-template-authoring";
import { canonicalIntakeJson } from "./canonical.js";
import {
  analyzeDocxOpcArchive,
  DOCX_INTAKE_MESSAGE_REGISTRY_V1,
  type DocxOpcFactsV1,
} from "./opc.js";
import {
  streamXmlPart,
  type XmlElementEventV1,
  type XmlPartScanV1,
} from "./streaming.js";

export const DOCX_TEMPLATE_FACTS_SCHEMA_V1 =
  "atlcli.docx-template-facts/1" as const;

const WORDPROCESSINGML_URIS = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const DRAWINGML_URIS = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
const DRAWING_WORD_URIS = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing",
]);
const RELATIONSHIP_URIS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const MCE_URI =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";
const VML_URI = "urn:schemas-microsoft-com:vml";

export interface MarkupCompatibilityProfileV1 {
  schema: "atlcli.docx-markup-compatibility-profile/1";
  id: "atlcli.word-pdf-template.v1";
  understoodNamespaces: readonly string[];
  understoodFeatures: readonly string[];
  alternateContentPolicy: "first-understood-choice-else-fallback";
}

export const MARKUP_COMPATIBILITY_PROFILE_V1: MarkupCompatibilityProfileV1 = {
  schema: "atlcli.docx-markup-compatibility-profile/1",
  id: "atlcli.word-pdf-template.v1",
  understoodNamespaces: [
    ...WORDPROCESSINGML_URIS,
    ...DRAWINGML_URIS,
    ...DRAWING_WORD_URIS,
    ...RELATIONSHIP_URIS,
    MCE_URI,
  ].sort(),
  understoodFeatures: [
    "mc.AlternateContent",
    "mc.Ignorable",
    "mc.MustUnderstand",
    "mc.PreserveAttributes",
    "mc.PreserveElements",
    "mc.ProcessContent",
  ],
  alternateContentPolicy: "first-understood-choice-else-fallback",
};

export const DOCX_FACTS_MESSAGE_REGISTRY_V1: TemplateMessageRegistryV1 = {
  schema: "wiki.pdf-template-message-registry/v1",
  id: "atlcli.docx-template-facts",
  version: 1,
  definitions: [
    "DOCX_INTAKE_MCE_ATTRIBUTE_UNSUPPORTED",
    "DOCX_INTAKE_MCE_MISSING_FALLBACK",
    "DOCX_INTAKE_MCE_MUST_UNDERSTAND",
    "DOCX_INTAKE_MCE_NESTED_ALTERNATE_CONTENT",
    "DOCX_INTAKE_MCE_UNKNOWN_REQUIRES",
    "DOCX_INTAKE_REVISIONS_PRESENT",
  ].map((code) => ({
    code,
    params: {
      feature: {
        type: "string" as const,
        maxLength: 64,
        format: "stable-id" as const,
      },
    },
  })),
};

export type DocxSemanticPartKindV1 =
  | "document"
  | "endnotes"
  | "font-table"
  | "footer"
  | "footnotes"
  | "header"
  | "numbering"
  | "settings"
  | "styles"
  | "theme";

export interface DocxSemanticPartFactV1 {
  partRef: string;
  kind: DocxSemanticPartKindV1;
  scan: XmlPartScanV1;
}

export interface DocxSectionFactV1 {
  story: string;
  section: number;
  locator: string;
  page: {
    widthTwips?: number;
    heightTwips?: number;
    orientation?: "landscape" | "portrait";
    marginTopTwips?: number;
    marginRightTwips?: number;
    marginBottomTwips?: number;
    marginLeftTwips?: number;
  };
}

export interface DocxUsageFactV1 {
  story: string;
  section: number;
  kind: "direct-formatting" | "paragraph-style";
  fingerprint: string;
  count: number;
}

export interface AlternateContentVariantFactV1 {
  kind: "choice" | "fallback";
  selected: boolean;
  fingerprint: string;
}

export interface AlternateContentFactV1 {
  locator: string;
  story: string;
  variants: readonly AlternateContentVariantFactV1[];
}

export interface DocxTemplateFactsV1 {
  schema: typeof DOCX_TEMPLATE_FACTS_SCHEMA_V1;
  compatibilityProfile: MarkupCompatibilityProfileV1;
  opc: DocxOpcFactsV1;
  parts: readonly DocxSemanticPartFactV1[];
  inventory: {
    styles: number;
    themeColorSlots: number;
    settingsParts: number;
    numberingDefinitions: number;
    fonts: number;
    sections: number;
    headers: number;
    footers: number;
    backgrounds: number;
    pageBorders: number;
    drawings: number;
    mediaReferences: number;
    alternateContentGroups: number;
  };
  sections: readonly DocxSectionFactV1[];
  usage: readonly DocxUsageFactV1[];
  revisions: {
    present: boolean;
    insertions: number;
    deletions: number;
  };
  alternateContent: readonly AlternateContentFactV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
}

interface ZipEntry {
  name: string;
  dir: boolean;
  asUint8Array(): Uint8Array;
}

interface MutableUsage {
  story: string;
  section: number;
  kind: DocxUsageFactV1["kind"];
  source: string;
  count: number;
}

interface MutableVariant {
  kind: "choice" | "fallback";
  selected: boolean;
  tokens: string[];
}

interface MutableAlternate {
  depth: number;
  locator: string;
  story: string;
  selectedChoice: boolean;
  sawFallback: boolean;
  variants: MutableVariant[];
}

interface BranchState {
  depth: number;
  active: boolean;
  variant: MutableVariant;
}

interface PartAccumulator {
  styles: number;
  themeColorSlots: number;
  settingsParts: number;
  numberingDefinitions: number;
  fonts: number;
  sections: DocxSectionFactV1[];
  backgrounds: number;
  pageBorders: number;
  drawings: number;
  mediaReferences: number;
  usage: MutableUsage[];
  insertions: number;
  deletions: number;
  alternates: MutableAlternate[];
  diagnostics: TemplateDiagnosticV1[];
}

function factsDiagnostic(
  code: string,
  feature: string,
  severity: TemplateDiagnosticV1["severity"]
): TemplateDiagnosticV1 {
  const item: TemplateDiagnosticV1 = {
    code,
    params: { feature },
    severity,
    recoveryActions:
      severity === "error" ? ["reanalyze"] : ["acknowledge-inventory"],
  };
  validateTemplateDiagnostic(item, [
    DOCX_INTAKE_MESSAGE_REGISTRY_V1,
    DOCX_FACTS_MESSAGE_REGISTRY_V1,
  ]);
  return item;
}

function emitProgress(
  callback: ((event: TemplateImportProgressEventV1) => void) | undefined,
  completed: number,
  total: number
): void {
  const event: TemplateImportProgressEventV1 = {
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "docx.intake",
    phase: "resolving",
    completed,
    total,
  };
  validateTemplateImportProgressEvent(event);
  callback?.(event);
}

function semanticPartKind(
  partRef: string
): DocxSemanticPartKindV1 | undefined {
  if (partRef === "word/document.xml") return "document";
  if (/^word\/header[^/]*\.xml$/i.test(partRef)) return "header";
  if (/^word\/footer[^/]*\.xml$/i.test(partRef)) return "footer";
  if (partRef === "word/styles.xml") return "styles";
  if (partRef === "word/settings.xml") return "settings";
  if (partRef === "word/numbering.xml") return "numbering";
  if (partRef === "word/fontTable.xml") return "font-table";
  if (/^word\/theme\/theme[^/]*\.xml$/i.test(partRef)) return "theme";
  if (partRef === "word/footnotes.xml") return "footnotes";
  if (partRef === "word/endnotes.xml") return "endnotes";
  return undefined;
}

function semanticAllowlist(opc: DocxOpcFactsV1): ReadonlySet<string> {
  const allowed = new Set<string>(["word/document.xml"]);
  const readableKinds = new Set([
    "document",
    "endnotes",
    "font-table",
    "footer",
    "footnotes",
    "header",
    "numbering",
    "settings",
    "styles",
    "theme",
  ]);
  for (const relationship of opc.relationships) {
    if (
      readableKinds.has(relationship.kind) &&
      relationship.target.kind === "internal" &&
      relationship.target.exists
    ) {
      allowed.add(relationship.target.partRef);
    }
  }
  return allowed;
}

function storyFor(kind: DocxSemanticPartKindV1, partRef: string): string {
  if (kind === "header") {
    const suffix = partRef.match(/header([^/.]*)\.xml$/i)?.[1] ?? "0";
    return `header.${suffix || "0"}`;
  }
  if (kind === "footer") {
    const suffix = partRef.match(/footer([^/.]*)\.xml$/i)?.[1] ?? "0";
    return `footer.${suffix || "0"}`;
  }
  return kind;
}

function isWord(event: { uri: string }): boolean {
  return WORDPROCESSINGML_URIS.has(event.uri);
}

function attribute(
  event: XmlElementEventV1,
  local: string,
  acceptedUris?: ReadonlySet<string>
): string | undefined {
  return event.attributes.find(
    (item) =>
      item.local === local &&
      (acceptedUris === undefined ||
        item.uri === "" ||
        acceptedUris.has(item.uri))
  )?.value;
}

function finiteInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stableLocator(partIndex: number, elementIndex: number): string {
  return `part.${partIndex}.element.${elementIndex}`;
}

function addUsage(
  usage: MutableUsage[],
  story: string,
  section: number,
  kind: MutableUsage["kind"],
  source: string
): void {
  const existing = usage.find(
    (item) =>
      item.story === story &&
      item.section === section &&
      item.kind === kind &&
      item.source === source
  );
  if (existing) existing.count += 1;
  else usage.push({ story, section, kind, source, count: 1 });
}

function compatibilityAttributeCheck(
  event: XmlElementEventV1,
  diagnostics: TemplateDiagnosticV1[]
): void {
  const understood = new Set(
    MARKUP_COMPATIBILITY_PROFILE_V1.understoodNamespaces
  );
  for (const item of event.attributes) {
    if (item.uri !== MCE_URI) continue;
    if (
      ![
        "Ignorable",
        "MustUnderstand",
        "ProcessContent",
        "PreserveElements",
        "PreserveAttributes",
      ].includes(item.local)
    ) {
      diagnostics.push(
        factsDiagnostic(
          "DOCX_INTAKE_MCE_ATTRIBUTE_UNSUPPORTED",
          "mc.attribute",
          "warning"
        )
      );
      continue;
    }
    const prefixes = item.value.trim().split(/\s+/).filter(Boolean);
    const hasUnknown = prefixes.some(
      (prefix) => !understood.has(event.prefixes[prefix] ?? "")
    );
    if (hasUnknown) {
      diagnostics.push(
        factsDiagnostic(
          item.local === "MustUnderstand"
            ? "DOCX_INTAKE_MCE_MUST_UNDERSTAND"
            : "DOCX_INTAKE_MCE_ATTRIBUTE_UNSUPPORTED",
          `mc.${item.local.toLowerCase()}`,
          item.local === "MustUnderstand" ? "error" : "warning"
        )
      );
    }
  }
}

function activeBranch(branches: readonly BranchState[]): boolean {
  return branches.every(({ active }) => active);
}

function scanSemanticPart(
  partRef: string,
  bytes: Uint8Array,
  kind: DocxSemanticPartKindV1,
  partIndex: number
): { scan: XmlPartScanV1; facts: PartAccumulator } {
  const story = storyFor(kind, partRef);
  const facts: PartAccumulator = {
    styles: 0,
    themeColorSlots: 0,
    settingsParts: kind === "settings" ? 1 : 0,
    numberingDefinitions: 0,
    fonts: 0,
    sections: [],
    backgrounds: 0,
    pageBorders: 0,
    drawings: 0,
    mediaReferences: 0,
    usage: [],
    insertions: 0,
    deletions: 0,
    alternates: [],
    diagnostics: [],
  };
  const alternateStack: MutableAlternate[] = [];
  const branches: BranchState[] = [];
  const sectionPages = new Map<number, DocxSectionFactV1["page"]>();
  let section = 0;
  let elementIndex = 0;
  let deletionDepth = 0;
  let insertionDepth = 0;
  let format:
    | { depth: number; tokens: string[]; kind: "pPr" | "rPr" }
    | undefined;

  const scan = streamXmlPart(partRef, bytes, {
    open(event) {
      elementIndex += 1;
      compatibilityAttributeCheck(event, facts.diagnostics);

      for (const branch of branches) {
        branch.variant.tokens.push(`e:${event.uri}#${event.local}`);
      }

      if (event.uri === MCE_URI && event.local === "AlternateContent") {
        if (alternateStack.length > 0) {
          facts.diagnostics.push(
            factsDiagnostic(
              "DOCX_INTAKE_MCE_NESTED_ALTERNATE_CONTENT",
              "mc.alternate-content",
              "warning"
            )
          );
        }
        const group: MutableAlternate = {
          depth: event.depth,
          locator: stableLocator(partIndex, elementIndex),
          story,
          selectedChoice: false,
          sawFallback: false,
          variants: [],
        };
        alternateStack.push(group);
        facts.alternates.push(group);
        return;
      }

      const group = alternateStack[alternateStack.length - 1];
      if (
        group &&
        event.depth === group.depth + 1 &&
        event.uri === MCE_URI &&
        (event.local === "Choice" || event.local === "Fallback")
      ) {
        let selected = false;
        if (event.local === "Choice") {
          const prefixes = (attribute(event, "Requires") ?? "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          const understood =
            prefixes.length > 0 &&
            prefixes.every((prefix) =>
              MARKUP_COMPATIBILITY_PROFILE_V1.understoodNamespaces.includes(
                event.prefixes[prefix] ?? ""
              )
            );
          if (!understood) {
            facts.diagnostics.push(
              factsDiagnostic(
                "DOCX_INTAKE_MCE_UNKNOWN_REQUIRES",
                "mc.requires",
                "warning"
              )
            );
          }
          selected = understood && !group.selectedChoice;
          if (selected) group.selectedChoice = true;
        } else {
          group.sawFallback = true;
          selected = !group.selectedChoice;
        }
        const variant: MutableVariant = {
          kind: event.local === "Choice" ? "choice" : "fallback",
          selected,
          tokens: [`branch:${event.local}`],
        };
        group.variants.push(variant);
        branches.push({ depth: event.depth, active: selected, variant });
        return;
      }

      if (!activeBranch(branches)) return;

      if (isWord(event) && event.local === "del") {
        deletionDepth += 1;
        facts.deletions += 1;
      } else if (isWord(event) && event.local === "ins") {
        insertionDepth += 1;
        facts.insertions += 1;
      }
      const visible = deletionDepth === 0;

      if (isWord(event) && event.local === "style") facts.styles += 1;
      if (
        DRAWINGML_URIS.has(event.uri) &&
        [
          "dk1",
          "lt1",
          "dk2",
          "lt2",
          "accent1",
          "accent2",
          "accent3",
          "accent4",
          "accent5",
          "accent6",
          "hlink",
          "folHlink",
        ].includes(event.local)
      ) {
        facts.themeColorSlots += 1;
      }
      if (
        isWord(event) &&
        (event.local === "abstractNum" || event.local === "num")
      ) {
        facts.numberingDefinitions += 1;
      }
      if (isWord(event) && event.local === "font") facts.fonts += 1;
      if (isWord(event) && event.local === "background") {
        facts.backgrounds += 1;
      }
      if (isWord(event) && event.local === "pgBorders") {
        facts.pageBorders += 1;
      }
      if (
        isWord(event) &&
        (event.local === "drawing" ||
          event.local === "pict" ||
          event.local === "object")
      ) {
        facts.drawings += 1;
      }
      if (
        DRAWINGML_URIS.has(event.uri) &&
        event.local === "blip" &&
        event.attributes.some(
          ({ uri, local }) =>
            RELATIONSHIP_URIS.has(uri) &&
            (local === "embed" || local === "link")
        )
      ) {
        facts.mediaReferences += 1;
      }

      if (
        visible &&
        isWord(event) &&
        event.local === "pStyle"
      ) {
        const style = attribute(event, "val", WORDPROCESSINGML_URIS);
        if (style) {
          addUsage(facts.usage, story, section, "paragraph-style", style);
        }
      }

      if (
        visible &&
        isWord(event) &&
        (event.local === "pPr" || event.local === "rPr")
      ) {
        format = { depth: event.depth, tokens: [], kind: event.local };
      } else if (
        visible &&
        format &&
        event.depth === format.depth + 1 &&
        isWord(event) &&
        !["pStyle", "rStyle", "sectPr"].includes(event.local)
      ) {
        const safeValues = event.attributes
          .filter(({ uri }) => uri === "" || WORDPROCESSINGML_URIS.has(uri))
          .map(({ local, value }) => `${local}=${value}`)
          .sort();
        format.tokens.push(`${event.local}[${safeValues.join(",")}]`);
      }

      if (isWord(event) && event.local === "pgSz") {
        const page = sectionPages.get(section) ?? {};
        page.widthTwips = finiteInteger(
          attribute(event, "w", WORDPROCESSINGML_URIS)
        );
        page.heightTwips = finiteInteger(
          attribute(event, "h", WORDPROCESSINGML_URIS)
        );
        const orient = attribute(event, "orient", WORDPROCESSINGML_URIS);
        if (orient === "landscape" || orient === "portrait") {
          page.orientation = orient;
        }
        sectionPages.set(section, page);
      }
      if (isWord(event) && event.local === "pgMar") {
        const page = sectionPages.get(section) ?? {};
        page.marginTopTwips = finiteInteger(
          attribute(event, "top", WORDPROCESSINGML_URIS)
        );
        page.marginRightTwips = finiteInteger(
          attribute(event, "right", WORDPROCESSINGML_URIS)
        );
        page.marginBottomTwips = finiteInteger(
          attribute(event, "bottom", WORDPROCESSINGML_URIS)
        );
        page.marginLeftTwips = finiteInteger(
          attribute(event, "left", WORDPROCESSINGML_URIS)
        );
        sectionPages.set(section, page);
      }
      void insertionDepth;
    },
    close(event) {
      const branch = branches[branches.length - 1];
      if (branch && event.depth === branch.depth) branches.pop();

      const group = alternateStack[alternateStack.length - 1];
      if (
        group &&
        event.uri === MCE_URI &&
        event.local === "AlternateContent" &&
        event.depth === group.depth
      ) {
        if (!group.selectedChoice && !group.sawFallback) {
          facts.diagnostics.push(
            factsDiagnostic(
              "DOCX_INTAKE_MCE_MISSING_FALLBACK",
              "mc.fallback",
              "error"
            )
          );
        }
        alternateStack.pop();
      }

      if (!activeBranch(branches)) return;
      if (
        format &&
        isWord(event) &&
        event.depth === format.depth &&
        event.local === format.kind
      ) {
        if (format.tokens.length > 0) {
          addUsage(
            facts.usage,
            story,
            section,
            "direct-formatting",
            format.tokens.sort().join("|")
          );
        }
        format = undefined;
      }
      if (isWord(event) && event.local === "del") deletionDepth -= 1;
      if (isWord(event) && event.local === "ins") insertionDepth -= 1;
      if (isWord(event) && event.local === "sectPr") {
        facts.sections.push({
          story,
          section,
          locator: stableLocator(partIndex, elementIndex),
          page: sectionPages.get(section) ?? {},
        });
        section += 1;
      }
    },
  });

  return { scan, facts };
}

async function portableUsage(
  usage: readonly MutableUsage[]
): Promise<DocxUsageFactV1[]> {
  const cache = new Map<string, string>();
  const result: DocxUsageFactV1[] = [];
  for (const item of usage) {
    let fingerprint = cache.get(item.source);
    if (!fingerprint) {
      fingerprint = await sha256Hex(new TextEncoder().encode(item.source));
      cache.set(item.source, fingerprint);
    }
    result.push({
      story: item.story,
      section: item.section,
      kind: item.kind,
      fingerprint,
      count: item.count,
    });
  }
  return result.sort((left, right) =>
    `${left.story}:${left.section}:${left.kind}:${left.fingerprint}`.localeCompare(
      `${right.story}:${right.section}:${right.kind}:${right.fingerprint}`
    )
  );
}

async function portableAlternates(
  alternates: readonly MutableAlternate[]
): Promise<AlternateContentFactV1[]> {
  const result: AlternateContentFactV1[] = [];
  for (const alternate of alternates) {
    const variants: AlternateContentVariantFactV1[] = [];
    for (const variant of alternate.variants) {
      variants.push({
        kind: variant.kind,
        selected: variant.selected,
        fingerprint: await sha256Hex(
          new TextEncoder().encode(variant.tokens.join("|"))
        ),
      });
    }
    result.push({
      locator: alternate.locator,
      story: alternate.story,
      variants,
    });
  }
  return result.sort((left, right) =>
    `${left.story}:${left.locator}`.localeCompare(
      `${right.story}:${right.locator}`
    )
  );
}

/** Analyze only allowlisted OOXML parts and return text-free portable facts. */
export async function analyzeDocxTemplate(
  bytes: Uint8Array,
  options: {
    progress?: (event: TemplateImportProgressEventV1) => void;
  } = {}
): Promise<DocxTemplateFactsV1> {
  const zip = unzipDocx(bytes, DOCX_TEMPLATE_INTAKE_BUDGET);
  const opc = await analyzeDocxOpcArchive(zip, {
    progress: options.progress,
  });
  const allowlist = semanticAllowlist(opc);
  const entries = (Object.values(zip.files) as unknown as ZipEntry[])
    .filter(
      ({ dir, name }) =>
        !dir &&
        allowlist.has(name) &&
        semanticPartKind(name) !== undefined
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  emitProgress(options.progress, 0, entries.length);
  const parts: DocxSemanticPartFactV1[] = [];
  const allUsage: MutableUsage[] = [];
  const allAlternates: MutableAlternate[] = [];
  const sections: DocxSectionFactV1[] = [];
  const diagnostics: TemplateDiagnosticV1[] = [...opc.diagnostics];
  const inventory = {
    styles: 0,
    themeColorSlots: 0,
    settingsParts: 0,
    numberingDefinitions: 0,
    fonts: 0,
    sections: 0,
    headers: 0,
    footers: 0,
    backgrounds: 0,
    pageBorders: 0,
    drawings: 0,
    mediaReferences: 0,
    alternateContentGroups: 0,
  };
  let insertions = 0;
  let deletions = 0;

  for (const [partIndex, entry] of entries.entries()) {
    const kind = semanticPartKind(entry.name) as DocxSemanticPartKindV1;
    const { scan, facts } = scanSemanticPart(
      entry.name,
      entry.asUint8Array(),
      kind,
      partIndex
    );
    parts.push({ partRef: entry.name, kind, scan });
    inventory.styles += facts.styles;
    inventory.themeColorSlots += facts.themeColorSlots;
    inventory.settingsParts += facts.settingsParts;
    inventory.numberingDefinitions += facts.numberingDefinitions;
    inventory.fonts += facts.fonts;
    inventory.backgrounds += facts.backgrounds;
    inventory.pageBorders += facts.pageBorders;
    inventory.drawings += facts.drawings;
    inventory.mediaReferences += facts.mediaReferences;
    inventory.alternateContentGroups += facts.alternates.length;
    if (kind === "header") inventory.headers += 1;
    if (kind === "footer") inventory.footers += 1;
    allUsage.push(...facts.usage);
    allAlternates.push(...facts.alternates);
    sections.push(...facts.sections);
    diagnostics.push(...facts.diagnostics);
    insertions += facts.insertions;
    deletions += facts.deletions;
    emitProgress(options.progress, partIndex + 1, entries.length);
  }
  inventory.sections = sections.length;
  const revisionsPresent = insertions + deletions > 0;
  if (revisionsPresent) {
    diagnostics.push(
      factsDiagnostic(
        "DOCX_INTAKE_REVISIONS_PRESENT",
        "word.revisions",
        "warning"
      )
    );
  }
  diagnostics.sort((left, right) =>
    `${left.code}:${canonicalIntakeJson(left.params)}`.localeCompare(
      `${right.code}:${canonicalIntakeJson(right.params)}`
    )
  );

  return {
    schema: DOCX_TEMPLATE_FACTS_SCHEMA_V1,
    compatibilityProfile: MARKUP_COMPATIBILITY_PROFILE_V1,
    opc,
    parts,
    inventory,
    sections,
    usage: await portableUsage(allUsage),
    revisions: {
      present: revisionsPresent,
      insertions,
      deletions,
    },
    alternateContent: await portableAlternates(allAlternates),
    diagnostics,
  };
}

export function canonicalDocxTemplateFactsJson(
  facts: DocxTemplateFactsV1
): string {
  return canonicalIntakeJson(facts);
}
