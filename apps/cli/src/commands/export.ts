import { assertCliAuthSupported } from "./session-guard.js";
import {
  InvalidCodeThemeError,
  resolveCodeThemeId,
  type CodeThemeId,
} from "@atlcli/code-highlight/registry";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  ERROR_CODES,
  OutputOptions,
  buildConfluenceUrl,
  fail,
  getConfluenceBaseUrl,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  normalizeBaseUrl,
  output,
  type Profile,
} from "@atlcli/core";
import {
  ConfluenceClient,
  exportSourcePolicyFromFlag,
  resolveExportMentions,
  type ComposeOptions,
} from "@atlcli/confluence";
import type {
  DocxExportJobRequestV1,
  ExportJobDerivationV1,
  ExportJobRequestV1,
  ResourceEstimateV1,
} from "@atlcli/export-jobs";
import {
  templatePackReference,
  type PdfTemplateReferenceV1,
} from "@atlcli/export-jobs";
import { createFileExportJobPersistence } from "@atlcli/export-node";
import {
  CURATED_PDF_TEMPLATE_RECIPES_V2,
  PDF_OUTPUT_STANDARDS_V1,
  loadPdfTemplatePack,
  materializePdfTemplateRecipeV2,
  type PdfOutputPolicyV1,
} from "@atlcli/pdf";
import type { ExportReport as DocxEngineReport } from "@atlcli/docx";
import {
  ExportRequestError,
  buildExportScope,
  buildScopeReportFields,
  parseExportRequest,
  type ParsedExportRequest,
} from "./export-request.js";
import {
  buildReport,
  buildTreeExportReport,
  classifyConfluenceSourceError,
  classifyError,
  classifyFailedExportJob,
  emitReportOutcome,
  noteToIssue,
  type ExportOutcome,
} from "./export-report.js";
import { buildCliDocxJobRequest, buildCliPdfJobRequest } from "./export-job-request.js";
import {
  createOrdinaryDocxExecutorV1,
  readOrdinaryExportProjectionV1,
  runOrdinaryExportJobV1,
  writeOrdinaryExportProjectionV1,
} from "./export-job-runtime.js";
import { formatConfluenceHierarchyDiagnosticV1 } from "./export-job-monitor.js";
import {
  checkpointDocxAssetsV1,
  confluenceSourceResolverPortFromClientV1,
  createConfluenceDocxResolveInputV1,
  createConfluenceSourcePlanSpoolV1,
  createExportTreeBodySpoolV1,
} from "@atlcli/export-wiring/jobs";
import {
  createAssetByteCache,
  tokenAssetFetcher,
  tokenMentionLookup,
  type LoadedExportTemplate,
} from "./export-internals.js";
import { handleExportJobs } from "./export-jobs.js";
import { unknownSubcommand } from "./unknown-subcommand.js";

/**
 * `--template`, or its documented short form `-t`.
 *
 * `-t` is advertised in `--help` (`--template, -t`), in
 * `docs/confluence/export.md`'s option table, and in worked examples in both
 * — and was read NOWHERE. The effect was
 * silent on the engine we ship: `--engine ts -t corporate.docx` exported with
 * the BUNDLED DEFAULT template and reported `template-default-used`, which
 * reads as "you passed no template". On `--engine python` it failed with
 * "--template is required" while the user was looking at the template they had
 * just passed. `--output`/`-o` had honoured its alias all along, which is what
 * made the gap invisible in review.
 *
 * Both readers go through this pair so the alias cannot drift back apart: the
 * DOCX path needs the VALUE, the `--format pdf` guard needs only PRESENCE (it
 * rejects `--template` outright, and rejecting it for the long spelling only
 * would have let `-t` through into a PDF export that silently ignored it).
 */
function templateFlag(flags: Record<string, string | boolean | string[]>): string | undefined {
  return getFlag(flags, "template") ?? getFlag(flags, "t");
}

export async function handleExport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  rawOpts: OutputOptions
): Promise<void> {
  if (args[0] === "jobs") {
    await handleExportJobs(args.slice(1), flags, rawOpts, {
      executeReplay: async (request, snapshot) =>
        executeStoredExportJob(request, rawOpts, snapshot.derivedFrom),
    });
    return;
  }

  // `--report json` is a synonym for `--json`: both emit exactly the
  // `atlcli.export-report/1` schema as the sole stdout document (T3.4), for
  // every format the help documents it under ("PDF and ts-engine exports").
  // Normalize ONCE here, above the format branch — this used to live inside
  // handlePdfExport, so every DOCX path read the un-normalized opts and
  // `--engine ts --report json` printed the human summary instead of the
  // report. A malformed `--report <other>` is a usage error.
  const reportFlag = getFlag(flags, "report");
  if (reportFlag !== undefined && reportFlag !== "json") {
    fail(rawOpts, 1, ERROR_CODES.USAGE, `Unknown --report "${reportFlag}". Only "json" is supported.`);
  }
  const opts: OutputOptions = { ...rawOpts, json: rawOpts.json || reportFlag === "json" };

  // Show help if --help or -h flag is set
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(exportHelp(), opts);
    return;
  }

  // Handle template subcommands: export template list|save|delete
  if (args[0] === "template") {
    const [, sub, ...rest] = args;
    switch (sub) {
      case "list":
        await listTemplates(flags, opts);
        return;
      case "save":
        await saveTemplate(rest, flags, opts);
        return;
      case "delete":
        await deleteTemplate(rest, flags, opts);
        return;
      default:
        unknownSubcommand(sub, exportHelp(), opts);
        return;
    }
  }

  // Determine the output FORMAT first (spec 008 T3.2). `--format` defaults to
  // `docx` (backwards compatible); PDF takes an entirely separate, format-aware
  // validation + report path and never requires `--template`/`--engine`.
  const format = getFlag(flags, "format") ?? "docx";
  if (format !== "docx" && format !== "pdf") {
    fail(opts, 1, ERROR_CODES.USAGE, `Unknown --format "${format}". Use "docx" or "pdf".`);
  }
  if (format === "pdf") {
    await handlePdfExport(args, flags, opts);
    return;
  }

  // Parse scope/label/completeness flags into a serializable request BEFORE any
  // client/network work (spec 002). This replaces the unconditional args[0]
  // requirement so `--scope space --space DOCSY` (no positional page ref) is a
  // valid, pre-validated invocation. Every invalid flag combination fails here
  // with a USAGE error naming the conflict.
  let request: ParsedExportRequest;
  try {
    request = parseExportRequest(args[0], flags);
  } catch (error) {
    if (error instanceof ExportRequestError) {
      fail(opts, 1, ERROR_CODES.USAGE, error.message);
    }
    throw error;
  }
  let codeTheme: CodeThemeId;
  try {
    codeTheme = resolveCodeThemeId(getFlag(flags, "code-theme"));
  } catch (error) {
    if (error instanceof InvalidCodeThemeError) {
      fail(opts, 1, ERROR_CODES.USAGE, error.message);
    }
    throw error;
  }
  // `--engine python` is rejected inside parseExportRequest (it owns every
  // engine verdict, so the rule is unit-testable without a process), and lands
  // in the USAGE branch above like any other bad flag value.

  const templatePath = templateFlag(flags);
  const outputPath = getFlag(flags, "output") ?? getFlag(flags, "o");
  let embedImages = !hasFlag(flags, "no-images");
  if (hasFlag(flags, "embed-images")) {
    embedImages = true;
  }
  if (hasFlag(flags, "no-images")) {
    embedImages = false;
  }
  // `--no-toc-prompt` was named when the dirty flag was thought of as a TOC
  // feature. It governs `w:updateFields`, which covers caption numbering,
  // cross-references and running heads too, so the honest spelling is
  // `--no-field-update-prompt`. The old name keeps working — it is documented,
  // it is in people's scripts, and a flag that silently stops being recognized
  // is worse than a flag with two names.
  const noFieldUpdatePrompt =
    hasFlag(flags, "no-field-update-prompt") || hasFlag(flags, "no-toc-prompt");
  // Spec 003 C4 progressive disclosure: keep scroll-only/scroll-ignore bodies
  // for debugging ("why is section X missing?"). Engine option:
  // exportControls "passthrough". The shared source resolver applies it to page,
  // tree, and space scopes before either TypeScript renderer sees the blocks.
  const keepIgnored = hasFlag(flags, "keep-ignored");

  // spec 004: `--no-live-macros` suppresses live (port-backed) macro renderers
  // for deterministic/compliance exports.
  const noLiveMacros = hasFlag(flags, "no-live-macros");

  // `--template` is optional: `@atlcli/export-node` ships a
  // deterministic default template with correct `$scroll.title` /
  // `$scroll.exportdate` / `$scroll.content` placeholders, so the zero-config
  // path produces a document with nothing unfilled. Requiring the flag is what
  // pushed first-time ts users toward grabbing whatever `.docx` was at hand —
  // including docxtpl templates this engine cannot fill (see the
  // `template-foreign-placeholders` note).

  if (!outputPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--output is required.");
  }

  // Get Confluence client (needed for profile name in template resolution)
  const { client, profile } = await getClient(flags, opts);

  // Resolve template path (with profile for hierarchical lookup). Undefined
  // means "use the bundled default".
  let resolvedTemplatePath: string | undefined;
  if (templatePath) {
    resolvedTemplatePath = await resolveTemplatePath(templatePath, profile.name);
    if (!existsSync(resolvedTemplatePath)) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template not found: ${resolvedTemplatePath}`);
    }
  } else if (!opts.json) {
    // The report carries a `template-default-used` note, but the text-mode
    // summary line shows only warning COUNTS — so say it here too. Never in
    // `--json` mode: stderr is the progress JSONL channel there.
    process.stderr.write("hint: no --template given; using the bundled default template.\n");
  }

  const baseUrl = getConfluenceBaseUrl(profile);
  const internals = await import("./export-internals.js");
  const template = await internals.loadExportTemplate(resolvedTemplatePath);
  const templateSha256 = createHash("sha256").update(template.bytes).digest("hex");
  const id = randomUUID();
  const jobRequest = buildCliDocxJobRequest({
    id,
    idempotencyKey: `cli-export:${id}`,
    createdAt: Date.now(),
    request,
    profile,
    outputPath,
    template: {
      recordKey: resolvedTemplatePath ?? "bundled:default-docx",
      sha256: templateSha256,
      name: template.meta.name,
    },
    embedImages,
    keepIgnored,
    strict: hasFlag(flags, "strict"),
    noFieldUpdatePrompt,
    // The pre-job TypeScript path atomically replaced an existing DOCX.
    overwriteExisting: true,
    codeTheme,
    liveMacros: !noLiveMacros,
  });
  const outcome = await exportDocxAsOrdinaryJob({
    client,
    profile,
    request,
    baseUrl,
    outputPath,
    template,
    opts,
  }, jobRequest);
  emitReportOutcome(outcome, opts);
  return;

}

/**
 * `--template` for PDF: a `.wiki-pdf-template` pack path, or the name of a
 * curated template that is built into a pack here (deterministic bytes).
 */
async function readPdfTemplatePack(value: string): Promise<Uint8Array> {
  const curated = CURATED_PDF_TEMPLATE_RECIPES_V2[value];
  if (curated) {
    const { CliGeneratedPdfTemplateCompiler } = await import("./pdf-template-runtime.js");
    const built = await materializePdfTemplateRecipeV2({
      recipe: curated,
      resolvedAssets: {},
      compiler: new CliGeneratedPdfTemplateCompiler(),
    });
    return built.bytes;
  }
  if (!value.endsWith(".wiki-pdf-template")) {
    throw new Error(
      `PDF --template must point to a .wiki-pdf-template pack or name a built-in template (${Object.keys(CURATED_PDF_TEMPLATE_RECIPES_V2).join(", ")}).`
    );
  }
  return new Uint8Array(await readFile(resolve(value)));
}

/**
 * `--format pdf` command path (spec 008 T3.2/T3.3). Format-aware validation:
 * PDF accepts a verified `.wiki-pdf-template` pack through `--template` and
 * forbids `--engine` (PDF is its own isomorphic engine). Output goes to `--output` OR
 * `--out-dir` (never both). All output — success or failure — is the single
 * `atlcli.export-report/1` schema via `emitReportOutcome`.
 */
async function handlePdfExport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // `--report json` is already folded into `opts.json` by handleExport, which
  // normalizes it for every format.

  // Usage errors are reported through the SAME report shape, so `--json` always
  // emits exactly the versioned report — never a second ad hoc error shape.
  const usage = (message: string): ExportOutcome => ({
    ok: false,
    report: buildReport({
      format: "pdf",
      sourcePages: [],
      outputDetails: [],
      issues: [{ code: "usage-error", severity: "error", phase: "usage", retryable: false, message }],
      failureExitCode: 1,
    }),
  });

  if (hasFlag(flags, "engine")) {
    return emitReportOutcome(usage("--engine is not used with --format pdf (PDF has a single built-in engine)."), opts);
  }

  const outputPath = getFlag(flags, "output") ?? getFlag(flags, "o");
  const outDir = getFlag(flags, "out-dir");
  if (outputPath && outDir) {
    return emitReportOutcome(usage("Pass either --output or --out-dir, not both."), opts);
  }
  if (!outputPath && !outDir) {
    return emitReportOutcome(usage("--output (or --out-dir) is required for --format pdf."), opts);
  }

  // Parse scope/label flags with the engine forced to `ts`: PDF is an
  // isomorphic (ts-family) engine, so spec 002's scope/label validation applies
  // uniformly. The user never passes --engine for PDF (forbidden above).
  let request: ParsedExportRequest;
  try {
    request = parseExportRequest(args[0], { ...flags, engine: "ts" });
  } catch (error) {
    if (error instanceof ExportRequestError) return emitReportOutcome(usage(error.message), opts);
    throw error;
  }

  let codeTheme: CodeThemeId;
  try {
    codeTheme = resolveCodeThemeId(getFlag(flags, "code-theme"));
  } catch (error) {
    return emitReportOutcome(
      usage(error instanceof Error ? error.message : String(error)),
      opts,
    );
  }

  const { resolveExportedAt } = await import("./export-pdf.js");
  let exportedAt: Date | undefined;
  try {
    exportedAt = resolveExportedAt(getFlag(flags, "exported-at"));
  } catch (error) {
    return emitReportOutcome(usage(error instanceof Error ? error.message : String(error)), opts);
  }

  const pdfStandardFlag = getFlag(flags, "pdf-standard");
  let outputPolicy: PdfOutputPolicyV1 | undefined;
  if (pdfStandardFlag !== undefined) {
    if (!PDF_OUTPUT_STANDARDS_V1.includes(pdfStandardFlag as never)) {
      return emitReportOutcome(
        usage(
          `--pdf-standard must be one of ${PDF_OUTPUT_STANDARDS_V1.join(", ")} ` +
            `(got "${pdfStandardFlag}").`,
        ),
        opts,
      );
    }
    outputPolicy = {
      schema: "atlcli.pdf-output-policy/1",
      standards: [pdfStandardFlag as (typeof PDF_OUTPUT_STANDARDS_V1)[number]],
    };
  }

  // Explicit image profile (issue #118 Phase 3). Validated here so a typo
  // fails as a usage error before any network or job activity.
  const imageProfileFlag = getFlag(flags, "pdf-images");
  if (
    imageProfileFlag !== undefined &&
    imageProfileFlag !== "original" &&
    imageProfileFlag !== "standard" &&
    imageProfileFlag !== "print"
  ) {
    return emitReportOutcome(
      usage(`--pdf-images must be original, standard, or print (got "${imageProfileFlag}").`),
      opts,
    );
  }
  const imagePpiFlag = getFlag(flags, "pdf-images-ppi");
  let imagePpi: number | undefined;
  if (imagePpiFlag !== undefined) {
    imagePpi = Number(imagePpiFlag);
    if (!Number.isSafeInteger(imagePpi) || imagePpi < 72 || imagePpi > 1200) {
      return emitReportOutcome(
        usage(`--pdf-images-ppi must be an integer in [72, 1200] (got "${imagePpiFlag}").`),
        opts,
      );
    }
    if ((imageProfileFlag ?? "original") === "original") {
      return emitReportOutcome(
        usage("--pdf-images-ppi requires --pdf-images standard or print: original never re-encodes."),
        opts,
      );
    }
  }

  const persistence = createFileExportJobPersistence();
  let template: PdfTemplateReferenceV1 | undefined;
  const pdfTemplatePath = templateFlag(flags);
  if (pdfTemplatePath) {
    try {
      const packBytes = await readPdfTemplatePack(pdfTemplatePath);
      // Full validation happens before profile resolution or client creation,
      // so an invalid local pack can never trigger a Confluence request.
      await loadPdfTemplatePack(packBytes);
      const record = await persistence.templatePacks.put({
        bytes: packBytes,
        limits: {
          maxObjectBytes: 64 * 1024 * 1024,
          maxTotalBytes: 512 * 1024 * 1024,
        },
        now: Date.now(),
      });
      template = templatePackReference(
        await persistence.templatePacks.verify(templatePackReference(record))
      );
    } catch (error) {
      return emitReportOutcome(
        usage(
          `PDF template validation failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        opts
      );
    }
  }

  const { client, profile } = await getClient(flags, opts);
  const baseUrl = getConfluenceBaseUrl(profile);

  const id = randomUUID();
  const durableTarget = outputPath ? resolve(outputPath) : resolve(outDir!);
  const jobRequest = buildCliPdfJobRequest({
    id,
    idempotencyKey: `cli-export:${id}`,
    createdAt: Date.now(),
    request,
    profile,
    outputPath: durableTarget,
    outputTargetKind: outDir ? "directory" : "file",
    force: hasFlag(flags, "force"),
    strict: hasFlag(flags, "strict"),
    noCache: hasFlag(flags, "no-cache"),
    codeTheme,
    liveMacros: !hasFlag(flags, "no-live-macros"),
    ...(template ? { template } : {}),
    ...(exportedAt ? { exportedAt } : {}),
    ...(imageProfileFlag ? { imageProfile: imageProfileFlag } : {}),
    ...(imagePpi !== undefined ? { imagePpi } : {}),
    ...(outputPolicy !== undefined ? { outputPolicy } : {}),
    settings: {
      ...(hasFlag(flags, "no-cover") ? { cover: false } : {}),
      ...(hasFlag(flags, "no-toc") ? { outline: false } : {}),
      ...(hasFlag(flags, "no-closing-page") ? { closingPage: false } : {}),
    },
  });
  const { exportPdfAsOrdinaryJob } = await import("./export-pdf.js");
  const outcome = await exportPdfAsOrdinaryJob({
    client,
    profile,
    request,
    baseUrl,
    ...(outputPath ? { outputPath } : {}),
    ...(outDir ? { outDir } : {}),
    force: hasFlag(flags, "force"),
    strict: hasFlag(flags, "strict"),
    noCache: hasFlag(flags, "no-cache"),
    ...(exportedAt ? { exportedAt } : {}),
    ...(outputPolicy !== undefined ? { outputPolicy } : {}),
    opts,
  }, jobRequest, undefined, persistence);
  emitReportOutcome(outcome, opts);
}

/**
 * Profile-free token mode for CI (spec 008 T3.4). Builds an ephemeral in-memory
 * {@link Profile} from `--base-url`/`ATLCLI_BASE_URL` + `--auth-type` +
 * (`--email`/`ATLCLI_EMAIL` for api-token) + the highest-priority
 * `ATLCLI_API_TOKEN`, so an export runs with no `~/.atlcli/config.json`.
 *
 * FAIL-CLOSED: two disjoint modes only — named profile OR fully ephemeral, never
 * a mix. A partial ephemeral set (or `--profile` alongside ephemeral fields) is a
 * usage error raised BEFORE any config-file/keychain lookup, so a gap is never
 * silently filled from a local profile. Returns `null` when no ephemeral field
 * was supplied (fall back to the named-profile path).
 */
export function buildEphemeralProfile(
  flags: Record<string, string | boolean | string[]>
): Profile | null {
  const baseUrlRaw = getFlag(flags, "base-url") ?? process.env.ATLCLI_BASE_URL;
  const email = getFlag(flags, "email") ?? process.env.ATLCLI_EMAIL;
  const authTypeRaw = getFlag(flags, "auth-type") ?? process.env.ATLCLI_AUTH_TYPE;
  const requested = Boolean(baseUrlRaw || email || authTypeRaw);
  if (!requested) return null;

  if (hasFlag(flags, "profile")) {
    throw new ExportRequestError(
      "Ephemeral auth (--base-url/--email/--auth-type) cannot be combined with --profile. Use one or the other."
    );
  }
  if (!baseUrlRaw) {
    throw new ExportRequestError("Ephemeral auth requires --base-url (or ATLCLI_BASE_URL).");
  }
  const token = process.env.ATLCLI_API_TOKEN;
  if (!token) {
    throw new ExportRequestError("Ephemeral auth requires the ATLCLI_API_TOKEN environment variable.");
  }
  const authType = authTypeRaw ?? "api-token";
  if (authType !== "api-token" && authType !== "bearer") {
    throw new ExportRequestError(`Unknown --auth-type "${authType}". Use "api-token" or "bearer".`);
  }
  if (authType === "api-token" && !email) {
    throw new ExportRequestError("--auth-type api-token requires --email (or ATLCLI_EMAIL).");
  }
  if (authType === "bearer" && email) {
    throw new ExportRequestError("--auth-type bearer does not take --email.");
  }

  // HTTPS by default; plain HTTP only behind an explicit Data Center opt-in.
  const normalized = normalizeBaseUrl(baseUrlRaw);
  if (normalized.startsWith("http://") && !hasFlag(flags, "allow-http")) {
    throw new ExportRequestError(
      "Ephemeral --base-url must use HTTPS. Pass --allow-http for a Data Center deployment over plain HTTP."
    );
  }

  return {
    name: "ephemeral",
    baseUrl: normalized,
    ...(authType === "bearer" ? { deploymentType: "data-center" as const } : {}),
    auth:
      authType === "bearer"
        ? { type: "bearer", pat: token, username: email }
        : { type: "apiToken", email: email!, token },
  };
}

async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<{ client: ConfluenceClient; profile: any }> {
  let exportSourcePolicy;
  try {
    exportSourcePolicy = exportSourcePolicyFromFlag(process.env.ATLCLI_EXPORT_SOURCE);
  } catch (error) {
    fail(opts, 1, ERROR_CODES.USAGE, error instanceof Error ? error.message : String(error));
  }
  const clientOptions = { exportSourcePolicy };
  // Fully ephemeral (CI) mode short-circuits before any config/keychain access.
  let ephemeral: Profile | null;
  try {
    ephemeral = buildEphemeralProfile(flags);
  } catch (error) {
    if (error instanceof ExportRequestError) {
      fail(opts, 1, ERROR_CODES.USAGE, error.message);
    }
    throw error;
  }
  if (ephemeral) {
    assertCliAuthSupported(ephemeral, opts);
    return { client: new ConfluenceClient(ephemeral, clientOptions), profile: ephemeral };
  }

  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  assertCliAuthSupported(profile, opts);
  const client = new ConfluenceClient(profile, clientOptions);
  return { client, profile };
}

function parsedRequestFromJob(request: ExportJobRequestV1): ParsedExportRequest {
  const source = request.source;
  const pageRef =
    source.locator.kind === "page-id"
      ? source.locator.id
      : source.locator.kind === "content-key"
        ? source.locator.value
        : undefined;
  const spaceKey = source.locator.kind === "space-key" ? source.locator.spaceKey : undefined;
  if (source.scope.kind === "space" && !spaceKey) {
    throw new Error(`Export job ${request.id} has a space scope without a space-key locator.`);
  }
  if (source.scope.kind !== "space" && !pageRef) {
    throw new Error(`Export job ${request.id} has a page/tree scope without a page locator.`);
  }
  return {
    scopeKind: source.scope.kind,
    engine: "ts",
    ...(pageRef ? { pageRef } : {}),
    ...(spaceKey ? { spaceKey } : {}),
    includeRoot: source.scope.kind === "tree" ? source.scope.includeRoot !== false : true,
    ...((source.scope.kind === "tree" || source.scope.kind === "space") &&
      source.scope.maxDepth !== undefined
      ? { maxDepth: source.scope.maxDepth }
      : {}),
    ...(source.maxPages !== undefined ? { maxPages: source.maxPages } : {}),
    ...(source.maxFolders !== undefined ? { maxFolders: source.maxFolders } : {}),
    ...(source.labels ? { labels: source.labels } : {}),
    completenessMode: source.completenessMode ?? "strict",
    usedIncludeChildrenAlias: false,
  };
}

async function profileForStoredJob(
  request: ExportJobRequestV1,
  opts: OutputOptions,
): Promise<Profile> {
  const prefix = "cli-profile:";
  if (!request.authRef.startsWith(prefix)) {
    fail(
      opts,
      3,
      ERROR_CODES.AUTH,
      "This export used process-only credentials. Submit a new authenticated export instead of replaying it.",
    );
  }
  const profileName = request.authRef.slice(prefix.length);
  const profile = getActiveProfile(await loadConfig(), profileName);
  if (!profile || profile.name !== profileName) {
    fail(opts, 3, ERROR_CODES.AUTH, `Export profile is no longer available: ${profileName}`);
  }
  assertCliAuthSupported(profile, opts);
  const profileOrigin = new URL(
    /^https?:\/\//i.test(profile.baseUrl) ? profile.baseUrl : `https://${profile.baseUrl}`,
  ).origin;
  if (profileOrigin !== request.source.siteOrigin) {
    fail(
      opts,
      3,
      ERROR_CODES.AUTH,
      `Profile ${profileName} no longer points at the export job's Confluence site.`,
    );
  }
  return profile;
}

/** Foreground worker used by `jobs retry` and `jobs rerun`; no daemon is implied. */
async function executeStoredExportJob(
  request: ExportJobRequestV1,
  opts: OutputOptions,
  derivedFrom?: ExportJobDerivationV1,
): Promise<void> {
  const profile = await profileForStoredJob(request, opts);
  const replaySourcePolicy = exportSourcePolicyFromFlag(
    process.env.ATLCLI_EXPORT_SOURCE,
  );
  const client = new ConfluenceClient(profile, {
    exportSourcePolicy: replaySourcePolicy,
  });
  const parsed = parsedRequestFromJob(request);
  const baseUrl = getConfluenceBaseUrl(profile);
  if (request.output.policy !== "path" || !request.output.targetRef) {
    fail(opts, 1, ERROR_CODES.USAGE, "This CLI export job has no replayable path output.");
  }

  if (request.format === "pdf") {
    const { exportPdfAsOrdinaryJob } = await import("./export-pdf.js");
    const outcome = await exportPdfAsOrdinaryJob(
      {
        client,
        profile,
        request: parsed,
        baseUrl,
        ...(request.output.targetKind === "directory"
          ? { outDir: request.output.targetRef }
          : { outputPath: request.output.targetRef }),
        force: request.output.overwriteExisting === true,
        strict: request.options.strict === true,
        noCache: request.options.noCache === true,
        ...(request.options.exportedAt !== undefined
          ? { exportedAt: new Date(request.options.exportedAt) }
          : {}),
        opts,
      },
      request,
      derivedFrom,
    );
    emitReportOutcome(outcome, opts);
    return;
  }

  if (request.output.targetKind === "directory") {
    fail(opts, 1, ERROR_CODES.USAGE, "DOCX replay requires a file output target.");
  }
  const { loadExportTemplate } = await import("./export-internals.js");
  const template = await loadExportTemplate(
    request.template.recordKey === "bundled:default-docx" ? undefined : request.template.recordKey,
  );
  const actualTemplateSha256 = createHash("sha256").update(template.bytes).digest("hex");
  if (actualTemplateSha256 !== request.template.sha256.toLowerCase()) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      "The pinned DOCX template changed or is unavailable; the retained job cannot be replayed safely.",
    );
  }
  const outcome = await exportDocxAsOrdinaryJob(
    {
      client,
      profile,
      request: parsed,
      baseUrl,
      outputPath: request.output.targetRef,
      template,
      opts,
    },
    request,
    derivedFrom,
  );
  emitReportOutcome(outcome, opts);
}

async function resolveTemplatePath(templateRef: string, profileName?: string): Promise<string> {
  // If it's already an absolute path or relative path that exists
  if (existsSync(templateRef)) {
    return resolve(templateRef);
  }

  const stored = findStoredTemplate(templateRef, getTemplateDirectories(profileName));
  if (stored) return stored;

  // Return original path (will fail later with proper error message)
  return resolve(templateRef);
}

/**
 * Get template storage directories.
 */
function getTemplateDirectories(profileName?: string): { level: string; path: string }[] {
  const dirs: { level: string; path: string }[] = [
    { level: "project", path: join(process.cwd(), ".atlcli", "templates", "confluence") },
  ];

  if (profileName) {
    dirs.push({
      level: "profile",
      path: join(homedir(), ".atlcli", "profiles", profileName, "templates", "confluence"),
    });
  }

  dirs.push({
    level: "global",
    path: join(homedir(), ".atlcli", "templates", "confluence"),
  });

  return dirs;
}

/**
 * The stored template `name` refers to: project, then profile, then global.
 * A name without a Word extension matches `<name>.docx` or `<name>.docm`.
 * Only looks inside `dirs`, never at the working directory.
 */
function findStoredTemplate(name: string, dirs: { path: string }[]): string | undefined {
  const extensions = name.endsWith(".docx") || name.endsWith(".docm") ? [""] : [".docx", ".docm"];
  for (const { path: dir } of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const TEMPLATE_LEVELS = ["global", "profile", "project"] as const;

/**
 * List available export templates.
 */
export async function listTemplates(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);

  const dirs = getTemplateDirectories(profile?.name);
  const templates: { name: string; level: string; path: string }[] = [];
  const seen = new Set<string>();

  for (const { level, path: dir } of dirs) {
    if (!existsSync(dir)) continue;

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);

    for (const file of files) {
      if (!file.endsWith(".docx") && !file.endsWith(".docm")) continue;

      const name = file.replace(/\.(docx|docm)$/, "");
      if (seen.has(name)) continue; // Skip shadowed templates

      seen.add(name);
      templates.push({
        name,
        level,
        path: join(dir, file),
      });
    }
  }

  output({ templates }, opts);
}

/**
 * Save a template to storage.
 */
export async function saveTemplate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  const filePath = getFlag(flags, "file");
  const level = (getFlag(flags, "level") ?? "global") as (typeof TEMPLATE_LEVELS)[number];
  if (!TEMPLATE_LEVELS.includes(level)) {
    fail(opts, 1, ERROR_CODES.USAGE, `Unknown --level "${level}". Expected one of: ${TEMPLATE_LEVELS.join(", ")}.`);
  }

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  // The name becomes a file name in the store; a path would write outside it.
  if (basename(name) !== name || name === "." || name === "..") {
    fail(opts, 1, ERROR_CODES.USAGE, `Invalid template name "${name}": use a plain name without a path.`);
  }

  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--file is required.");
  }

  if (!existsSync(filePath)) {
    fail(opts, 1, ERROR_CODES.USAGE, `File not found: ${filePath}`);
  }

  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);

  // Determine target directory
  let targetDir: string;
  if (level === "project") {
    targetDir = join(process.cwd(), ".atlcli", "templates", "confluence");
  } else if (level === "profile") {
    if (!profile) {
      fail(opts, 1, ERROR_CODES.AUTH, "No active profile. Use --profile or login first.");
    }
    targetDir = join(homedir(), ".atlcli", "profiles", profile.name, "templates", "confluence");
  } else {
    targetDir = join(homedir(), ".atlcli", "templates", "confluence");
  }

  // Create directory if needed
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(targetDir, { recursive: true });

  // Determine extension from source file
  const ext = filePath.endsWith(".docm") ? ".docm" : ".docx";
  const targetPath = join(targetDir, `${name}${ext}`);

  await copyFile(filePath, targetPath);

  output({
    success: true,
    template: name,
    level,
    path: targetPath,
  }, opts);
}

/**
 * Delete a template from storage.
 */
export async function deleteTemplate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  const confirm = hasFlag(flags, "confirm");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a template.");
  }

  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);

  // Only a stored template can be deleted: resolving the name like --template
  // does would unlink a file of that name in the working directory instead.
  // A name with a path in it could leave the store, so it is never one.
  const templatePath = basename(name) === name ? findStoredTemplate(name, getTemplateDirectories(profile?.name)) : undefined;
  if (!templatePath) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template not found: ${name}`);
  }

  const { unlink } = await import("node:fs/promises");
  await unlink(templatePath);

  output({
    success: true,
    deleted: name,
    path: templatePath,
  }, opts);
}

/**
 * Build the spec-004 macro-resolution options for a ts-engine export. Lazily
 * imports the wiring module + Jira client so the macro path adds no startup
 * cost to exports that don't need it. A `JiraClient` is always constructed from
 * the same profile (Cloud shares the site); if Jira isn't accessible the chain
 * degrades gracefully (403/404 → note, never a hard failure).
 */
async function buildTsEngineMacroOptions(
  profile: Profile,
  client: ConfluenceClient,
  targetEngine: "docx" | "pdf",
  live: boolean,
  /**
   * `composeChapters(...).chapterAnchorById` for a tree/space export — see
   * `BuildMacroOptionsArgs.chapterAnchorById`. Absent on the single-page path,
   * where nothing but the page itself is in scope.
   */
  chapterAnchorById?: ReadonlyMap<string, string>,
  signal?: AbortSignal,
) {
  const [wiring, { JiraClient }] = await Promise.all([
    import("./export-macros-wiring.js"),
    import("@atlcli/jira"),
  ]);
  const macros = wiring.buildMacroResolutionOptions({
    profile,
    confluence: client,
    jira: new JiraClient(profile),
    targetEngine,
    live,
    ...(chapterAnchorById ? { chapterAnchorById } : {}),
    ...(signal ? { signal } : {}),
  });
  // SSRF enforcement (spec 004): export_view-derived external image refs carry
  // trust:"export-view"; route them through the policy-checked external fetcher
  // instead of the unrestricted token fetcher. Page-trust refs are unchanged.
  const externalAssets = wiring.defaultExternalAssetFetcher(
    wiring.defaultExternalAssetPolicy(profile.baseUrl)
  );
  const wrapAssets = (inner: import("@atlcli/docx").AssetFetcher) =>
    wiring.trustRoutingAssetFetcher(inner, externalAssets);
  return { macros, wrapAssets };
}

interface OrdinaryDocxJobArgs {
  client: ConfluenceClient;
  profile: Profile;
  request: ParsedExportRequest;
  baseUrl: string;
  outputPath: string;
  template: LoadedExportTemplate;
  opts: OutputOptions;
}

let cliDocxCodeFontLoaderInstallation:
  | Promise<void>
  | undefined;

/**
 * Install the single-file CLI's embedded asset bridge once. Ordinary Node/Bun
 * consumers keep the package-relative loader installed by @atlcli/docx.
 */
function ensureCliDocxCodeFontLoader(): Promise<void> {
  return cliDocxCodeFontLoaderInstallation ??= Promise.all([
    import("@atlcli/docx/internal"),
    import("./export-code-font.js"),
  ]).then(([{ configureBundledCodeFontLoader }, { loadDocxCodeFont }]) => {
    configureBundledCodeFontLoader(loadDocxCodeFont);
  });
}

/** Queue-backed DOCX command; no direct-engine fallback is reachable here. */
async function exportDocxAsOrdinaryJob(
  args: OrdinaryDocxJobArgs,
  jobRequest: DocxExportJobRequestV1,
  derivedFrom?: ExportJobDerivationV1,
): Promise<ExportOutcome> {
  const startedAt = Date.now();
  const persistence = createFileExportJobPersistence();
  type CliProjection = Pick<
    import("./export-pdf.js").ResolvedScope,
    "sourcePages" | "reconcilablePageId" | "scopeReport"
  > & { outputPath: string };
  let reportProjection: CliProjection | undefined;
  const cliNotes: string[] = [];

  try {
    await ensureCliDocxCodeFontLoader();
    // Executor construction is local-only; runOrdinaryExportJobV1 performs the
    // durable create before this resolver can reach Confluence.
    const sourcePolicyKey = args.profile.deploymentType === "data-center"
      ? "storage-primary:data-center:v1"
      : `${exportSourcePolicyFromFlag(process.env.ATLCLI_EXPORT_SOURCE)}:v1`;
    const resolveInput = createConfluenceDocxResolveInputV1({
      port: confluenceSourceResolverPortFromClientV1(args.client),
      classifyError: classifyConfluenceSourceError,
      ...(args.request.scopeKind === "page"
        ? {}
        : {
            resolveExternalUrl: (
              target: Parameters<NonNullable<ComposeOptions["resolveExternalUrl"]>>[0],
              anchor: Parameters<NonNullable<ComposeOptions["resolveExternalUrl"]>>[1],
            ) => {
              const path = target.contentId
                ? target.spaceKey
                  ? `spaces/${target.spaceKey}/pages/${target.contentId}`
                  : `pages/viewpage.action?pageId=${target.contentId}`
                : target.spaceKey
                  ? `display/${target.spaceKey}/${encodeURIComponent(target.contentTitle)}`
                  : `search?text=${encodeURIComponent(target.contentTitle)}`;
              const url = buildConfluenceUrl(args.profile, path);
              return anchor ? `${url}#${anchor}` : url;
            },
          }),
      ...(args.request.scopeKind === "page" &&
      !jobRequest.options.keepIgnored
        ? {}
        : {
            bodyOptions: jobRequest.options.keepIgnored
              ? { exportControls: "passthrough" as const }
              : {},
          }),
      createSourcePlan: (_request, context) => ({
        store: createConfluenceSourcePlanSpoolV1(context),
        sourcePolicyKey,
      }),
      createBodyStore: (request, context) =>
        createExportTreeBodySpoolV1(context, request.idempotencyKey),
      onDiagnostic: (_request, context, diagnostic) => {
        return context.updateProgress({
          stage: "discover",
          done: 0,
          total: null,
          detail: formatConfluenceHierarchyDiagnosticV1(diagnostic),
          updatedAt: Date.now(),
        });
      },
      onProgress: (_request, context, progress) => {
        return context.updateProgress({
          stage: "fetch",
          done: progress.fetched,
          total: progress.total,
          updatedAt: Date.now(),
        });
      },
      async build(resolved, request, context) {
        const mentions = await resolveExportMentions(
          resolved.blocks,
          tokenMentionLookup(args.client, context.signal),
        );
        resolved.blocks = mentions.blocks;
        if (mentions.unresolved > 0) {
          resolved.sourceNotes.push({
            level: "warning",
            code: "mention-unresolved",
            message:
              `${mentions.unresolved} mention(s) could not be resolved to a display name.`,
          });
        }

        const sourcePages = resolved.pages.map((page) => ({
          id: page.id,
          title: page.title,
          notes: page.notes.map((note) =>
            noteToIssue(note, "compose", page.id),
          ),
        }));
        const scopeReport = args.request.scopeKind === "page"
          ? undefined
          : buildScopeReportFields(
              args.request,
              buildExportScope(args.request, resolved.root.id),
            );
        reportProjection = {
          sourcePages,
          outputPath: resolve(args.outputPath),
          ...(args.request.scopeKind === "page"
            ? { reconcilablePageId: resolved.root.id }
            : {}),
          ...(scopeReport ? { scopeReport } : {}),
        };
        await writeOrdinaryExportProjectionV1(persistence, {
          schema: "atlcli.cli-export-projection/1",
          jobId: jobRequest.id,
          format: "docx",
          value: reportProjection,
        });

        const { buildGetIncludedPage } = await import("@atlcli/docx/internal");
        const macroSetup = await buildTsEngineMacroOptions(
          args.profile,
          args.client,
          "docx",
          request.options.resolveMacros,
          resolved.chapterAnchorById,
          context.signal,
        );
        const cache = createAssetByteCache(args.baseUrl);
        let rasterizerPromise:
          | Promise<import("@atlcli/docx").SvgRasterizer | null>
          | undefined;
        const rasterizer: import("@atlcli/docx").SvgRasterizer = {
          async rasterize(svg, target, hostContext) {
            rasterizerPromise ??= import("./export-rasterizer.js").then(
              ({ buildDiagramRasterizer }) =>
                buildDiagramRasterizer((message) =>
                  cliNotes.push(
                    `diagram rasterizer unavailable; diagrams degrade (${message}).`,
                  ),
                ),
            );
            const ready = await rasterizerPromise;
            hostContext?.signal?.throwIfAborted();
            if (!ready) throw new Error("DOCX diagram rasterizer is unavailable.");
            return ready.rasterize(svg, target, hostContext);
          },
        };

        return {
          input: {
            template: args.template.meta,
            embedImages: request.options.embedImages,
            ...(request.options.keepIgnored
              ? { exportControls: "passthrough" as const }
              : {}),
            updateFields: request.options.updateFields ?? "auto",
            assets: checkpointDocxAssetsV1(
              context,
              request.idempotencyKey,
              macroSetup.wrapAssets(tokenAssetFetcher(args.client, cache)),
            ),
            rasterizer,
            macros: macroSetup.macros,
            deps: {
              getSpace: async (key: string) =>
                (
                  await args.client.getSpaceWithIcon(key, {
                    signal: context.signal,
                  })
                ).space,
              getCurrentUser: () =>
                args.client.getCurrentUser({ signal: context.signal }),
              getPageOwner: (id: string) =>
                args.client.getPageOwner(id, { signal: context.signal }),
              getSpaceHomepageStorage: (key: string) =>
                args.client.getSpaceHomepageStorage(key, {
                  signal: context.signal,
                }),
              getSpaceLogo: async (key: string) => {
                const icon = (
                  await args.client.getSpaceWithIcon(key, {
                    signal: context.signal,
                  })
                ).icon;
                if (!icon) return null;
                const match = icon.path.match(
                  /^\/download\/attachments\/(\d+)\/([^/?]+)/,
                );
                return {
                  url: icon.path,
                  ...(match
                    ? {
                        pageId: match[1],
                        filename: decodeURIComponent(match[2]),
                      }
                    : {}),
                };
              },
              getIncludedPage: buildGetIncludedPage({
                getPage: (id) =>
                  args.client.getPage(id, { signal: context.signal }),
                findPagesByTitle: (title, spaceKey) =>
                  args.client.findPagesByTitle(title, {
                    spaceKey,
                    signal: context.signal,
                  }),
                defaultSpaceKey: resolved.root.spaceKey,
              }),
            },
          },
        };
      },
    });
    const executor = createOrdinaryDocxExecutorV1(persistence, {
      templates: {
        async resolve(input) {
          if (input.recordKey !== jobRequest.template.recordKey) {
            throw new Error("Pinned DOCX template record is unavailable in this CLI invocation.");
          }
          return { recordKey: input.recordKey, bytes: args.template.bytes };
        },
      },
      resolveInput,
      estimateRender(input): ResourceEstimateV1 {
        const sourceBytes = new TextEncoder().encode(JSON.stringify(input.blocks ?? [])).byteLength;
        return {
          heapBytes: Math.max(256 * 1024 * 1024, sourceBytes * 8),
          spoolBytes: Math.max(512 * 1024 * 1024, sourceBytes * 16),
          outputBytes: 512 * 1024 * 1024,
          rasterPixels: 128 * 1024 * 1024,
          confidence: "unknown",
        };
      },
    });

    const execution = await runOrdinaryExportJobV1({
      request: jobRequest,
      ...(derivedFrom ? { derivedFrom } : {}),
      executor,
      persistence,
      monitor: {
        mode: args.opts.json ? "jsonl" : process.stderr.isTTY ? "tty" : "lines",
        writer: process.stderr,
      },
    });
    if (execution.snapshot.state !== "succeeded" || !execution.report) {
      const classified = classifyFailedExportJob(execution.snapshot);
      return {
        ok: false,
        report: buildReport({
          format: "docx",
          engine: "ts",
          sourcePages: [],
          outputDetails: [],
          issues: [classified.issue],
          timings: { totalMs: Date.now() - startedAt },
          failureExitCode: classified.exitCode,
        }),
      };
    }
    reportProjection ??= await readOrdinaryExportProjectionV1<CliProjection>(
      persistence,
      execution.snapshot.id,
      "docx",
    );
    if (!reportProjection) throw new Error("DOCX job recovery has no durable CLI report projection.");
    const report = execution.report as DocxEngineReport;
    const sourcePages = reportProjection.reconcilablePageId && report.sourceNotes
      ? [{
          ...reportProjection.sourcePages[0]!,
          notes: report.sourceNotes.map((note) =>
            noteToIssue(note, "compose", reportProjection!.reconcilablePageId!),
          ),
        }]
      : reportProjection.sourcePages;
    const common = {
      format: "docx" as const,
      engine: "ts" as const,
      codeTheme: report.codeTheme,
      sourcePages,
      outputDetails: [{
        output: reportProjection.outputPath,
        embeddedImages: report.embeddedImages,
        renderedDiagrams: report.renderedDiagrams,
        skippedAssets: report.skippedImages,
      }],
      issues: [
        ...args.template.notes.map((note) => noteToIssue(note, "prepare")),
        ...report.notes.map((note) => noteToIssue(note, "prepare")),
        ...cliNotes.map((message) => ({
          code: "cli-note",
          severity: "warning" as const,
          phase: "prepare" as const,
          retryable: false,
          message,
        })),
      ],
      timings: { totalMs: Date.now() - startedAt },
      complete: report.complete,
      placeholders: { resolved: report.resolvedCount, unsupported: report.unsupportedNames },
      strict: jobRequest.options.strict === true,
    };
    return {
      ok: true,
      report: reportProjection.scopeReport
        ? buildTreeExportReport({ ...common, scope: reportProjection.scopeReport })
        : buildReport(common),
    };
  } catch (error) {
    const classified = classifyError(error);
    return {
      ok: false,
      report: buildReport({
        format: "docx",
        engine: "ts",
        sourcePages: [],
        outputDetails: [],
        issues: [classified.issue],
        timings: { totalMs: Date.now() - startedAt },
        failureExitCode: classified.exitCode,
      }),
    };
  }
}

function exportHelp(): string {
  return `atlcli wiki export <page> [--template <name>] --output <path>

Export Confluence content to DOCX or PDF. DOCX uses the bundled default template
when --template is omitted.

Arguments:
  <page>              Page reference (ID, SPACE:Title, or URL)

Options:
  --format <fmt>      Output format: "docx" (default) or "pdf"
  --template, -t      DOCX: optional template name/path. PDF: verified
                      .wiki-pdf-template pack path, or "report" for the
                      built-in Report template (no cover or closing page).
                      Without it, each format uses its bundled default;
                      DOCX reports that fallback. DOCX template names follow
                      the resolution order below.
                      The DOCX engine fills $scroll.* placeholders only — a
                      docxtpl/Jinja template ({{ … }}, {% … %}) exports with
                      those left as literal text and a warning note.
  --output, -o        Output file path (required, or use --out-dir for PDF)
  --code-theme <id>   Bundled Shiki theme for code blocks in DOCX and PDF.
                      Defaults to "github-light"; use the generated theme
                      catalogue for the complete list.
  --no-images         Do not embed images from page attachments (default embeds)
  --no-field-update-prompt
                      Never ask Word to refresh fields on open. A table of
                      contents, caption numbers and cross-references then show
                      placeholder or stale text until refreshed by hand
                      (select all, F9); the report says so. Without this flag
                      the prompt appears only when the document actually has a
                      field whose refresh changes something — a document whose
                      only fields are hyperlinks never prompts.
  --no-toc-prompt     Alias for --no-field-update-prompt (original spelling)
  --keep-ignored      Keep scroll-only/scroll-ignore content for debugging
                      (single page; export is marked in the report)
  --no-live-macros    Deterministic export: skip live (Jira/export_view/attachment)
                      macro rendering. Pure macros (TOC, includes) still render.
                      This is NOT network-free — the page body and its own
                      attachments still fetch.
  --engine <name>     Rendering engine: "ts" — the default, and the only value.
                      Accepted so existing scripts keep working; the isomorphic
                      @atlcli/docx engine (same code as the browser extension)
                      renders every export either way: $scroll.* placeholders,
                      image embedding, mermaid diagrams. The removed "python"
                      value fails with a migration error.
  --profile <name>    Use a specific auth profile
  --report json       Synonym for --json (emit the report to stdout); applies to
                      PDF and DOCX exports alike

PDF Options (--format pdf):
  --out-dir <dir>           Write to a directory with a derived <pageId>-<slug>.pdf
                            name (alternative to --output; not both)
  --force                   Overwrite an existing regular output file
  --no-cover                Leave out the cover page
  --no-toc                  Leave out the table of contents
  --no-closing-page         Leave out the closing "End of document" page
  --strict                  Exit code 2 if the export completed with warnings
  --no-cache                Do not persist downloaded assets across invocations
  --exported-at <ISO8601>   Fix the export timestamp (reproducible builds; also
                            honors the SOURCE_DATE_EPOCH env var)
  --pdf-standard <name>     Strict PDF/A or PDF/UA output: a-1b, a-1a, a-2b,
                            a-2u, a-2a, a-3b, a-3u, a-3a, a-4, a-4f, a-4e,
                            or ua-1. No downgrade fallback.
  --template, -t <pack>     Use a verified .wiki-pdf-template pack
  (--engine is not valid with --format pdf.)

Profile-free auth (CI, any format):
  --base-url <url>          Confluence base URL (or ATLCLI_BASE_URL); requires
                            HTTPS unless --allow-http
  --email <addr>            Account email (or ATLCLI_EMAIL); required for
                            api-token auth, forbidden for bearer
  --auth-type <kind>        api-token (default) | bearer (or ATLCLI_AUTH_TYPE)
  --allow-http              Permit a plain-HTTP --base-url (Data Center opt-in)
  (The token comes from ATLCLI_API_TOKEN. Ephemeral mode is fail-closed: use a
   named --profile OR a full ephemeral set, never a mix.)

Scope Options:
  --scope <kind>            page (default) | tree | space
  --include-children        Deprecated alias for --scope tree
  --space <KEY>             Export a whole space (implies --scope space); the
                            homepage is the root chapter. Takes no page reference.
  --max-depth <n>           Cap traversal depth (tree/space; root = depth 0,
                            so 0 exports the root page only)
  --max-pages <n>           Hard page cap (tree/space; default 500)
  --max-folders <n>         Hard folder cap (tree/space; default 200)
  --label-include <a,b>     Keep only pages carrying any of these labels (OR)
  --label-exclude <c,d>     Drop pages carrying any of these labels (OR)
  --label-exclude-mode      prune-subtree (default) | page-only
  --completeness <mode>     strict (default, abort on unreadable/changed pages)
                            | partial (placeholder chapter + complete:false)

Page Reference Formats:
  12345678            Page ID
  SPACE:Page Title    Space key and page title
  https://...         Full Confluence URL

Exit Codes (PDF and DOCX):
  0    Success
  1    Usage / config / local IO error
  2    Completed with warnings (only under --strict)
  3    Authentication error (401/403)
  4    Remote/API error (page not found, fetch failed)
  5    Compile / validation failure (incl. tree limits, label filters, budget)
  130  Cancelled (Ctrl-C / SIGINT)

JSON Output (--json / --report json):
  PDF and DOCX exports emit EXACTLY one "atlcli.export-report/1" document
  on stdout (sourcePages, outputDetails, issues, scope traceability, exitCode).
  Progress events go to stderr.

DOCX Template Resolution:
  DOCX template names are resolved in order (first match wins):
  1. Direct file path (if exists)
  2. Project: .atlcli/templates/confluence/<name>.docx
  3. Profile: ~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx
  4. Global: ~/.atlcli/templates/confluence/<name>.docx
  With no --template: the bundled default template
  (reported as the info note "template-default-used").
  PDF --template requires a direct .wiki-pdf-template path; omission keeps
  Editorial Indigo.

Template Management:
  atlcli wiki export template list                    List available templates
  atlcli wiki export template save <name> --file <path> [--level global|profile|project]
  atlcli wiki export template delete <name> --confirm

Background Activity:
  atlcli wiki export jobs list [--status <state>] [--format <fmt>] [--since <date>] [--json]
  atlcli wiki export jobs show <id> [--json]
  atlcli wiki export jobs watch <id> [--jsonl]
  atlcli wiki export jobs cancel <id>
  atlcli wiki export jobs resume <queued-id>
  atlcli wiki export jobs retry <id> [--output <path>] [--force]
  atlcli wiki export jobs rerun <id> [--output <path>] [--force]
  atlcli wiki export jobs clear --before <duration> --confirm
  Normal exports, Retry and Run again stay in the foreground while the durable
  journal lets another process inspect, watch, or cancel them. --detach is not
  supported.

Examples:
  # Zero-config: one page to DOCX with the bundled default template
  atlcli wiki export 12345 --output page.docx

  # Minimal: one page tree to a single DOCX
  atlcli wiki export 12345 --template corporate --output handbook.docx --scope tree

  # Advanced: whole space, drop internal pages, machine-readable report for CI
  atlcli wiki export --template corporate --output space.docx --scope space \\
    --space DOCSY --label-exclude internal --completeness partial --json

  # PDF: single page to a tagged, font-embedded PDF with a JSON report for CI
  atlcli wiki export 12345 --format pdf --output ./report.pdf --json

  # PDF: apply a reviewed Word-derived design pack
  atlcli wiki export 12345 --format pdf --template ./brand.wiki-pdf-template \\
    --output ./brand-report.pdf --json

  atlcli wiki export 12345678 --template corporate --output ./report.docx
  atlcli wiki export "DOCS:Architecture" -t ./my-template.docx -o ./arch.docx
  atlcli wiki export 12345 -t basic -o out.docx --no-images
  atlcli wiki export 12345 -t scroll-corporate.docx -o out.docx
  atlcli wiki export template save corporate --file ./template.docx --level global
  atlcli wiki export template list
`;
}
