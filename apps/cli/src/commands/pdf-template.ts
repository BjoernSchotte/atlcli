import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  hasFlag,
  output,
  sha256Hex,
  slugify,
  type OutputOptions,
} from "@atlcli/core";
import {
  DOCX_FACTS_MESSAGE_REGISTRY_V1,
  DOCX_INTAKE_MESSAGE_REGISTRY_V1,
  DOCX_MAPPING_MESSAGE_REGISTRY_V1,
  DOCX_VISUAL_MESSAGE_REGISTRY_V1,
  TEMPLATE_INTAKE_MESSAGES_V1,
  analyzeDocxTemplateImport,
  type DocxVisualPrivateSidecarV1,
} from "@atlcli/docx-template-intake";
import {
  BUILTIN_PDF_TEMPLATE_ID,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_RUNTIME_ASSETS,
  PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
  PdfTemplateRuntimeMaterializer,
  PdfTemplatePreviewCompiler,
  getBuiltinPdfTemplate,
  loadPdfTemplatePack,
} from "@atlcli/pdf";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
} from "@atlcli/pdf/internal";
import {
  ACCEPT_RECOMMENDED_POLICY_V1,
  ACCEPT_SAFE_POLICY_V1,
  AUTHORING_MESSAGE_REGISTRY_V1,
  InMemoryTemplateAssetStore,
  TemplateAuthoringError,
  TemplateProjectBuildError,
  acceptRecommendedCandidates,
  acceptSafeCandidates,
  buildGeneratedPdfTemplatePack,
  buildTemplateProject,
  createTemplateProjectState,
  diffTemplateLayers,
  prepareTemplateProjectUndo,
  projectTemplateImportView,
  reanalyzeTemplateProject,
  reduceTemplateDecision,
  reduceTemplateImportAction,
  renderTemplateProjectPreviews,
  resolveTemplateLayers,
  type TemplateAssetHandleV1,
  type TemplateAssetStore,
  type TemplateCandidateV1,
  type TemplateDecisionContextV1,
  type TemplateDecisionStateV1,
  type TemplateDisplayValueV1,
  type TemplateImportActionV1,
  type TemplateImportProgressEventV1,
  type TemplateImportViewV1,
  type TemplateMessageRegistryV1,
  type TemplatePreviewCompiler,
  type TemplateProjectAnalysisV1,
  type TemplateProjectGenerationV1,
  type TemplateProjectPreviewArtifactV1,
  type TemplateProjectStateV1,
} from "@atlcli/pdf-template-authoring";
import {
  canonicalCapabilityJson,
  packTemplate,
} from "@atlcli/template-pack";
import { getPdfCompiler } from "./export-pdf-assets.js";
import {
  DirectoryTemplateAssetStore,
  DirectoryTemplateProjectRepository,
  PdfTemplateProjectFsError,
  readTemplateProjectIdentity,
  writeTemplateProjectBuild,
  writeTemplateProjectProof,
} from "./pdf-template-project-writer.js";
import {
  CliGeneratedPdfTemplateCompiler,
} from "./pdf-template-runtime.js";

const RESULT_SCHEMA = "atlcli.pdf-template-result/1" as const;
const PRIVATE_INTAKE_SCHEMA = "atlcli.pdf-template-private-intake/1" as const;
const IMPORTER_VERSION = "atlcli.pdf-template-import/1";
const COMPILER_VERSION = "typst-wasm-pinned-0.14";

const MESSAGE_REGISTRIES: readonly TemplateMessageRegistryV1[] = [
  AUTHORING_MESSAGE_REGISTRY_V1,
  DOCX_INTAKE_MESSAGE_REGISTRY_V1,
  DOCX_FACTS_MESSAGE_REGISTRY_V1,
  DOCX_MAPPING_MESSAGE_REGISTRY_V1,
  DOCX_VISUAL_MESSAGE_REGISTRY_V1,
];
const CLI_MESSAGE_CODES = Object.freeze([
  "ATLCLI_PDF_TEMPLATE_METADATA_ONLY",
  "ATLCLI_PDF_TEMPLATE_REVIEW_NON_INTERACTIVE",
] as const);

const T0_COPY = Object.fromEntries(
  Object.entries(TEMPLATE_INTAKE_MESSAGES_V1).map(([code, definition]) => [
    code,
    definition.defaultEnglish,
  ])
);
const CAPABILITY_COPY = Object.fromEntries(
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1.descriptors.map((descriptor) => [
    descriptor.messageCode,
    `${descriptor.section
      .split("-")
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(" ")} setting`,
  ])
);

export const DEFAULT_PDF_TEMPLATE_CLI_COPY: Readonly<Record<string, string>> =
  Object.freeze({
    ...T0_COPY,
    ...CAPABILITY_COPY,
    AUTHORING_ACTION_DISABLED: "That action is not available in the current stage.",
    AUTHORING_AMBIGUOUS_CONFLICT: "More than one Word value could control {target}.",
    AUTHORING_PREVIEW_REQUIRED: "Create a fresh {preview} before building.",
    AUTHORING_REVIEW_REQUIRED: "{count} design choices still need an answer.",
    AUTHORING_SOURCE_CHANGED: "The Word source changed ({state}).",
    AUTHORING_SOURCE_UNREADABLE: "The Word document could not be read ({technicalRef}).",
    AUTHORING_UNSUPPORTED_INVENTORY:
      "{count} Word features cannot be transferred and need acknowledgement.",
    DOCX_CONCEPT_BODY: "Body text",
    DOCX_CONCEPT_CODE: "Code",
    DOCX_CONCEPT_COLOR: "Colors",
    DOCX_CONCEPT_FOOTER: "Footer",
    DOCX_CONCEPT_HEADER: "Header",
    DOCX_CONCEPT_HEADING_1: "Heading 1",
    DOCX_CONCEPT_HEADING_2: "Heading 2",
    DOCX_CONCEPT_HEADING_3: "Heading 3",
    DOCX_CONCEPT_PAGE: "Page",
    DOCX_CONCEPT_TABLE: "Tables",
    DOCX_CONCEPT_VISUAL_ASSET: "Graphic",
    DOCX_MAPPING_CAPABILITY_ABSENT:
      "The supported design catalog has no matching setting for {target}.",
    DOCX_MAPPING_DIRECT_FORMAT_DOMINANCE:
      "{count} uses make this formatting pattern representative for {role}.",
    DOCX_MAPPING_FONT_BUNDLED: "The {role} font is available in the PDF runtime.",
    DOCX_MAPPING_FONT_SUBSTITUTION_REQUIRED:
      "The {role} font is unavailable and needs a substitution.",
    DOCX_MAPPING_OUTLINE_LEVEL: "Word outline level {level} maps to {role}.",
    DOCX_MAPPING_PAGE_FORMAT: "The document uses the standard {format} page format.",
    DOCX_MAPPING_REPEATED_USAGE:
      "{count} consistent uses support the proposed {role} setting.",
    DOCX_MAPPING_SECTION_UNIFORM:
      "The setting is consistent across {count} document sections.",
    DOCX_MAPPING_STANDARD_STYLE: "The standard Word style maps to {role}.",
    DOCX_MAPPING_TABLE_CONDITIONAL:
      "{regions} table regions contribute to the proposed {role} setting.",
    DOCX_MAPPING_THEME_COLOR: "The Word theme uses the {slot} color slot.",
    DOCX_MAPPING_THEME_FONT: "The Word theme supplies the {role} font for {script}.",
    DOCX_PAGE_CUSTOM_SIZE: "The custom page size cannot be transferred directly.",
    DOCX_SECTION_SCOPE_UNSUPPORTED:
      "Section {section} uses an unsupported {variant} page-master variation.",
    DOCX_STYLE_CYCLE: "A Word style contains a circular inheritance reference.",
    DOCX_STYLE_INVALID_PROPERTY: "A Word style contains an invalid {property} value.",
    DOCX_STYLE_MISSING_PARENT: "A Word style refers to a missing parent style.",
    DOCX_INTAKE_DUPLICATE_RELATIONSHIP:
      "The Word package contains a duplicate relationship.",
    DOCX_INTAKE_MISSING_PART: "A referenced Word package part is missing.",
    DOCX_INTAKE_RELATIONSHIP_TRAVERSAL:
      "An unsafe Word package relationship was rejected.",
    ATLCLI_PDF_TEMPLATE_METADATA_ONLY:
      "Graphics were not extracted during metadata-only import. Reanalyze the Word source before reviewing graphics.",
    ATLCLI_PDF_TEMPLATE_REVIEW_NON_INTERACTIVE:
      "Review needs an explicit action because this terminal cannot prompt. The active draft was retained.",
    DOCX_INTAKE_EXTERNAL_RELATIONSHIP:
      "An external {scheme} relationship was recorded but not loaded.",
    DOCX_INTAKE_UNSUPPORTED_BINARY:
      "An unsupported {kind} item ({declaredBytes} bytes) was inventoried.",
    DOCX_INTAKE_UNKNOWN_RELATIONSHIP:
      "An unknown {kind} relationship was inventoried.",
    DOCX_INTAKE_MCE_ATTRIBUTE_UNSUPPORTED:
      "An unsupported compatibility attribute was inventoried.",
    DOCX_INTAKE_MCE_MISSING_FALLBACK:
      "A compatibility branch has no usable fallback.",
    DOCX_INTAKE_MCE_MUST_UNDERSTAND:
      "A required Word extension is not understood.",
    DOCX_INTAKE_MCE_NESTED_ALTERNATE_CONTENT:
      "Nested alternate content cannot be transferred safely.",
    DOCX_INTAKE_MCE_UNKNOWN_REQUIRES:
      "A compatibility branch requires an unknown feature.",
    DOCX_INTAKE_REVISIONS_PRESENT:
      "Tracked revisions were detected and inventoried.",
    DOCX_VISUAL_ASSET_CORRUPT: "A graphic was rejected because {reason}.",
    DOCX_VISUAL_ASSET_LIMIT: "A graphic exceeded the safe {reason} limit.",
    DOCX_VISUAL_EXTERNAL_IMAGE:
      "An external graphic was not downloaded ({reason}).",
    DOCX_VISUAL_SVG_UNSAFE: "An unsafe SVG was rejected ({reason}).",
    DOCX_VISUAL_UNSUPPORTED: "A graphic cannot be transferred ({reason}).",
    DOCX_VISUAL_ROLE_REPEATED_HEADER:
      "The graphic appears in {occurrences} headers.",
    DOCX_VISUAL_ROLE_PAGE_FILL:
      "The graphic covers approximately {coverage} of the page.",
    DOCX_VISUAL_ROLE_FIRST_ONLY:
      "The graphic appears only on the first page of section {section}.",
    DOCX_VISUAL_ROLE_WATERMARK:
      "The graphic resembles a watermark (rotation {rotation}, opacity {opacity}).",
  });

export interface PdfTemplateCliDiagnosticV1 {
  code: string;
  severity: "error" | "info" | "warning";
  message: string;
  recoveryCommands: readonly string[];
  technical?: string;
}

export interface PdfTemplateCliResultV1 {
  schema: typeof RESULT_SCHEMA;
  command: string;
  ok: boolean;
  exitCode: number;
  projectPath?: string;
  inputDigest?: string;
  outputDigest?: string;
  changedCount?: number;
  openCount?: number;
  view?: TemplateImportViewV1;
  diagnostics: readonly PdfTemplateCliDiagnosticV1[];
  nextActions: readonly string[];
  outputs?: Readonly<Record<string, string>>;
  details?: Readonly<Record<string, unknown>>;
}

export class PdfTemplateCliError extends Error {
  constructor(
    readonly machineCode:
      | "ATLCLI_ERR_CANCELLED"
      | "ATLCLI_ERR_IO"
      | "ATLCLI_ERR_USAGE"
      | "ATLCLI_ERR_VALIDATION",
    readonly exitCode: 1 | 5 | 130,
    message: string,
    readonly recoveryCommands: readonly string[] = []
  ) {
    super(message);
    this.name = "PdfTemplateCliError";
  }
}

export class ReportedPdfTemplateCliError extends Error {
  readonly reported = true;

  constructor(readonly exitCode: number) {
    super("");
    this.name = "ReportedPdfTemplateCliError";
  }
}

interface PrivateAssetCandidateV1 {
  candidateId: string;
  semanticKey: string;
  asset: TemplateAssetHandleV1;
  occurrenceCount: number;
  proposedRole?: string;
  supportedPlacementChoices: readonly string[];
  candidatePlacement?: Readonly<Record<string, unknown>>;
}

interface PrivateIntakeV1 {
  readonly [key: string]: unknown;
  schema: typeof PRIVATE_INTAKE_SCHEMA;
  source: {
    name: string;
    metadataOnly: boolean;
  };
  visual?: DocxVisualPrivateSidecarV1;
  assetCandidates: readonly PrivateAssetCandidateV1[];
}

export interface PdfTemplateCliDependencies {
  cwd: string;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  columns: number;
  noColor: boolean;
  unicode: boolean;
  locale: string;
  prompt(question: string): Promise<string>;
  onProgress(event: TemplateImportProgressEventV1): void;
  readBytes(path: string): Promise<Uint8Array>;
  createPreviewCompiler(
    project: TemplateProjectStateV1,
    privateIntake: PrivateIntakeV1,
    assetStore: DirectoryTemplateAssetStore
  ): Promise<TemplatePreviewCompiler>;
}

function defaultDependencies(
  json: boolean,
  flags: Record<string, string | boolean | string[]>
): PdfTemplateCliDependencies {
  return {
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    columns: process.stderr.columns ?? 80,
    noColor:
      process.env.NO_COLOR !== undefined ||
      process.stderr.isTTY !== true ||
      hasFlag(flags, "no-color"),
    unicode: !hasFlag(flags, "ascii"),
    locale: flagString(flags, "locale", false) ?? "en",
    prompt: async (question) => {
      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.once("SIGINT", onSignal);
      const terminal = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await terminal.question(question, {
          signal: controller.signal,
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new PdfTemplateCliError(
            "ATLCLI_ERR_CANCELLED",
            130,
            "Review was cancelled. The active draft was retained.",
            []
          );
        }
        throw error;
      } finally {
        process.removeListener("SIGINT", onSignal);
        terminal.close();
      }
    },
    onProgress: (event) => {
      if (json) {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      } else {
        const total = event.total === null ? "?" : String(event.total);
        process.stderr.write(
          `${event.phase}: ${event.completed}/${total}\n`
        );
      }
    },
    readBytes: async (path) => new Uint8Array(await readFile(path)),
    createPreviewCompiler: async (project, privateIntake, assetStore) => {
      const materializer = new PdfTemplateRuntimeMaterializer();
      const runtimeAssets = await acceptedRuntimeAssets(project, assetStore);
      const materialized = await materializer.materialize(
        project.snapshot,
        runtimeAssets
      );
      const bytes = await packTemplate({
        manifest: materialized.manifest,
        files: Object.fromEntries(
          Object.entries(materialized.files).map(([path, value]) => [
            path,
            new Uint8Array(value),
          ])
        ),
      });
      const currentPack = await loadPdfTemplatePack(bytes);
      const reviewAssets = await Promise.all(
        privateIntake.assetCandidates.map(async (candidate) => ({
          id: candidate.semanticKey,
          vfsPath: `template-assets/review/${candidate.asset.sha256}`,
          bytes: await assetStore.get(candidate.asset),
          mediaType: candidate.asset.mediaType,
          occurrenceCount: candidate.occurrenceCount,
          ...(candidate.proposedRole
            ? { proposedRole: candidate.proposedRole }
            : {}),
        }))
      );
      return new PdfTemplatePreviewCompiler({
        compiler: await getPdfCompiler(),
        resolveModel: async () => ({
          baseline: BUILTIN_PDF_TEMPLATE_MANIFEST,
          current: materialized.manifest,
          currentPack,
          reviewAssets,
        }),
      });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flagString(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  required = false
): string | undefined {
  const value = flags[name];
  if (Array.isArray(value)) {
    throw usage(`--${name} may be provided only once`);
  }
  if (value === true) {
    throw usage(`--${name} requires a value`);
  }
  if (value === undefined && required) {
    throw usage(`--${name} is required`);
  }
  return typeof value === "string" ? value : undefined;
}

function usage(message: string): PdfTemplateCliError {
  return new PdfTemplateCliError(
    "ATLCLI_ERR_USAGE",
    1,
    message,
    ["atlcli pdf-template --help"]
  );
}

function validateFlags(
  command: string,
  flags: Record<string, string | boolean | string[]>
): void {
  const common = new Set([
    "ascii",
    "details",
    "h",
    "help",
    "json",
    "locale",
    "no-color",
    "no-log",
    "non-interactive",
  ]);
  const byCommand: Readonly<Record<string, readonly string[]>> = {
    import: ["baseline", "dir", "metadata-only", "policy"],
    analyze: ["baseline", "dir", "metadata-only", "policy"],
    reanalyze: ["dir", "metadata-only"],
    status: ["dir"],
    review: [
      "acknowledge-unsupported",
      "apply-ready",
      "dir",
      "keep-current-for-remaining",
    ],
    preview: ["dir", "output-dir"],
    build: ["dir", "output"],
    undo: ["dir"],
    diff: ["dir"],
    decide: [
      "accept",
      "accept-asset",
      "accept-recommended",
      "accept-safe",
      "acknowledge-unsupported",
      "alt",
      "candidate",
      "custom-placement",
      "decorative",
      "dir",
      "group",
      "keep-baseline-for-remaining",
      "meaningful",
      "reject",
      "reset-group",
      "rights-confirmed",
      "role",
      "slot-default",
      "use-baseline",
      "use-candidate-placement",
    ],
    set: ["dir", "target", "value"],
    "clear-override": ["dir", "target"],
    "clear-optional": ["dir", "target"],
    validate: ["dir"],
    pack: ["dir", "output"],
  };
  const allowed = new Set([...common, ...(byCommand[command] ?? [])]);
  const booleanFlags = new Set([
    "accept",
    "accept-asset",
    "accept-recommended",
    "accept-safe",
    "acknowledge-unsupported",
    "apply-ready",
    "ascii",
    "decorative",
    "details",
    "h",
    "help",
    "json",
    "keep-baseline-for-remaining",
    "keep-current-for-remaining",
    "meaningful",
    "metadata-only",
    "no-color",
    "no-log",
    "non-interactive",
    "reject",
    "reset-group",
    "rights-confirmed",
    "slot-default",
    "use-baseline",
    "use-candidate-placement",
  ]);
  for (const [name, value] of Object.entries(flags)) {
    if (!allowed.has(name)) {
      throw usage(`Unknown flag for ${command}: --${name}`);
    }
    if (Array.isArray(value)) {
      throw usage(`--${name} may be provided only once`);
    }
    if (booleanFlags.has(name) && value !== true) {
      throw usage(`--${name} does not take a value`);
    }
  }
  if (hasFlag(flags, "json") && !hasFlag(flags, "non-interactive")) {
    flags["non-interactive"] = true;
  }
}

function requireSingleChoice(
  flags: Record<string, string | boolean | string[]>,
  names: readonly string[],
  message: string
): string {
  const selected = names.filter((name) => hasFlag(flags, name));
  if (selected.length !== 1) throw usage(message);
  return selected[0]!;
}

function templateProjectPath(
  command: string,
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  cwd: string
): { absolute: string; display: string } {
  const fromFlag = flagString(flags, "dir");
  const positional =
    command === "import" || command === "analyze" || command === "reanalyze"
      ? undefined
      : args[1];
  if (fromFlag && positional) {
    throw usage("Provide the project either as a positional path or with --dir, not both");
  }
  const raw = fromFlag ?? positional;
  if (!raw) throw usage(`${command} requires a template project path`);
  return { absolute: resolve(cwd, raw), display: raw };
}

function sourcePath(
  args: readonly string[],
  command: "analyze" | "import" | "reanalyze",
  cwd: string
): { absolute: string; display: string } {
  const raw = args[1];
  if (!raw || args[2]) throw usage(`${command} requires exactly one DOCX path`);
  if (extname(raw).toLowerCase() !== ".docx") {
    throw usage(`${command} accepts a .docx file`);
  }
  return { absolute: resolve(cwd, raw), display: raw };
}

function defaultImportProjectPath(
  source: { absolute: string; display: string },
  flags: Record<string, string | boolean | string[]>,
  cwd: string
): { absolute: string; display: string } {
  const configured = flagString(flags, "dir");
  if (configured) return { absolute: resolve(cwd, configured), display: configured };
  const stem = basename(source.absolute, extname(source.absolute));
  const name = `${stem}-pdf-template`;
  return { absolute: join(cwd, name), display: `./${name}` };
}

function stableParams(
  template: string,
  params: Readonly<Record<string, string | number | boolean>>
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, name) =>
    name in params ? String(params[name]) : match
  );
}

export function renderPdfTemplateMessage(
  code: string,
  params: Readonly<Record<string, string | number | boolean>>,
  locale = "en",
  copies: Readonly<Record<string, string>> = DEFAULT_PDF_TEMPLATE_CLI_COPY
): string {
  const copy = locale === "en" ? copies[code] : undefined;
  if (!copy) {
    const suffix = Object.keys(params).length
      ? ` ${canonicalCapabilityJson(params)}`
      : "";
    return `[${code}]${suffix}`;
  }
  return stableParams(copy, params);
}

export function validatePdfTemplateCliCopyCoverage(
  copies: Readonly<Record<string, string>>
): void {
  const codes = new Set<string>(Object.keys(TEMPLATE_INTAKE_MESSAGES_V1));
  for (const registry of MESSAGE_REGISTRIES) {
    for (const definition of registry.definitions) codes.add(definition.code);
  }
  for (const descriptor of PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1.descriptors) {
    codes.add(descriptor.messageCode);
  }
  for (const code of CLI_MESSAGE_CODES) codes.add(code);
  const missing = [...codes].filter((code) => !copies[code]).sort();
  if (missing.length > 0) {
    throw new Error(`Missing default PDF-template CLI copy: ${missing.join(", ")}`);
  }
}

function mapRole(role: string | undefined): string | undefined {
  switch (role) {
    case "logo":
    case "asset.logo":
      return "asset.logo";
    case "page-background":
    case "asset.pageBackground":
      return "asset.pageBackground";
    case "cover-art":
    case "asset.coverBackground":
      return "asset.coverBackground";
    case "header-decoration":
    case "asset.headerDecoration":
      return "asset.headerDecoration";
    case "footer-decoration":
    case "asset.footerDecoration":
      return "asset.footerDecoration";
    default:
      return undefined;
  }
}

async function analyzeSource(
  bytes: Uint8Array,
  source: { absolute: string; display: string },
  metadataOnly: boolean,
  assetStore: TemplateAssetStore,
  dependencies: PdfTemplateCliDependencies
): Promise<{
  analysis: TemplateProjectAnalysisV1;
  assetHandles: Readonly<Record<string, TemplateAssetHandleV1>>;
  privateIntake: PrivateIntakeV1;
}> {
  const result = await analyzeDocxTemplateImport(bytes, {
    catalog: PDF_TEMPLATE_CAPABILITIES_V1,
    bundledFontFamilies: PDF_RUNTIME_ASSETS.fonts.map(({ family }) => family),
    assetCapabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
    assetStore,
    metadataOnly,
    progress: dependencies.onProgress,
  });
  return {
    analysis: result.analysis,
    assetHandles: result.assetHandles,
    privateIntake: {
      schema: PRIVATE_INTAKE_SCHEMA,
      source: {
        name: basename(source.absolute),
        metadataOnly,
      },
      ...(result.privateVisual ? { visual: result.privateVisual } : {}),
      assetCandidates: result.privateAssetCandidates,
    },
  };
}

function baseline(
  requested: string | undefined
): {
  id: string;
  version: string;
  design: Readonly<Record<string, unknown>>;
  manifest: typeof BUILTIN_PDF_TEMPLATE_MANIFEST;
} {
  const normalized =
    !requested || requested === "editorial-indigo"
      ? BUILTIN_PDF_TEMPLATE_ID
      : requested;
  const manifest = getBuiltinPdfTemplate(normalized);
  if (!manifest?.design) {
    throw usage(
      `Unknown built-in PDF baseline "${requested}". Use ${BUILTIN_PDF_TEMPLATE_ID}.`
    );
  }
  return {
    id: manifest.id,
    version: manifest.version,
    design: manifest.design as unknown as Readonly<Record<string, unknown>>,
    manifest,
  };
}

function decisionContext(project: TemplateProjectStateV1): TemplateDecisionContextV1 {
  return {
    catalog: PDF_TEMPLATE_CAPABILITIES_V1,
    baseline: baseline(project.baseline.id).design,
    catalogDigest: project.catalog.digest,
    sourceDigest: project.analysis.sourceDigest,
    importerVersion: IMPORTER_VERSION,
    mappingVersion: project.analysis.mappingVersion,
  };
}

async function resolveProjectState(
  project: TemplateProjectStateV1,
  decisions: TemplateDecisionStateV1
): Promise<TemplateProjectStateV1> {
  const selected = baseline(project.baseline.id);
  const snapshot = await resolveTemplateLayers({
    catalog: PDF_TEMPLATE_CAPABILITIES_V1,
    catalogDigest: project.catalog.digest,
    baseline: {
      id: project.baseline.id,
      version: project.baseline.version,
      design: selected.design,
    },
    sourceDigest: project.analysis.sourceDigest,
    decisions,
    candidates: project.analysis.candidates,
    mappingVersion: project.analysis.mappingVersion,
  });
  return {
    ...project,
    decisions,
    snapshot,
  };
}

async function createInitialProject(
  analysis: TemplateProjectAnalysisV1,
  assetHandles: Readonly<Record<string, TemplateAssetHandleV1>>,
  selected: ReturnType<typeof baseline>
): Promise<TemplateProjectStateV1> {
  return createTemplateProjectState({
    analysis,
    assetHandles,
    catalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
      descriptor: PDF_TEMPLATE_CAPABILITIES_V1,
    },
    baseline: {
      id: selected.id,
      version: selected.version,
      design: selected.design,
    },
  });
}

async function projectView(
  repository: DirectoryTemplateProjectRepository,
  generation: TemplateProjectGenerationV1
): Promise<TemplateImportViewV1> {
  if (!generation.project) {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_VALIDATION",
      5,
      "This project predates the PDF-template authoring state. The active draft was retained.",
      []
    );
  }
  const history = await repository.listHistory(generation.projectId);
  return projectTemplateImportView({
    generation: generation.generation,
    analysisDigest: generation.project.analysis.digest,
    baseline: baseline(generation.project.baseline.id).design,
    candidates: generation.project.analysis.candidates,
    decisions: generation.project.decisions,
    snapshot: generation.project.snapshot,
    catalog: PDF_TEMPLATE_CAPABILITIES_V1,
    presentation: PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
    messageRegistries: MESSAGE_REGISTRIES,
    diagnostics: generation.project.analysis.diagnostics,
    inventoryDiagnosticCodes:
      generation.project.analysis.inventoryDiagnosticCodes,
    previewDigest: generation.project.snapshot.snapshotDigest,
    hasHistory: history.length > 1,
  });
}

async function loadProject(path: string): Promise<{
  repository: DirectoryTemplateProjectRepository;
  assetStore: DirectoryTemplateAssetStore;
  generation: TemplateProjectGenerationV1;
  project: TemplateProjectStateV1;
  privateIntake: PrivateIntakeV1;
  view: TemplateImportViewV1;
}> {
  const projectId = await readTemplateProjectIdentity(path);
  const repository = new DirectoryTemplateProjectRepository(path);
  const generation = await repository.read(projectId);
  if (!generation.project) {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_VALIDATION",
      5,
      "The template project has no authoring state. The active draft was retained.",
      []
    );
  }
  const privateIntake = (await repository.readPrivateIntake(
    generation.generation
  )) as unknown as PrivateIntakeV1;
  if (privateIntake.schema !== PRIVATE_INTAKE_SCHEMA) {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_VALIDATION",
      5,
      "The private intake record is invalid. The active draft was retained.",
      []
    );
  }
  return {
    repository,
    assetStore: new DirectoryTemplateAssetStore(path),
    generation,
    project: generation.project,
    privateIntake,
    view: await projectView(repository, generation),
  };
}

function changedDecisionCount(
  before: TemplateDecisionStateV1,
  after: TemplateDecisionStateV1
): number {
  const left = new Map(
    before.decisions.map((decision) => [
      decision.id,
      canonicalCapabilityJson(decision),
    ])
  );
  const right = new Map(
    after.decisions.map((decision) => [
      decision.id,
      canonicalCapabilityJson(decision),
    ])
  );
  return new Set(
    [...left.keys(), ...right.keys()].filter(
      (id) => left.get(id) !== right.get(id)
    )
  ).size;
}

async function commitDecisions(
  loaded: Awaited<ReturnType<typeof loadProject>>,
  decisions: TemplateDecisionStateV1
): Promise<{
  generation: TemplateProjectGenerationV1;
  project: TemplateProjectStateV1;
  view: TemplateImportViewV1;
  changedCount: number;
}> {
  const project = await resolveProjectState(loaded.project, decisions);
  const generation = await loaded.repository.commit({
    projectId: loaded.generation.projectId,
    expectedGeneration: loaded.generation.generation,
    analysisDigest: project.analysis.digest,
    decisions: project.decisions,
    snapshotDigest: project.snapshot.snapshotDigest,
    project,
  });
  return {
    generation,
    project,
    view: await projectView(loaded.repository, generation),
    changedCount: changedDecisionCount(loaded.project.decisions, decisions),
  };
}

function actionContext(
  generation: string,
  project: TemplateProjectStateV1,
  view: TemplateImportViewV1,
  hasHistory: boolean
) {
  return {
    projection: {
      generation,
      analysisDigest: project.analysis.digest,
      baseline: baseline(project.baseline.id).design,
      candidates: project.analysis.candidates,
      decisions: project.decisions,
      snapshot: project.snapshot,
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      presentation: PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
      messageRegistries: MESSAGE_REGISTRIES,
      diagnostics: project.analysis.diagnostics,
      inventoryDiagnosticCodes: project.analysis.inventoryDiagnosticCodes,
      previewDigest: project.snapshot.snapshotDigest,
      hasHistory,
    },
    decisionContext: decisionContext(project),
  };
}

async function reduceGlobalAction(
  state: TemplateDecisionStateV1,
  generation: string,
  project: TemplateProjectStateV1,
  view: TemplateImportViewV1,
  hasHistory: boolean,
  kind:
    | "acknowledge-inventory"
    | "apply-ready"
    | "keep-current-for-remaining"
    | "preview"
    | "build"
): Promise<TemplateDecisionStateV1> {
  return reduceTemplateImportAction(
    state,
    { id: `action:${kind}`, kind } as TemplateImportActionV1,
    actionContext(generation, { ...project, decisions: state }, view, hasHistory)
  );
}

function actionCommands(
  view: TemplateImportViewV1,
  projectPath: string
): readonly string[] {
  const command = (id: string): string => {
    switch (id) {
      case "action:apply-ready":
      case "action:keep-current-for-remaining":
      case "action:acknowledge-inventory":
        return `atlcli pdf-template review ${projectPath}`;
      case "action:preview":
        return `atlcli pdf-template preview ${projectPath}`;
      case "action:build":
        return `atlcli pdf-template build ${projectPath} --output ./template.wiki-pdf-template`;
      case "action:reanalyze":
        return `atlcli pdf-template reanalyze <updated.docx> --dir ${projectPath}`;
      default:
        return `atlcli pdf-template status ${projectPath}`;
    }
  };
  return [...new Set(view.nextActions.map(command))];
}

function cliDiagnostic(
  code: string,
  message: string,
  recoveryCommands: readonly string[],
  severity: PdfTemplateCliDiagnosticV1["severity"] = "error",
  technical?: string
): PdfTemplateCliDiagnosticV1 {
  return {
    code,
    severity,
    message,
    recoveryCommands,
    ...(technical ? { technical } : {}),
  };
}

function successResult(
  command: string,
  projectPath: string,
  view: TemplateImportViewV1,
  overrides: Partial<PdfTemplateCliResultV1> = {}
): PdfTemplateCliResultV1 {
  return {
    schema: RESULT_SCHEMA,
    command,
    ok: true,
    exitCode: 0,
    projectPath,
    view,
    diagnostics: [],
    nextActions: actionCommands(view, projectPath),
    ...overrides,
  };
}

async function runAnalyze(
  command: "analyze" | "import",
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const source = sourcePath(args, command, dependencies.cwd);
  const projectPath = defaultImportProjectPath(
    source,
    flags,
    dependencies.cwd
  );
  const policy = flagString(flags, "policy") ?? "suggest-only";
  if (!["suggest-only", "apply-ready"].includes(policy)) {
    throw usage("--policy must be suggest-only or apply-ready");
  }
  const selected = baseline(flagString(flags, "baseline"));
  let bytes: Uint8Array;
  try {
    bytes = await dependencies.readBytes(source.absolute);
  } catch (error) {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_IO",
      1,
      `Could not read ${source.display}. No project was created.`,
      [`Check the file and retry: atlcli pdf-template ${command} ${source.display}`]
    );
  }
  const intakeAssetStore = new InMemoryTemplateAssetStore();
  const analyzed = await analyzeSource(
    bytes,
    source,
    hasFlag(flags, "metadata-only"),
    intakeAssetStore,
    dependencies
  );
  let project = await createInitialProject(
    analyzed.analysis,
    analyzed.assetHandles,
    selected
  );
  if (policy === "apply-ready") {
    const decisions = await acceptSafeCandidates(
      project.decisions,
      project.analysis.candidates,
      decisionContext(project)
    );
    project = await resolveProjectState(project, decisions);
  }
  const projectId = `pdf-template:${slugify(
    basename(source.absolute, extname(source.absolute))
  ) || "document"}`;
  const repository = new DirectoryTemplateProjectRepository(
    projectPath.absolute
  );
  const generation = await repository.commit({
    projectId,
    expectedGeneration: null,
    analysisDigest: project.analysis.digest,
    decisions: project.decisions,
    snapshotDigest: project.snapshot.snapshotDigest,
    project,
    privateIntake: analyzed.privateIntake,
  });
  const assetStore = new DirectoryTemplateAssetStore(projectPath.absolute);
  for (const handle of Object.values(analyzed.assetHandles)) {
    await assetStore.put({
      sha256: handle.sha256,
      mediaType: handle.mediaType,
      bytes: await intakeAssetStore.get(handle),
    });
  }
  const view = await projectView(repository, generation);
  return successResult(command, projectPath.display, view, {
    inputDigest: project.analysis.sourceDigest,
    changedCount: project.decisions.decisions.length,
    openCount: view.summary.unanswered,
    details: {
      sourceName: basename(source.absolute),
      baseline: selected.id,
      policy,
      metadataOnly: hasFlag(flags, "metadata-only"),
    },
  });
}

async function runStatusLike(
  command: "diff" | "status",
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath(command, args, flags, dependencies.cwd);
  const loaded = await loadProject(path.absolute);
  return successResult(command, path.display, loaded.view, {
    inputDigest: loaded.project.analysis.digest,
    openCount: loaded.view.summary.unanswered,
    diagnostics: loaded.privateIntake.source.metadataOnly
      ? [
          cliDiagnostic(
            "ATLCLI_PDF_TEMPLATE_METADATA_ONLY",
            renderPdfTemplateMessage(
              "ATLCLI_PDF_TEMPLATE_METADATA_ONLY",
              {},
              dependencies.locale
            ),
            [
              `atlcli pdf-template reanalyze ${loaded.privateIntake.source.name} --dir ${path.display}`,
            ],
            "warning"
          ),
        ]
      : [],
    details:
      command === "diff"
        ? {
            differences: diffTemplateLayers(
              baseline(loaded.project.baseline.id).design,
              loaded.project.snapshot
            ),
          }
        : {
            generation: loaded.generation.generation,
            proofDirectory: join(path.display, "proof"),
            distDirectory: join(path.display, "dist"),
            metadataOnly: loaded.privateIntake.source.metadataOnly,
          },
  });
}

async function runReviewFlags(
  loaded: Awaited<ReturnType<typeof loadProject>>,
  flags: Record<string, string | boolean | string[]>
): Promise<TemplateDecisionStateV1> {
  let decisions = loaded.project.decisions;
  let project = loaded.project;
  let view = loaded.view;
  const history = await loaded.repository.listHistory(loaded.generation.projectId);
  for (const [flag, kind] of [
    ["apply-ready", "apply-ready"],
    ["keep-current-for-remaining", "keep-current-for-remaining"],
    ["acknowledge-unsupported", "acknowledge-inventory"],
  ] as const) {
    if (!hasFlag(flags, flag)) continue;
    decisions = await reduceGlobalAction(
      decisions,
      loaded.generation.generation,
      project,
      view,
      history.length > 1,
      kind
    );
    project = await resolveProjectState(project, decisions);
    view = projectTemplateImportView(
      actionContext(
        loaded.generation.generation,
        project,
        view,
        history.length > 1
      ).projection
    );
  }
  return decisions;
}

function displayValue(value: TemplateDisplayValueV1): string {
  if (value.kind === "not-set") return "Not set";
  if (value.kind === "choice") return value.valueCode;
  if (value.kind === "asset") return `Graphic (${value.mediaType})`;
  return `${value.value ?? "Not set"}${value.unitCode ? ` ${value.unitCode}` : ""}`;
}

async function interactiveReview(
  loaded: Awaited<ReturnType<typeof loadProject>>,
  dependencies: PdfTemplateCliDependencies
): Promise<TemplateDecisionStateV1> {
  let decisions = loaded.project.decisions;
  let project = loaded.project;
  let view = loaded.view;
  const history = await loaded.repository.listHistory(loaded.generation.projectId);
  const itemOrder = view.sections.flatMap((section) =>
    section.items.map((item) => ({
      sectionId: section.id,
      itemId: item.id,
    }))
  );
  let index = 0;
  while (index < itemOrder.length) {
    const key = itemOrder[index]!;
    const section = view.sections.find(({ id }) => id === key.sectionId);
    const item = section?.items.find(({ id }) => id === key.itemId);
    if (!section || !item) {
      index += 1;
      continue;
    }
    const entry = { section: section.id, item };
    if (!["ready", "review"].includes(entry.item.state)) {
      index += 1;
      continue;
    }
    const why = entry.item.explanations
      .map((explanation) =>
        renderPdfTemplateMessage(
          explanation.code,
          explanation.params,
          dependencies.locale
        )
      )
      .join(" ");
    const base = [
      `\n${entry.section}: ${renderPdfTemplateMessage(
        entry.item.labelCode,
        {},
        dependencies.locale
      )}`,
      `Current design: ${displayValue(entry.item.baseline)}`,
      ...(entry.item.proposed
        ? [`Word value: ${displayValue(entry.item.proposed)}`]
        : []),
      `Effective now: ${displayValue(entry.item.effective)}`,
      ...(why ? [`Why this was suggested: ${why}`] : []),
    ].join("\n");
    const enabled = new Set(
      entry.item.actions
        .filter(({ enabled }) => enabled)
        .map(({ kind }) => kind)
    );
    if (enabled.has("review-asset")) {
      const include = (
        await dependencies.prompt(
          `${base}\nContact sheet: proof/asset-contact-sheet.pdf\nChoose: [y] Include this graphic, [n] Do not include, [s] Skip, [b] Back, [q] Stop and resume later (default n): `
        )
      )
        .trim()
        .toLowerCase();
      if (include === "q" || include === "stop") break;
      if (include === "b" || include === "back") {
        index = Math.max(0, index - 1);
        continue;
      }
      if (include === "s" || include === "skip") {
        index += 1;
        continue;
      }
      const candidateId = entry.item.details.candidateIds[0]!;
      const candidate = findCandidate(project, candidateId);
      if (!["y", "yes"].includes(include)) {
        decisions = await reduceTemplateImportAction(
          decisions,
          {
            id: `action:keep-current-design:${entry.item.semanticKey}`,
            kind: "keep-current-design",
            semanticKey: entry.item.semanticKey,
            scope: { kind: "group", groupId: candidate.group.id },
          },
          actionContext(
            loaded.generation.generation,
            project,
            view,
            history.length > 1
          )
        );
      } else {
        const record = loaded.privateIntake.assetCandidates.find(
          ({ candidateId: id }) => id === candidateId
        );
        if (!record) {
          throw new PdfTemplateCliError(
            "ATLCLI_ERR_VALIDATION",
            5,
            "The graphic bytes are unavailable. The active draft was retained.",
            [
              `atlcli pdf-template reanalyze ${loaded.privateIntake.source.name} --dir <project>`,
            ]
          );
        }
        const roleInput = await dependencies.prompt(
          `Role${
            record.proposedRole ? ` (suggested: ${record.proposedRole})` : ""
          }: `
        );
        const role = mapRole(roleInput.trim());
        if (!role) throw usage("Choose a supported graphic role");
        const rights = (
          await dependencies.prompt(
            "Confirm that you have the right to use this graphic (type YES): "
          )
        ).trim();
        if (rights !== "YES") {
          throw usage("Graphic inclusion requires an explicit rights confirmation");
        }
        const accessibility = (
          await dependencies.prompt(
            "Accessibility: [d] Decorative or [m] Meaningful: "
          )
        )
          .trim()
          .toLowerCase();
        if (!["d", "decorative", "m", "meaningful"].includes(accessibility)) {
          throw usage("Choose Decorative or Meaningful");
        }
        const decorative = accessibility === "d" || accessibility === "decorative";
        const alt = decorative
          ? undefined
          : (await dependencies.prompt("Alternative text: ")).trim();
        if (!decorative && !alt) {
          throw usage("A meaningful graphic requires alternative text");
        }
        const placementChoice = (
          await dependencies.prompt(
            "Placement: [d] Slot default, [c] Candidate placement, [x] Custom JSON: "
          )
        )
          .trim()
          .toLowerCase();
        let rendering:
          | { kind: "slot-default" }
          | {
              kind: "candidate-placement" | "custom-placement";
              placement: Readonly<Record<string, unknown>>;
            };
        if (placementChoice === "d" || placementChoice === "default") {
          rendering = { kind: "slot-default" };
        } else if (
          placementChoice === "c" ||
          placementChoice === "candidate"
        ) {
          if (!record.candidatePlacement) {
            throw usage("This graphic has no stable candidate placement");
          }
          rendering = {
            kind: "candidate-placement",
            placement: record.candidatePlacement,
          };
        } else if (placementChoice === "x" || placementChoice === "custom") {
          const raw = await dependencies.prompt("Custom placement JSON: ");
          let placement: unknown;
          try {
            placement = JSON.parse(raw);
          } catch {
            throw usage("Custom placement must be valid JSON");
          }
          if (!isRecord(placement)) {
            throw usage("Custom placement must be a JSON object");
          }
          rendering = { kind: "custom-placement", placement };
        } else {
          throw usage("Choose exactly one placement");
        }
        decisions = await reduceTemplateImportAction(
          decisions,
          {
            id: `action:review-asset:${candidate.semanticKey}`,
            kind: "review-asset",
            candidateId,
            assetSha256: record.asset.sha256,
            role,
            useConfirmed: true,
            rightsConfirmed: true,
            accessibility: decorative
              ? { decorative: true }
              : { decorative: false, alt },
            rendering,
          },
          actionContext(
            loaded.generation.generation,
            project,
            view,
            history.length > 1
          )
        );
      }
      project = await resolveProjectState(project, decisions);
      view = projectTemplateImportView(
        actionContext(
          loaded.generation.generation,
          project,
          view,
          history.length > 1
        ).projection
      );
      index += 1;
      continue;
    }
    const choices = [
      ...(enabled.has("use-word-value") ? ["[w] Use Word value"] : []),
      ...(enabled.has("keep-current-design")
        ? ["[k] Keep current design"]
        : []),
      ...(enabled.has("customize") ? ["[c] Customize"] : []),
      "[s] Skip",
      "[b] Back",
      "[q] Stop and resume later",
    ];
    const answer = (
      await dependencies.prompt(`${base}\nChoose: ${choices.join(", ")}: `)
    )
      .trim()
      .toLowerCase();
    if (answer === "q" || answer === "stop") break;
    if (answer === "b" || answer === "back") {
      index = Math.max(0, index - 1);
      continue;
    }
    if (answer === "s" || answer === "skip" || answer === "") {
      index += 1;
      continue;
    }
    const candidateId = entry.item.details.candidateIds[0];
    if ((answer === "w" || answer === "word") && enabled.has("use-word-value")) {
      decisions = await reduceTemplateImportAction(
        decisions,
        {
          id: `action:use-word-value:${entry.item.semanticKey}`,
          kind: "use-word-value",
          candidateId: candidateId!,
        },
        actionContext(
          loaded.generation.generation,
          project,
          view,
          history.length > 1
        )
      );
    } else if (
      (answer === "k" || answer === "keep") &&
      enabled.has("keep-current-design")
    ) {
      const candidate = project.analysis.candidates.find(
        ({ id }) => id === candidateId
      );
      decisions = await reduceTemplateImportAction(
        decisions,
        {
          id: `action:keep-current-design:${entry.item.semanticKey}`,
          kind: "keep-current-design",
          semanticKey: entry.item.semanticKey,
          scope: {
            kind: "group",
            groupId: candidate?.group.id ?? entry.item.semanticKey,
          },
        },
        actionContext(
          loaded.generation.generation,
          project,
          view,
          history.length > 1
        )
      );
    } else if (
      (answer === "c" || answer === "customize") &&
      enabled.has("customize")
    ) {
      const target = entry.item.details.targets[0];
      const raw = await dependencies.prompt("Enter a JSON value: ");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw usage("The custom value must be valid JSON");
      }
      decisions = await reduceTemplateImportAction(
        decisions,
        {
          id: `action:customize:${entry.item.semanticKey}`,
          kind: "customize",
          target: target!,
          value,
        },
        actionContext(
          loaded.generation.generation,
          project,
          view,
          history.length > 1
        )
      );
    } else {
      await dependencies.prompt("That choice is not available. Press Enter to continue.");
      continue;
    }
    project = await resolveProjectState(project, decisions);
    view = projectTemplateImportView(
      actionContext(
        loaded.generation.generation,
        project,
        view,
        history.length > 1
      ).projection
    );
    index += 1;
  }
  return decisions;
}

async function runReview(
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath("review", args, flags, dependencies.cwd);
  const loaded = await loadProject(path.absolute);
  const explicit = [
    "apply-ready",
    "keep-current-for-remaining",
    "acknowledge-unsupported",
  ].some((flag) => hasFlag(flags, flag));
  const interactive =
    !hasFlag(flags, "non-interactive") &&
    dependencies.stdinIsTTY &&
    dependencies.stderrIsTTY;
  if (!explicit && !interactive) {
    return successResult("review", path.display, loaded.view, {
      openCount: loaded.view.summary.unanswered,
      diagnostics: [
        cliDiagnostic(
          "ATLCLI_PDF_TEMPLATE_REVIEW_NON_INTERACTIVE",
          renderPdfTemplateMessage(
            "ATLCLI_PDF_TEMPLATE_REVIEW_NON_INTERACTIVE",
            {},
            dependencies.locale
          ),
          [
            `atlcli pdf-template review ${path.display} --apply-ready`,
            `atlcli pdf-template review ${path.display} --keep-current-for-remaining --acknowledge-unsupported`,
            `atlcli pdf-template decide --dir ${path.display} --candidate <id> --accept`,
          ],
          "info"
        ),
      ],
    });
  }
  if (
    interactive &&
    loaded.project.analysis.hasVisualCandidates &&
    !(
      await loaded.repository.getPreview(
        loaded.generation.projectId,
        loaded.generation.generation,
        "asset-contact-sheet"
      )
    )
  ) {
    const compiler = await dependencies.createPreviewCompiler(
      loaded.project,
      loaded.privateIntake,
      loaded.assetStore
    );
    const rendered = await compiler.render({
      generation: loaded.generation.generation,
      snapshotDigest: loaded.project.snapshot.snapshotDigest,
      purpose: "asset-contact-sheet",
      summary: loaded.view.summary,
    });
    const artifact: TemplateProjectPreviewArtifactV1 = {
      generation: loaded.generation.generation,
      purpose: "asset-contact-sheet",
      snapshotDigest: loaded.project.snapshot.snapshotDigest,
      digest: rendered.digest,
      mediaType: rendered.mediaType,
      byteLength: rendered.byteLength,
      pageCount: rendered.pageCount,
      regions: rendered.regions,
      output: rendered.output,
    };
    await loaded.repository.putPreview(
      loaded.generation.projectId,
      artifact
    );
    await writeTemplateProjectProof(
      path.absolute,
      [artifact],
      COMPILER_VERSION
    );
  }
  const decisions = explicit
    ? await runReviewFlags(loaded, flags)
    : await interactiveReview(loaded, dependencies);
  if (
    canonicalCapabilityJson(decisions) ===
    canonicalCapabilityJson(loaded.project.decisions)
  ) {
    return successResult("review", path.display, loaded.view, {
      changedCount: 0,
      openCount: loaded.view.summary.unanswered,
    });
  }
  const committed = await commitDecisions(loaded, decisions);
  return successResult("review", path.display, committed.view, {
    changedCount: committed.changedCount,
    openCount: committed.view.summary.unanswered,
    outputDigest: committed.generation.generation,
    details: {
      undoCommand: `atlcli pdf-template undo ${path.display}`,
    },
  });
}

function findCandidate(
  project: TemplateProjectStateV1,
  id: string
): TemplateCandidateV1 {
  const candidate = project.analysis.candidates.find(
    (entry) => entry.id === id
  );
  if (!candidate) throw usage(`Unknown candidate: ${id}`);
  return candidate;
}

function assetDecision(
  loaded: Awaited<ReturnType<typeof loadProject>>,
  candidate: TemplateCandidateV1,
  flags: Record<string, string | boolean | string[]>
): TemplateImportActionV1 {
  const record = loaded.privateIntake.assetCandidates.find(
    (entry) => entry.candidateId === candidate.id
  );
  if (!record) {
    if (loaded.privateIntake.source.metadataOnly) {
      throw new PdfTemplateCliError(
        "ATLCLI_ERR_VALIDATION",
        5,
        "Graphic bytes were not extracted during metadata-only import. The active draft was retained.",
        [
              `atlcli pdf-template reanalyze ${loaded.privateIntake.source.name} --dir <project>`,
        ]
      );
    }
    throw usage("The selected candidate is not an available graphic");
  }
  const role = mapRole(flagString(flags, "role", true));
  if (!role) throw usage("--role is not a supported PDF graphic role");
  if (!hasFlag(flags, "rights-confirmed")) {
    throw usage("Graphic inclusion requires --rights-confirmed");
  }
  const accessibility = requireSingleChoice(
    flags,
    ["decorative", "meaningful"],
    "Choose exactly one of --decorative or --meaningful"
  );
  const alt = flagString(flags, "alt");
  if (accessibility === "decorative" && alt) {
    throw usage("--decorative cannot be combined with --alt");
  }
  if (accessibility === "meaningful" && !alt?.trim()) {
    throw usage("--meaningful requires non-empty --alt text");
  }
  const placement = requireSingleChoice(
    flags,
    ["slot-default", "use-candidate-placement", "custom-placement"],
    "Choose exactly one placement: --slot-default, --use-candidate-placement, or --custom-placement <json>"
  );
  let rendering:
    | { kind: "slot-default" }
    | {
        kind: "candidate-placement" | "custom-placement";
        placement: Readonly<Record<string, unknown>>;
      };
  if (placement === "slot-default") {
    rendering = { kind: "slot-default" };
  } else if (placement === "use-candidate-placement") {
    if (!record.candidatePlacement) {
      throw usage("This graphic has no stable candidate placement; use --slot-default or --custom-placement");
    }
    rendering = {
      kind: "candidate-placement",
      placement: record.candidatePlacement,
    };
  } else {
    const raw = flagString(flags, "custom-placement", true)!;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw usage("--custom-placement must contain a JSON object");
    }
    if (!isRecord(value)) throw usage("--custom-placement must contain a JSON object");
    rendering = { kind: "custom-placement", placement: value };
  }
  return {
    id: `action:review-asset:${candidate.semanticKey}`,
    kind: "review-asset",
    candidateId: candidate.id,
    assetSha256: record.asset.sha256,
    role,
    useConfirmed: true,
    rightsConfirmed: true,
    accessibility:
      accessibility === "decorative"
        ? { decorative: true }
        : { decorative: false, alt: alt!.trim() },
    rendering,
  };
}

async function runDecide(
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath("decide", args, flags, dependencies.cwd);
  const loaded = await loadProject(path.absolute);
  const action = requireSingleChoice(
    flags,
    [
      "accept-safe",
      "accept-recommended",
      "accept",
      "reject",
      "accept-asset",
      "use-baseline",
      "reset-group",
      "keep-baseline-for-remaining",
      "acknowledge-unsupported",
    ],
    "decide requires exactly one decision action"
  );
  let decisions = loaded.project.decisions;
  if (action === "accept-safe") {
    decisions = await acceptSafeCandidates(
      decisions,
      loaded.project.analysis.candidates,
      decisionContext(loaded.project)
    );
  } else if (action === "accept-recommended") {
    decisions = await acceptRecommendedCandidates(
      decisions,
      loaded.project.analysis.candidates,
      decisionContext(loaded.project)
    );
  } else if (
    action === "keep-baseline-for-remaining" ||
    action === "acknowledge-unsupported"
  ) {
    const kind =
      action === "keep-baseline-for-remaining"
        ? "keep-current-for-remaining"
        : "acknowledge-inventory";
    decisions = await reduceGlobalAction(
      decisions,
      loaded.generation.generation,
      loaded.project,
      loaded.view,
      (await loaded.repository.listHistory(loaded.generation.projectId)).length >
        1,
      kind
    );
  } else if (action === "use-baseline" || action === "reset-group") {
    const groupId = flagString(flags, "group", true)!;
    decisions = reduceTemplateDecision(
      decisions,
      {
        kind: action === "use-baseline" ? "use-baseline" : "reset-tombstone",
        semanticKey: "*",
        scope: { kind: "group", groupId },
      },
      decisionContext(loaded.project)
    );
  } else {
    const candidate = findCandidate(
      loaded.project,
      flagString(flags, "candidate", true)!
    );
    if (action === "accept") {
      decisions = reduceTemplateDecision(
        decisions,
        {
          kind: "accept-candidate",
          candidate,
          decidedBy: { kind: "user" },
        },
        decisionContext(loaded.project)
      );
    } else if (action === "reject") {
      decisions = reduceTemplateDecision(
        decisions,
        { kind: "reject-candidate", candidate },
        decisionContext(loaded.project)
      );
    } else {
      decisions = await reduceTemplateImportAction(
        decisions,
        assetDecision(loaded, candidate, flags),
        actionContext(
          loaded.generation.generation,
          loaded.project,
          loaded.view,
          (await loaded.repository.listHistory(loaded.generation.projectId))
            .length > 1
        )
      );
    }
  }
  const committed = await commitDecisions(loaded, decisions);
  return successResult("decide", path.display, committed.view, {
    changedCount: committed.changedCount,
    openCount: committed.view.summary.unanswered,
    outputDigest: committed.generation.generation,
    details: { undoCommand: `atlcli pdf-template undo ${path.display}` },
  });
}

async function runEdit(
  command: "clear-optional" | "clear-override" | "set",
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath(command, args, flags, dependencies.cwd);
  const loaded = await loadProject(path.absolute);
  const target = flagString(flags, "target", true)!;
  let decision:
    | { kind: "clear-optional"; target: string }
    | { kind: "clear-override"; target: string }
    | { kind: "override"; target: string; value: unknown };
  if (command === "set") {
    const raw = flagString(flags, "value", true)!;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw usage("--value must be valid JSON");
    }
    decision = { kind: "override", target, value };
  } else {
    decision = { kind: command, target };
  }
  const decisions = reduceTemplateDecision(
    loaded.project.decisions,
    decision,
    decisionContext(loaded.project)
  );
  const committed = await commitDecisions(loaded, decisions);
  return successResult(command, path.display, committed.view, {
    changedCount: committed.changedCount,
    openCount: committed.view.summary.unanswered,
    outputDigest: committed.generation.generation,
    details: { undoCommand: `atlcli pdf-template undo ${path.display}` },
  });
}

async function runReanalyze(
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const source = sourcePath(args, "reanalyze", dependencies.cwd);
  const path = templateProjectPath("reanalyze", args, flags, dependencies.cwd);
  const loaded = await loadProject(path.absolute);
  const bytes = await dependencies.readBytes(source.absolute).catch(() => {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_IO",
      1,
      `Could not read ${source.display}. The active draft was retained.`,
      [`Check the file and retry: atlcli pdf-template reanalyze ${source.display} --dir ${path.display}`]
    );
  });
  const analyzed = await analyzeSource(
    bytes,
    source,
    hasFlag(flags, "metadata-only"),
    loaded.assetStore,
    dependencies
  );
  const selected = baseline(loaded.project.baseline.id);
  const reconciled = await reanalyzeTemplateProject({
    current: loaded.project,
    analysis: analyzed.analysis,
    catalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
      descriptor: PDF_TEMPLATE_CAPABILITIES_V1,
    },
    baseline: {
      id: selected.id,
      version: selected.version,
      digest: loaded.project.baseline.digest,
      design: selected.design,
    },
  });
  const project: TemplateProjectStateV1 = {
    ...reconciled,
    assetHandles: {
      ...reconciled.assetHandles,
      ...analyzed.assetHandles,
    },
  };
  const generation = await loaded.repository.commit({
    projectId: loaded.generation.projectId,
    expectedGeneration: loaded.generation.generation,
    analysisDigest: project.analysis.digest,
    decisions: project.decisions,
    snapshotDigest: project.snapshot.snapshotDigest,
    project,
    privateIntake: analyzed.privateIntake,
  });
  const view = await projectView(loaded.repository, generation);
  const staleness = project.snapshot.staleness.reduce<Record<string, number>>(
    (counts, entry) => {
      counts[entry.state] = (counts[entry.state] ?? 0) + 1;
      return counts;
    },
    {}
  );
  return successResult("reanalyze", path.display, view, {
    inputDigest: project.analysis.sourceDigest,
    outputDigest: generation.generation,
    changedCount: changedDecisionCount(
      loaded.project.decisions,
      project.decisions
    ),
    openCount: view.summary.unanswered,
    details: {
      reconciliation: staleness,
      undoCommand: `atlcli pdf-template undo ${path.display}`,
    },
  });
}

async function acceptedRuntimeAssets(
  project: TemplateProjectStateV1,
  assetStore: DirectoryTemplateAssetStore
) {
  const values = [];
  for (const decision of project.decisions.decisions) {
    if (decision.kind !== "accept-asset") continue;
    const handle = project.assetHandles[decision.assetSha256];
    if (!handle) {
      throw new TemplateProjectBuildError(
        "asset-unavailable",
        ["review-asset", "reanalyze"],
        `Accepted asset ${decision.semanticKey} is unavailable`
      );
    }
    await assetStore.verify(handle);
    values.push({
      slot: decision.role,
      sha256: decision.assetSha256,
      mediaType: handle.mediaType,
      bytes: await assetStore.get(handle),
      accessibility: decision.accessibility,
      rendering: decision.rendering,
    });
  }
  return values;
}

async function runPreview(
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath("preview", args, flags, dependencies.cwd);
  const outputDirectory = flagString(flags, "output-dir");
  const loaded = await loadProject(path.absolute);
  const action = loaded.view.availableActions.find(
    ({ kind }) => kind === "preview"
  );
  if (!action?.enabled) {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_VALIDATION",
      5,
      "A preview cannot be created while review items or blockers remain. The active draft was retained.",
      [`atlcli pdf-template review ${path.display}`]
    );
  }
  const compiler = await dependencies.createPreviewCompiler(
    loaded.project,
    loaded.privateIntake,
    loaded.assetStore
  );
  dependencies.onProgress({
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "pdf-template.preview",
    phase: "rendering-preview",
    completed: 0,
    total: 1,
  });
  const rendered = await renderTemplateProjectPreviews({
    generation: loaded.generation.generation,
    snapshotDigest: loaded.project.snapshot.snapshotDigest,
    summary: loaded.view.summary,
    hasVisualCandidates: loaded.project.analysis.hasVisualCandidates,
    compiler,
  });
  const decisions = await reduceGlobalAction(
    loaded.project.decisions,
    loaded.generation.generation,
    loaded.project,
    loaded.view,
    (await loaded.repository.listHistory(loaded.generation.projectId)).length >
      1,
    "preview"
  );
  const committed = await commitDecisions(loaded, decisions);
  const artifacts = Object.values(rendered).map((artifact) => ({
    ...artifact,
    generation: committed.generation.generation,
  }));
  for (const artifact of artifacts) {
    await loaded.repository.putPreview(
      loaded.generation.projectId,
      artifact
    );
  }
  const proof = await writeTemplateProjectProof(
    path.absolute,
    artifacts,
    COMPILER_VERSION,
    outputDirectory
      ? resolve(dependencies.cwd, outputDirectory)
      : undefined
  );
  dependencies.onProgress({
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "pdf-template.preview",
    phase: "rendering-preview",
    completed: 1,
    total: 1,
  });
  return successResult("preview", path.display, committed.view, {
    changedCount: 1,
    openCount: committed.view.summary.unanswered,
    outputDigest: committed.generation.generation,
    outputs: Object.fromEntries(
      proof.artifacts.map(({ purpose, file }) => [
        purpose,
        outputDirectory
          ? join(outputDirectory, file)
          : join(path.display, "proof", file),
      ])
    ),
    details: {
      proofResults: outputDirectory
        ? join(outputDirectory, "results.json")
        : join(path.display, "proof", "results.json"),
      undoCommand: `atlcli pdf-template undo ${path.display}`,
    },
  });
}

async function collectPreviews(
  loaded: Awaited<ReturnType<typeof loadProject>>
): Promise<
  Readonly<
    Partial<
      Record<
        TemplateProjectPreviewArtifactV1["purpose"],
        TemplateProjectPreviewArtifactV1
      >
    >
  >
> {
  const purposes: TemplateProjectPreviewArtifactV1["purpose"][] = [
    "design-review",
    "compatibility-proof",
    ...(loaded.project.analysis.hasVisualCandidates
      ? (["asset-contact-sheet"] as const)
      : []),
  ];
  const values = await Promise.all(
    purposes.map(async (purpose) => [
      purpose,
      await loaded.repository.getPreview(
        loaded.generation.projectId,
        loaded.generation.generation,
        purpose
      ),
    ] as const)
  );
  return Object.fromEntries(values.filter((entry) => entry[1] !== undefined));
}

async function buildCurrent(
  loaded: Awaited<ReturnType<typeof loadProject>>
) {
  return buildTemplateProject({
    generation: loaded.generation.generation,
    project: loaded.project,
    catalog: loaded.project.catalog,
    baseline: loaded.project.baseline,
    view: loaded.view,
    previews: await collectPreviews(loaded),
    assetStore: loaded.assetStore,
    materializer: new PdfTemplateRuntimeMaterializer(),
  });
}

async function runValidate(
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath("validate", args, flags, dependencies.cwd);
  const loaded = await loadProject(path.absolute);
  const build = await buildCurrent(loaded);
  return successResult("validate", path.display, loaded.view, {
    inputDigest: loaded.project.snapshot.snapshotDigest,
    outputDigest: await sha256Hex(
      new TextEncoder().encode(build.runtimeSnapshotJson)
    ),
    openCount: loaded.view.summary.unanswered,
  });
}

async function runBuild(
  command: "build" | "pack",
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath(command, args, flags, dependencies.cwd);
  const configuredOutput = flagString(flags, "output");
  if (command === "pack" && !configuredOutput) {
    throw usage("pack requires --output");
  }
  const outputPath =
    configuredOutput ??
    `./${basename(path.absolute)}.wiki-pdf-template`;
  const loaded = await loadProject(path.absolute);
  dependencies.onProgress({
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "pdf-template.build",
    phase: "validating",
    completed: 0,
    total: 2,
  });
  const build = await buildCurrent(loaded);
  dependencies.onProgress({
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "pdf-template.build",
    phase: "packing",
    completed: 1,
    total: 2,
  });
  const packed = await buildGeneratedPdfTemplatePack(
    build,
    new CliGeneratedPdfTemplateCompiler()
  );
  const written = await writeTemplateProjectBuild(
    path.absolute,
    build,
    packed.bytes,
    resolve(dependencies.cwd, outputPath)
  );
  const decisions = await reduceGlobalAction(
    loaded.project.decisions,
    loaded.generation.generation,
    loaded.project,
    loaded.view,
    (await loaded.repository.listHistory(loaded.generation.projectId)).length >
      1,
    "build"
  );
  const committed = await commitDecisions(loaded, decisions);
  dependencies.onProgress({
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "pdf-template.build",
    phase: "packing",
    completed: 2,
    total: 2,
  });
  return successResult(command, path.display, committed.view, {
    changedCount: 1,
    openCount: committed.view.summary.unanswered,
    outputDigest: await sha256Hex(packed.bytes),
    outputs: {
      archive: outputPath,
      dist: written.distDirectory,
    },
    details: {
      compileDigest: packed.compile.digest,
      pageCount: packed.compile.pageCount,
      undoCommand: `atlcli pdf-template undo ${path.display}`,
    },
  });
}

async function runUndo(
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  const path = templateProjectPath("undo", args, flags, dependencies.cwd);
  const loaded = await loadProject(path.absolute);
  const history = await loaded.repository.listHistory(loaded.generation.projectId);
  const target = history.at(-2);
  if (!target) {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_VALIDATION",
      5,
      "There is no earlier authoring generation to restore. The active draft was retained.",
      [`atlcli pdf-template status ${path.display}`]
    );
  }
  const targetGeneration = await loaded.repository.readGeneration(
    loaded.generation.projectId,
    target.generation
  );
  if (!targetGeneration.project) {
    throw new PdfTemplateCliError(
      "ATLCLI_ERR_VALIDATION",
      5,
      "The earlier generation has no restorable authoring state. The active draft was retained.",
      [`atlcli pdf-template status ${path.display}`]
    );
  }
  const selected = baseline(loaded.project.baseline.id);
  const prepared = await prepareTemplateProjectUndo({
    current: loaded.project,
    targetDecisions: targetGeneration.project.decisions,
    catalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
      descriptor: PDF_TEMPLATE_CAPABILITIES_V1,
    },
    baseline: {
      id: selected.id,
      version: selected.version,
      digest: loaded.project.baseline.digest,
      design: selected.design,
    },
  });
  const generation = await loaded.repository.undo({
    projectId: loaded.generation.projectId,
    expectedGeneration: loaded.generation.generation,
    targetGeneration: target.generation,
    preparedProject: prepared,
  });
  const view = await projectView(loaded.repository, generation);
  return successResult("undo", path.display, view, {
    changedCount: changedDecisionCount(
      loaded.project.decisions,
      prepared.decisions
    ),
    openCount: view.summary.unanswered,
    outputDigest: generation.generation,
  });
}

export async function executePdfTemplateCommand(
  args: readonly string[],
  flags: Record<string, string | boolean | string[]>,
  dependencies: PdfTemplateCliDependencies
): Promise<PdfTemplateCliResultV1> {
  validatePdfTemplateCliCopyCoverage(DEFAULT_PDF_TEMPLATE_CLI_COPY);
  const command = args[0];
  if (!command) throw usage("Choose a pdf-template command");
  validateFlags(command, flags);
  if (
    !["analyze", "import", "reanalyze"].includes(command) &&
    args.length > 2
  ) {
    throw usage(`${command} accepts only one project path`);
  }
  switch (command) {
    case "import":
    case "analyze":
      return runAnalyze(command, args, flags, dependencies);
    case "status":
    case "diff":
      return runStatusLike(command, args, flags, dependencies);
    case "review":
      return runReview(args, flags, dependencies);
    case "reanalyze":
      return runReanalyze(args, flags, dependencies);
    case "decide":
      return runDecide(args, flags, dependencies);
    case "set":
    case "clear-override":
    case "clear-optional":
      return runEdit(command, args, flags, dependencies);
    case "preview":
      return runPreview(args, flags, dependencies);
    case "validate":
      return runValidate(args, flags, dependencies);
    case "build":
    case "pack":
      return runBuild(command, args, flags, dependencies);
    case "undo":
      return runUndo(args, flags, dependencies);
    default:
      throw usage(`Unknown pdf-template command: ${command}`);
  }
}

function wrap(text: string, width: number, indent = ""): string {
  const usable = Math.max(24, width - indent.length);
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > usable) {
      lines.push(`${indent}${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(`${indent}${line}`);
  return lines.join("\n");
}

function stageLabel(stage: TemplateImportViewV1["stage"]): string {
  return {
    analyzing: "Analyzing",
    "review-required": "Review required",
    "ready-to-preview": "Ready to preview",
    "ready-to-build": "Ready to build",
    built: "Built",
    "source-changed": "Source changed",
    blocked: "Blocked",
  }[stage];
}

export function presentPdfTemplateResult(
  result: PdfTemplateCliResultV1,
  options: {
    width: number;
    details: boolean;
    color: boolean;
    unicode: boolean;
    locale: string;
  }
): string {
  if (!result.ok) {
    const first = result.diagnostics[0];
    const message = first?.message ?? "The command failed.";
    const rendered = [
      message,
      ...(/active draft was retained/iu.test(message)
        ? []
        : ["The active draft was retained."]),
      ...result.diagnostics.flatMap(({ recoveryCommands }) =>
        recoveryCommands.map((command) => `Recover: ${command}`)
      ),
      ...(options.details && first ? [`Code: ${first.code}`] : []),
    ].join("\n");
    if (!options.color) return rendered;
    const firstLineEnd = rendered.indexOf("\n");
    const heading =
      firstLineEnd === -1 ? rendered : rendered.slice(0, firstLineEnd);
    const remainder =
      firstLineEnd === -1 ? "" : rendered.slice(firstLineEnd);
    return `\u001b[31m${heading}\u001b[0m${remainder}`;
  }
  const view = result.view;
  if (!view) return `${result.command} completed.`;
  const marker = options.unicode ? "✓" : "OK";
  const lines: string[] = [];
  if (result.command === "import" || result.command === "analyze") {
    const source = String(result.details?.sourceName ?? "Word document");
    lines.push(`Analyzed ${source}`, "");
    lines.push(`${view.summary.readyToApply} design choices are ready to apply`);
    lines.push(` ${view.summary.needsReview} need your review`);
    lines.push(
      ` ${view.summary.cannotTransfer} Word features cannot be transferred`,
      "",
      result.changedCount === 0
        ? "No Word suggestions have been applied yet."
        : `${result.changedCount} ready changes were applied by explicit policy.`,
      `The draft currently uses ${
        result.details?.baseline === BUILTIN_PDF_TEMPLATE_ID
          ? "Editorial Indigo"
          : String(result.details?.baseline)
      }.`
    );
  } else {
    lines.push(`${marker} ${stageLabel(view.stage)}`);
    lines.push(
      `Ready ${view.summary.readyToApply} | Review ${view.summary.needsReview} | Cannot transfer ${view.summary.cannotTransfer} | Blockers ${view.summary.blockers}`
    );
    lines.push(
      `Preview: design review ${view.preview.designReview}; compatibility proof ${view.preview.compatibilityProof}`
    );
    if (result.changedCount !== undefined) {
      lines.push(
        `Changed: ${result.changedCount}; unchanged or open: ${result.openCount ?? view.summary.unanswered}`
      );
    }
    for (const diagnostic of result.diagnostics) {
      lines.push("", wrap(`${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`, options.width));
      for (const recovery of diagnostic.recoveryCommands) {
        lines.push(wrap(`Try: ${recovery}`, options.width, "  "));
      }
    }
    if (result.outputs) {
      lines.push("");
      for (const [name, path] of Object.entries(result.outputs)) {
        lines.push(`${name}: ${path}`);
      }
    }
  }
  lines.push("", `Project: ${result.projectPath}`);
  const next = result.nextActions[0];
  if (next) lines.push(`Next: ${next}`);
  const undo = result.details?.undoCommand;
  if (undo) lines.push(`Undo: ${String(undo)}`);
  if (options.details) {
    lines.push(`Generation: ${view.generation}`);
    for (const section of view.sections) {
      for (const item of section.items) {
        lines.push(
          `${section.id}/${item.id}: ${item.details.targets.join(", ")}; ${item.details.candidateIds.join(", ")}`
        );
      }
    }
  }
  const rendered = lines
    .map((line) => (line ? wrap(line, options.width) : line))
    .join("\n");
  if (!options.color) return rendered;
  const firstLineEnd = rendered.indexOf("\n");
  const heading =
    firstLineEnd === -1 ? rendered : rendered.slice(0, firstLineEnd);
  const remainder =
    firstLineEnd === -1 ? "" : rendered.slice(firstLineEnd);
  const color =
    view.stage === "blocked" || view.stage === "source-changed"
      ? 31
      : view.stage === "review-required"
        ? 33
        : view.stage === "analyzing"
          ? 36
          : 32;
  return `\u001b[${color}m${heading}\u001b[0m${remainder}`;
}

function errorResult(
  command: string,
  error: unknown,
  locale: string,
  projectPath?: string
): PdfTemplateCliResultV1 {
  if (error instanceof PdfTemplateCliError) {
    return {
      schema: RESULT_SCHEMA,
      command,
      ok: false,
      exitCode: error.exitCode,
      diagnostics: [
        cliDiagnostic(
          error.machineCode,
          error.message,
          error.recoveryCommands,
          "error",
          error.name
        ),
      ],
      nextActions: error.recoveryCommands,
    };
  }
  if (error instanceof TemplateProjectBuildError) {
    const project = projectPath ?? "<project>";
    const recovery = error.recoveryActions.map((action) => {
      switch (action) {
        case "acknowledge-inventory":
          return `atlcli pdf-template review ${project} --acknowledge-unsupported`;
        case "migrate-catalog":
        case "reanalyze":
          return `atlcli pdf-template reanalyze <updated.docx> --dir ${project}`;
        case "review-asset":
          return `atlcli pdf-template review ${project}`;
        default:
          return `atlcli pdf-template ${action} ${project}`;
      }
    });
    return {
      schema: RESULT_SCHEMA,
      command,
      ok: false,
      exitCode: 5,
      diagnostics: [
        cliDiagnostic(
          "ATLCLI_ERR_VALIDATION",
          `${error.message}. The active draft was retained.`,
          recovery,
          "error",
          error.code
        ),
      ],
      nextActions: recovery,
    };
  }
  if (
    error instanceof TemplateAuthoringError ||
    error instanceof PdfTemplateProjectFsError
  ) {
    return {
      schema: RESULT_SCHEMA,
      command,
      ok: false,
      exitCode:
        error instanceof TemplateAuthoringError ? 5 : 1,
      diagnostics: [
        cliDiagnostic(
          error instanceof TemplateAuthoringError
            ? "ATLCLI_ERR_VALIDATION"
            : "ATLCLI_ERR_IO",
          `${error.message}. The active draft was retained.`,
          [],
          "error",
          error.code
        ),
      ],
      nextActions: [],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    schema: RESULT_SCHEMA,
    command,
    ok: false,
    exitCode: 1,
    diagnostics: [
      cliDiagnostic(
        "ATLCLI_ERR_IO",
        `${message}. The active draft was retained.`,
        [],
        "error",
        locale
      ),
    ],
    nextActions: [],
  };
}

export async function handlePdfTemplate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h") || args.length === 0) {
    output(pdfTemplateHelp(), opts);
    return;
  }
  const dependencies = defaultDependencies(opts.json, flags);
  let result: PdfTemplateCliResultV1;
  try {
    result = await executePdfTemplateCommand(args, flags, dependencies);
  } catch (error) {
    const command = args[0] ?? "help";
    const flagProject = flags.dir;
    const projectPath =
      typeof flagProject === "string"
        ? flagProject
        : !["analyze", "import", "reanalyze"].includes(command)
          ? args[1]
          : undefined;
    result = errorResult(
      command,
      error,
      dependencies.locale,
      projectPath
    );
  }
  if (opts.json) {
    output(result, opts);
  } else {
    const text = presentPdfTemplateResult(result, {
      width: dependencies.columns,
      details: hasFlag(flags, "details"),
      color: !dependencies.noColor,
      unicode: dependencies.unicode,
      locale: dependencies.locale,
    });
    const target = result.ok ? process.stdout : process.stderr;
    target.write(`${text}\n`);
  }
  if (!result.ok) throw new ReportedPdfTemplateCliError(result.exitCode);
}

export function pdfTemplateHelp(): string {
  return `atlcli pdf-template <command>

Turn the design of a Word document into a reviewed PDF template pack.

Four steps:
  1. import   Analyze Word design choices into a local draft
  2. review   Choose what to use; nothing is applied silently
  3. preview  Create a visual design review and compatibility proof
  4. build    Validate, compile, and save the verified template pack

Example:
  $ atlcli pdf-template import brand.docx
  Analyzed brand.docx
  12 design choices are ready to apply
   4 need your review
   3 Word features cannot be transferred
  Next: atlcli pdf-template review ./brand-pdf-template

  atlcli pdf-template review ./brand-pdf-template
  atlcli pdf-template preview ./brand-pdf-template
  atlcli pdf-template build ./brand-pdf-template --output ./brand.wiki-pdf-template

Primary commands:
  import <docx>          Create a no-clobber project using Editorial Indigo
  status <project>       Resume safely without changing the project
  review <project>       Review grouped business-facing choices
  preview <project>      Write design-review and compatibility PDFs locally
  build <project>        Create one verified .wiki-pdf-template archive
  undo <project>         Restore prior authoring intent as a new generation

Expert and automation commands:
  analyze, reanalyze, diff, decide, set, clear-override, clear-optional,
  validate, pack

Import defaults:
  --baseline builtin.editorial-indigo
  --policy suggest-only       Never applies a suggestion during import
  --dir ./<docx-name>-pdf-template
  --metadata-only             Do not extract local graphic bytes

Important boundaries:
  Embedded graphics are extracted only to the local project's ignored .intake
  area. A graphic enters the pack only after role, rights, accessibility, and
  placement are explicitly confirmed. The final pack contains the resolved
  design and accepted assets, not the Word document or authoring history.

  "pdf-template" manages PDF design packs. "wiki template" manages Confluence
  page templates; the two command domains are intentionally separate.

Automation:
  --json implies --non-interactive. JSON writes exactly one result document to
  stdout; progress is JSONL on stderr. Use --details to reveal technical IDs
  and digests in text output. --no-color (or NO_COLOR) disables ANSI status
  color; --ascii uses portable status markers.
`;
}
