import { spawn } from "node:child_process";
import { assertCliAuthSupported } from "./session-guard.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
  AttachmentInfo,
  ConfluenceClient,
  ConfluencePageDetails,
  SpaceHomepageError,
  composeChapters,
  confluenceTreeSource,
  fetchExportTree,
  resolveExportMentions,
  storageToBlocks,
  storageToMarkdown,
  type ComposeOptions,
  type ExportBlock,
  type ExportNote,
  type ExportProgressCallback,
  type ExportScope,
  ConversionOptions,
} from "@atlcli/confluence";
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
  classifyError,
  emitReportOutcome,
  noteToIssue,
  type ExportOutcome,
} from "./export-report.js";

/**
 * Usage error for a python-engine export with no `--template`. Only the python
 * engine can hit it: `--engine ts` falls back to the bundled default template
 * (spec 010 W3-D), and docxtpl has no equivalent to fall back to.
 */
const TEMPLATE_REQUIRED_MESSAGE =
  "--template is required for --engine python (only --engine ts has a bundled default template).";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function handleExport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  rawOpts: OutputOptions
): Promise<void> {
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
        output(exportHelp(), opts);
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
  const engine = request.engine;

  // T3.5 deprecation notice (see engineDeprecationNotice for the conditions).
  // The flip itself is a later, gated PR (see T3.5 flip criteria).
  const notice = engineDeprecationNotice({
    engine,
    engineFlagPresent: hasFlag(flags, "engine"),
    json: opts.json,
    stderrIsTTY: Boolean(process.stderr.isTTY),
    suppressed: Boolean(process.env.ATLCLI_SUPPRESS_ENGINE_NOTICE),
  });
  if (notice) process.stderr.write(`${notice}\n`);

  const templatePath = getFlag(flags, "template");
  const outputPath = getFlag(flags, "output") ?? getFlag(flags, "o");
  let embedImages = !hasFlag(flags, "no-images");
  if (hasFlag(flags, "embed-images")) {
    embedImages = true;
  }
  if (hasFlag(flags, "no-images")) {
    embedImages = false;
  }
  const mergeChildren = !hasFlag(flags, "no-merge"); // merge is default
  const noTocPrompt = hasFlag(flags, "no-toc-prompt");
  // Spec 003 C4 progressive disclosure: keep scroll-only/scroll-ignore bodies
  // for debugging ("why is section X missing?"). Engine option:
  // exportControls "passthrough". ts single-page only for now — the tree/space
  // composition walks pages in @atlcli/confluence's tree fetch, which does not
  // thread export controls yet.
  const keepIgnored = hasFlag(flags, "keep-ignored");
  if (keepIgnored && engine !== "ts") {
    fail(opts, 1, ERROR_CODES.USAGE, "--keep-ignored requires --engine ts.");
  }
  if (keepIgnored && request.scopeKind !== "page") {
    fail(opts, 1, ERROR_CODES.USAGE, "--keep-ignored is not supported with --scope tree/space yet.");
  }

  // spec 004: `--no-live-macros` suppresses live (port-backed) macro renderers
  // for deterministic/compliance exports. The macro chain only exists on the
  // ts engine, so fail fast rather than silently no-op on the python path.
  const noLiveMacros = hasFlag(flags, "no-live-macros");
  if (noLiveMacros && engine !== "ts") {
    fail(opts, 1, ERROR_CODES.USAGE, "--no-live-macros requires --engine ts.");
  }

  // `--template` is OPTIONAL on `--engine ts`: `@atlcli/export-node` ships a
  // deterministic default template with correct `$scroll.title` /
  // `$scroll.exportdate` / `$scroll.content` placeholders, so the zero-config
  // path produces a document with nothing unfilled. Requiring the flag is what
  // pushed first-time ts users toward grabbing whatever `.docx` was at hand —
  // including docxtpl templates this engine cannot fill (see the
  // `template-foreign-placeholders` note). `--engine python` keeps requiring it:
  // docxtpl has no bundled default to fall back to.
  if (!templatePath && engine !== "ts") {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      TEMPLATE_REQUIRED_MESSAGE
    );
  }

  if (!outputPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--output is required.");
  }

  // Get Confluence client (needed for profile name in template resolution)
  const { client, profile } = await getClient(flags, opts);

  // Resolve template path (with profile for hierarchical lookup). Undefined
  // means "use the bundled default" — only reachable on the ts engine.
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

  // Tree/space export (ts engine only): fetch the ordered tree, compose one
  // chapterized document, and serialize it through the same runExport path a
  // single page uses. The python engine keeps its legacy --include-children
  // merge; scope/label flags with --engine python are rejected in parse.
  if (engine === "ts" && (request.scopeKind === "tree" || request.scopeKind === "space")) {
    await exportTreeWithTsEngine({
      client,
      profile,
      request,
      baseUrl,
      resolvedTemplatePath,
      outputPath,
      embedImages,
      liveMacros: !noLiveMacros,
      strict: hasFlag(flags, "strict"),
      opts,
    });
    return;
  }

  // From here down the scope is a single page (ts single-page path, or the
  // python engine incl. its legacy --include-children merge).
  const includeChildren = request.usedIncludeChildrenAlias;
  const pageId = await resolvePageId(client, request.pageRef!, opts);

  if (engine === "ts") {
    // The page fetch is NOT awaited here: exportWithTsEngine overlaps it
    // with template read/scan + rasterizer setup + pre-started resolver
    // round-trips (perf). The consumed catch branch keeps a FAST rejection
    // (bad page id) from surfacing as an unhandled rejection while local
    // setup is still running — the engine awaits the original promise and
    // reports the real error.
    const pagePromise = client.getPageDetails(pageId);
    pagePromise.catch(() => {});
    // Kernel boundary (spec 008 review): any error in the ts single-page path
    // becomes a classified atlcli.export-report/1 failure with the documented
    // exit code (3 auth / 4 remote / 5 validation / 130 abort) — never a plain
    // exit-1 crash through main()'s catch.
    try {
      await exportWithTsEngine({
        client,
        profile,
        pagePromise,
        pageId,
        baseUrl,
        resolvedTemplatePath,
        outputPath,
        embedImages,
        keepIgnored,
        liveMacros: !noLiveMacros,
        strict: hasFlag(flags, "strict"),
        opts,
      });
    } catch (error) {
      const classified = classifyError(error);
      emitReportOutcome(
        {
          ok: false,
          report: buildReport({
            format: "docx",
            engine: "ts",
            sourcePages: [],
            outputDetails: [],
            issues: [classified.issue],
            failureExitCode: classified.exitCode,
          }),
        },
        opts
      );
    }
    return;
  }

  // Every ts path has returned; only the python engine reaches here, and it has
  // no bundled default. The usage check above already rejected a missing
  // `--template` for this engine — this restates the invariant for the type
  // system (and would fail honestly rather than crash if that check ever moved).
  if (!templatePath || !resolvedTemplatePath) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      TEMPLATE_REQUIRED_MESSAGE
    );
  }

  // Fetch page data (with metadata for export)
  const page = await client.getPageDetails(pageId);
  const spaceKey = page.spaceKey ?? "UNKNOWN";

  // Convert storage to markdown
  const conversionOpts: ConversionOptions = {
    baseUrl: profile.baseUrl,
    emitWarnings: false,
  };
  const markdown = storageToMarkdown(page.storage, conversionOpts);

  // Detect dynamic macros that need data expansion
  const needsChildrenMacro = /:::children\b/.test(markdown);
  const contentByLabelQueries = extractContentByLabelQueries(markdown);

  // spec 004: the dynamic-macro chain (Jira tables, draw.io previews, includes,
  // export_view fallback) only exists on the ts engine. When this page carries
  // macros that chain would resolve live — same signal the walker emits for its
  // report — say so instead of silently exporting placeholders.
  try {
    const { notes: walkerNotes } = storageToBlocks(page.storage ?? "");
    if (walkerNotes.some((n) => n.code === "unknown-macro" || n.code === "macro-not-rendered")) {
      console.error(
        "hint: this page has dynamic macros; re-run with `--engine ts` for live rendering."
      );
    }
  } catch {
    // The hint is best-effort; a walker hiccup must never fail the export.
  }

  // Get space info (if we have the space key)
  let spaceName = spaceKey;
  let spaceUrl = `${baseUrl}/spaces/${spaceKey}`;
  try {
    const space = await client.getSpace(spaceKey);
    spaceName = space.name;
    spaceUrl = space.url ?? spaceUrl;
  } catch {
    // Ignore - use spaceKey as name
  }

  // Fetch attachments (used for loops and optionally image embedding)
  const attachments = await client.listAttachments(pageId);
  const attachmentData = mapAttachments(attachments, baseUrl);

  // Fetch and embed images if requested
  const images: Record<string, { data: string; mimeType: string }> = {};
  if (embedImages) {
    const imageAttachments = attachments.filter(a =>
      a.mediaType.startsWith("image/")
    );

    for (const attachment of imageAttachments) {
      try {
        const data = await client.downloadAttachment(attachment);
        const base64 = Buffer.from(data).toString("base64");
        images[attachment.filename] = {
          data: base64,
          mimeType: attachment.mediaType,
        };
      } catch {
        // Skip failed downloads
      }
    }
  }

  // Fetch children if requested (for merging) or needed for children macro
  let finalMarkdown = markdown;
  const childrenData: Array<{
    title: string;
    markdown: string;
    pageId: string;
    pageUrl: string;
    tinyUrl?: string;
    author?: string;
    authorEmail?: string;
    modifier?: string;
    modifierEmail?: string;
    created?: string;
    modified?: string;
    labels?: string[];
    attachments?: Array<{
      id: string;
      filename: string;
      mediaType: string;
      fileSize: number;
      size: number;
      version: number;
      pageId: string;
      downloadUrl: string;
      downloadUrlFull: string;
      url: string;
      comment: string;
    }>;
  }> = [];
  let childrenMacro: Array<{ title: string; pageUrl: string; pageId: string }> = [];

  if (includeChildren || needsChildrenMacro) {
    const children = await client.getChildren(pageId);
    childrenMacro = children.map(child => ({
      title: child.title,
      pageId: child.id,
      pageUrl: child.url ?? `${baseUrl}/spaces/${spaceKey}/pages/${child.id}`,
    }));

    if (includeChildren) {
      for (const child of children) {
        const childPage = await client.getPageDetails(child.id);
        const childMarkdown = storageToMarkdown(childPage.storage, conversionOpts);
        const childAttachments = await client.listAttachments(child.id);
        const childAttachmentData = mapAttachments(childAttachments, baseUrl);

        // Fetch child images if embedding
        if (embedImages) {
          const childImageAttachments = childAttachments.filter(a =>
            a.mediaType.startsWith("image/")
          );
          for (const attachment of childImageAttachments) {
            try {
              const data = await client.downloadAttachment(attachment);
              const base64 = Buffer.from(data).toString("base64");
              images[attachment.filename] = {
                data: base64,
                mimeType: attachment.mediaType,
              };
            } catch {
              // Skip failed downloads
            }
          }
        }

        if (mergeChildren) {
          // Merge child content into main markdown
          finalMarkdown += `\n\n---\n\n# ${childPage.title}\n\n${childMarkdown}`;
        } else {
          // Add to children array for template loops
          childrenData.push({
            title: childPage.title,
            markdown: childMarkdown,
            author: childPage.createdBy?.displayName ?? "",
            authorEmail: childPage.createdBy?.email ?? "",
            modifier: childPage.modifiedBy?.displayName ?? childPage.createdBy?.displayName ?? "",
            modifierEmail: childPage.modifiedBy?.email ?? childPage.createdBy?.email ?? "",
            created: childPage.created ?? "",
            modified: childPage.modified ?? "",
            pageId: child.id,
            pageUrl: childPage.url ?? `${baseUrl}/spaces/${spaceKey}/pages/${child.id}`,
            tinyUrl: childPage.tinyUrl ?? "",
            labels: childPage.labels ?? [],
            attachments: childAttachmentData,
          });
        }
      }
    }
  }

  // Resolve content-by-label macro data
  const contentByLabelData = await resolveContentByLabel(
    client,
    contentByLabelQueries,
    baseUrl,
    spaceKey
  );

  // Build page data for Python subprocess
  const pageData = {
    title: page.title,
    markdown: finalMarkdown,
    author: {
      displayName: page.createdBy?.displayName ?? "",
      email: page.createdBy?.email ?? "",
    },
    modifier: {
      displayName: page.modifiedBy?.displayName ?? page.createdBy?.displayName ?? "",
      email: page.modifiedBy?.email ?? page.createdBy?.email ?? "",
    },
    created: page.created ?? "",
    modified: page.modified ?? "",
    pageId: page.id,
    pageUrl: page.url ?? `${baseUrl}/spaces/${spaceKey}/pages/${page.id}`,
    tinyUrl: page.tinyUrl ?? "",
    labels: page.labels ?? [],
    spaceKey,
    spaceName,
    spaceUrl,
    exportedBy: profile.email ?? "atlcli",
    templateName: templatePath,
    attachments: attachmentData,
    children: childrenData,
    macroChildren: childrenMacro,
    macroContentByLabel: contentByLabelData,
    images,  // Embedded images keyed by filename
    noTocPrompt,
  };

  // Resolve output path
  const resolvedOutputPath = resolve(outputPath);

  // Call Python subprocess
  const result = await callExportSubprocess(
    pageData,
    resolvedTemplatePath,
    resolvedOutputPath,
    opts
  );

  // Build output response
  const response: Record<string, unknown> = {
    success: true,
    output: result.output,
    page: {
      id: page.id,
      title: page.title,
      space: spaceKey,
    },
  };

  // Add note when --no-toc-prompt is used and document has TOC
  if (noTocPrompt && result.hasToc) {
    response.note = "Document contains TOC. Update manually: right-click TOC → Update Field";
  }

  output(response, opts);
}

/**
 * `--format pdf` command path (spec 008 T3.2/T3.3). Format-aware validation:
 * PDF forbids `--template` (PDF templates arrive via a later Lane P release) and
 * `--engine` (PDF is its own isomorphic engine). Output goes to `--output` OR
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

  if (hasFlag(flags, "template")) {
    return emitReportOutcome(
      usage("--template is DOCX-only; PDF templates arrive via a later release. Drop --template with --format pdf."),
      opts
    );
  }
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

  const { resolveExportedAt } = await import("./export-pdf.js");
  let exportedAt: Date | undefined;
  try {
    exportedAt = resolveExportedAt(getFlag(flags, "exported-at"));
  } catch (error) {
    return emitReportOutcome(usage(error instanceof Error ? error.message : String(error)), opts);
  }

  const { client, profile } = await getClient(flags, opts);
  const baseUrl = getConfluenceBaseUrl(profile);

  const { exportPdf } = await import("./export-pdf.js");
  const outcome = await exportPdf({
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
    opts,
  });
  emitReportOutcome(outcome, opts);
}

/**
 * T3.5 deprecation notice, pure and testable: when `--engine` is omitted the
 * python engine is still the default, but a future minor release flips the
 * default to the ts engine. The notice goes to stderr only (never stdout, so
 * `--json` stays clean), only when attached to a terminal (CI logs/pipes are
 * untouched), and is suppressed by `ATLCLI_SUPPRESS_ENGINE_NOTICE`. Returns the
 * notice line, or `null` when nothing should be printed.
 */
export function engineDeprecationNotice(input: {
  engine: string;
  engineFlagPresent: boolean;
  json: boolean;
  stderrIsTTY: boolean;
  suppressed: boolean;
}): string | null {
  if (input.engine !== "python") return null;
  if (input.engineFlagPresent) return null;
  if (input.json) return null;
  if (!input.stderrIsTTY) return null;
  if (input.suppressed) return null;
  return (
    "note: a future release will default DOCX export to the in-process 'ts' engine. " +
    "Pass --engine python to keep today's behavior, or --engine ts to adopt it now. " +
    "(set ATLCLI_SUPPRESS_ENGINE_NOTICE=1 to silence)"
  );
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
    return { client: new ConfluenceClient(ephemeral), profile: ephemeral };
  }

  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  assertCliAuthSupported(profile, opts);
  const client = new ConfluenceClient(profile);
  return { client, profile };
}

async function resolvePageId(
  client: ConfluenceClient,
  ref: string,
  opts: OutputOptions,
  signal?: AbortSignal
): Promise<string> {
  // If it looks like a numeric ID, return as-is
  if (/^\d+$/.test(ref)) {
    return ref;
  }

  // If it's a URL, extract the page ID
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    const match = ref.match(/pages\/(\d+)/);
    if (match) {
      return match[1];
    }
    // Try viewpage.action format
    const viewMatch = ref.match(/pageId=(\d+)/);
    if (viewMatch) {
      return viewMatch[1];
    }
    fail(opts, 1, ERROR_CODES.USAGE, `Could not extract page ID from URL: ${ref}`);
  }

  // If it's SPACE:Title format
  if (ref.includes(":")) {
    const [spaceKey, ...titleParts] = ref.split(":");
    const title = titleParts.join(":"); // Handle titles with colons
    const cql = `type=page AND space="${spaceKey}" AND title="${title}"`;
    const results = await client.searchPages(cql, 1, signal ? { signal } : {});
    if (results.length === 0) {
      fail(opts, 1, ERROR_CODES.API, `Page not found: ${ref}`);
    }
    return results[0].id;
  }

  // Otherwise treat as title search in default space
  fail(opts, 1, ERROR_CODES.USAGE, `Invalid page reference: ${ref}. Use ID, SPACE:Title, or URL.`);
}

async function resolveTemplatePath(templateRef: string, profileName?: string): Promise<string> {
  // If it's already an absolute path or relative path that exists
  if (existsSync(templateRef)) {
    return resolve(templateRef);
  }

  // Check if it has a Word extension
  const hasExtension = templateRef.endsWith(".docx") || templateRef.endsWith(".docm");

  // Extensions to try - if already has extension, use it; otherwise try both
  const extensions = hasExtension ? [""] : [".docx", ".docm"];

  // Check project templates directory first (highest priority)
  for (const ext of extensions) {
    const projectPath = join(process.cwd(), ".atlcli", "templates", "confluence", `${templateRef}${ext}`);
    if (existsSync(projectPath)) {
      return projectPath;
    }
  }

  // Check profile templates directory (if profile is set)
  if (profileName) {
    for (const ext of extensions) {
      const profilePath = join(homedir(), ".atlcli", "profiles", profileName, "templates", "confluence", `${templateRef}${ext}`);
      if (existsSync(profilePath)) {
        return profilePath;
      }
    }
  }

  // Check global templates directory
  for (const ext of extensions) {
    const globalPath = join(homedir(), ".atlcli", "templates", "confluence", `${templateRef}${ext}`);
    if (existsSync(globalPath)) {
      return globalPath;
    }
  }

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
  const level = (getFlag(flags, "level") ?? "global") as "global" | "profile" | "project";

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
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

  // Find the template
  const templatePath = await resolveTemplatePath(name, profile?.name);
  if (!existsSync(templatePath)) {
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

function mapAttachments(attachments: AttachmentInfo[], baseUrl: string) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return attachments.map(att => {
    const downloadUrlFull = att.downloadUrl
      ? (att.downloadUrl.startsWith("http")
        ? att.downloadUrl
        : `${normalizedBase}${att.downloadUrl}`)
      : "";

    return {
      id: att.id,
      filename: att.filename,
      mediaType: att.mediaType,
      fileSize: att.fileSize,
      size: att.fileSize,
      version: att.version,
      pageId: att.pageId,
      downloadUrl: att.downloadUrl,
      downloadUrlFull,
      url: att.url ?? "",
      comment: att.comment ?? "",
    };
  });
}

type ContentByLabelQuery = {
  labels: string[];
  spaces: string[];
  max?: number;
};

function parseMacroParams(paramStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!paramStr) return params;
  const regex = /(\w+)=("([^"]*)"|[^\s"]+)/g;
  for (const match of paramStr.matchAll(regex)) {
    const key = match[1];
    const raw = match[2];
    const value = raw.startsWith("\"") ? raw.slice(1, -1) : raw;
    params[key] = value;
  }
  return params;
}

function extractContentByLabelQueries(markdown: string): ContentByLabelQuery[] {
  const queries: ContentByLabelQuery[] = [];
  const pattern = /^:::content-by-label(?:[ \t]+([^\n]*))?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const params = parseMacroParams(match[1] ?? "");
    const labels = (params.labels ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const spaces = (params.spaces ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const max = params.max ? Number(params.max) : undefined;
    if (labels.length === 0) continue;
    queries.push({ labels, spaces, max });
  }
  return queries;
}

async function resolveContentByLabel(
  client: ConfluenceClient,
  queries: ContentByLabelQuery[],
  baseUrl: string,
  fallbackSpaceKey: string
): Promise<Array<{ labels: string; spaces: string; max?: number; items: Array<{ title: string; pageId: string; pageUrl: string }> }>> {
  const results: Array<{ labels: string; spaces: string; max?: number; items: Array<{ title: string; pageId: string; pageUrl: string }> }> = [];
  for (const query of queries) {
    const clauses = ["type=page", ...query.labels.map(label => `label = \"${label}\"`)];
    if (query.spaces.length > 0) {
      const spaceList = query.spaces.map(space => `"${space}"`).join(",");
      clauses.push(`space in (${spaceList})`);
    } else if (fallbackSpaceKey) {
      clauses.push(`space = \"${fallbackSpaceKey}\"`);
    }

    const cql = clauses.join(" AND ");
    const limit = query.max ?? 25;
    const search = await client.search(cql, { limit, detail: "minimal" });
    const items = search.results.map(item => ({
      title: item.title,
      pageId: item.id,
      pageUrl: item.url ?? `${baseUrl}/spaces/${item.spaceKey ?? fallbackSpaceKey}/pages/${item.id}`,
    }));

    results.push({
      labels: query.labels.join(","),
      spaces: query.spaces.join(","),
      max: query.max,
      items,
    });
  }
  return results;
}

interface TsEngineArgs {
  client: ConfluenceClient;
  profile: Profile;
  pagePromise: Promise<ConfluencePageDetails>;
  pageId: string;
  baseUrl: string;
  /** Absolute template path, or undefined for the bundled default (spec 010 W3-D). */
  resolvedTemplatePath: string | undefined;
  outputPath: string;
  embedImages: boolean;
  /** `--keep-ignored`: run export-control macros in passthrough mode (spec 003). */
  keepIgnored?: boolean;
  /** spec 004: `false` under `--no-live-macros` suppresses port-backed macros. */
  liveMacros: boolean;
  strict: boolean;
  opts: OutputOptions;
}

/**
 * Spec 006 Task 5: drive the isomorphic `@atlcli/docx` engine — the exact
 * code the Chrome extension runs — with Node-side env implementations:
 * template bytes from the filesystem, output to the filesystem, resolver
 * round-trips over the token-auth client, and image bytes over the client's
 * token-auth binary download (spec 005: attachment refs arrive as
 * wiki-base-relative download URLs; external images as absolute URLs).
 * The engine is imported lazily so the common CLI paths never load
 * pizzip/docxtemplater.
 *
 * The site's cookie-only
 * `/download/attachments/{pageId}/{filename}` path 401s under API-token Basic
 * auth (verified against Cloud), so attachment refs resolve through the REST
 * attachment listing to the API's own `downloadUrl`
 * (`/rest/api/content/{id}/child/attachment/{attId}/download`), which honors
 * token auth. The listing is cached per page — one extra round-trip per page,
 * not per image. External image URLs are absolute and fetched without auth.
 */
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
  chapterAnchorById?: ReadonlyMap<string, string>
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

async function exportWithTsEngine(args: TsEngineArgs): Promise<void> {
  const {
    client,
    profile,
    pagePromise,
    pageId,
    baseUrl,
    resolvedTemplatePath,
    outputPath,
    embedImages,
    keepIgnored,
    liveMacros,
    strict,
    opts,
  } = args;
  // Everything local (engine import + template bytes) loads WHILE the page
  // round-trip is in flight. The much larger rasterizer wasm/fonts are gated
  // on the page storage below.
  // A path reads from disk; no path resolves to the bundled default template and
  // carries the `template-default-used` note (spec 010 W3-D). Chained off the
  // module import so it still runs concurrently with the engine imports and the
  // page round-trip, exactly as the inline `readFile`/`stat` pair used to.
  const internalsPromise = import("./export-internals.js");
  const templatePromise = internalsPromise.then((m) => m.loadExportTemplate(resolvedTemplatePath));
  const [
    { runExport, fileOutputSink },
    { buildGetIncludedPage },
    { createAssetByteCache, mightContainMermaid, mightReferenceImage, prestartPageDependentDeps, tokenAssetFetcher, tokenMentionLookup },
    template,
  ] = await Promise.all([
    import("@atlcli/docx"),
    import("@atlcli/docx/internal"),
    internalsPromise,
    templatePromise,
  ]);
  const templateBytes = template.bytes;
  const assetCache = createAssetByteCache(baseUrl);

  const cliNotes: string[] = [];

  // Memoized per-export round-trips, shared between the deps below. Space +
  // icon come from ONE `?expand=icon` call (previously two calls to the same
  // endpoint when a template used $scroll.space.* and a logo placeholder).
  let spaceInfoP: Promise<Awaited<ReturnType<ConfluenceClient["getSpaceWithIcon"]>>> | undefined;
  const spaceInfo = (key: string): NonNullable<typeof spaceInfoP> =>
    (spaceInfoP ??= client.getSpaceWithIcon(key));
  let currentUserP: ReturnType<ConfluenceClient["getCurrentUser"]> | undefined;
  const currentUser = (): NonNullable<typeof currentUserP> => (currentUserP ??= client.getCurrentUser());
  let ownerP: ReturnType<ConfluenceClient["getPageOwner"]> | undefined;
  const pageOwner = (id: string): NonNullable<typeof ownerP> => (ownerP ??= client.getPageOwner(id));
  let homepageP: ReturnType<ConfluenceClient["getSpaceHomepageStorage"]> | undefined;
  const spaceHomepage = (key: string): NonNullable<typeof homepageP> =>
    (homepageP ??= client.getSpaceHomepageStorage(key));

  // Pre-start the round-trips this TEMPLATE will need (a quick local scan
  // names them) so they run concurrently with the page fetch instead of
  // after it. The resolver keeps its lazy contract — it still only awaits a
  // dep when a placeholder uses it, and these memoized promises are exactly
  // what it receives. The `.catch` branches only prevent unhandled-rejection
  // noise; the resolver observes and reports the original error.
  const templateDeps = new Set<string>();
  try {
    const { scanZip, unzipDocx } = await import("@atlcli/docx/scan");
    // classifyPlaceholder is an internal helper (not a frozen v1 seam) — spec
    // 009 review C1 trimmed it out of the `.` barrel; reach it via ./internal.
    const { classifyPlaceholder } = await import("@atlcli/docx/internal");
    const scan = scanZip(unzipDocx(templateBytes));
    for (const dependency of scan.supported
      .flatMap((h) => h.raw)
      .map((raw) => classifyPlaceholder(raw).dependency)) {
      templateDeps.add(dependency);
    }
    if (templateDeps.has("currentUser")) currentUser().catch(() => {});
    if (templateDeps.has("owner")) pageOwner(pageId).catch(() => {});
  } catch {
    // Pre-scan is a pure optimization; a scan failure surfaces properly
    // inside runExport.
  }

  // Space-key-dependent work can only start after page details arrive. Hook
  // the already-running page promise now so these exact memoized promises
  // overlap rasterizer setup rather than waiting for runExport's resolver.
  prestartPageDependentDeps({
    pagePromise,
    templateDeps,
    embedImages,
    getSpaceWithIcon: spaceInfo,
    getSpaceHomepageStorage: spaceHomepage,
  });

  // Mermaid diagrams render via resvg-wasm (spec 005a), and SVG page
  // attachments rasterize their PNG fallback through the same rasterizer
  // (spec 006 G4). A missing rasterizer is not an error: the engine degrades
  // those blocks to readable source / a report note. Build the rasterizer when
  // EITHER a mermaid macro OR any image/attachment reference is present, so an
  // SVG-only page (no mermaid macro) still gets a rasterizer instead of
  // degrading with `image-svg-no-rasterizer`.
  const rasterizerPromise = pagePromise.then(async (details) => {
    const storage = details.storage ?? "";
    if (!mightContainMermaid(storage) && !mightReferenceImage(storage)) {
      return { needed: false as const, rasterizer: null, error: undefined as string | undefined };
    }
    try {
      const { buildDiagramRasterizer } = await import("./export-rasterizer.js");
      let error: string | undefined;
      const rasterizer = await buildDiagramRasterizer((message) => {
        error = message;
      });
      return { needed: true as const, rasterizer, error };
    } catch (err) {
      return {
        needed: true as const,
        rasterizer: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  rasterizerPromise.catch(() => {});
  const [page, rasterizerState] = await Promise.all([pagePromise, rasterizerPromise]);
  const rasterizer = rasterizerState.rasterizer;
  if (rasterizerState.needed && !rasterizer) {
    cliNotes.push(
      "diagram rasterizer unavailable; mermaid diagrams export as code blocks and SVG attachments are skipped" +
        (rasterizerState.error ? ` (${rasterizerState.error})` : "") +
        "."
    );
  }

  // Resolve @mentions to display names before serialization, matching the
  // extension's pipeline (spec 008 T3.2 — the CLI had this parity gap). Walk the
  // storage here and hand the engine pre-resolved blocks; a getUsersBulk call
  // only happens when an account-id-only mention is actually present.
  const walked = storageToBlocks(page.storage ?? "", { exporter: "word" });
  const mention = await resolveExportMentions(walked.blocks, tokenMentionLookup(client));
  const tsSourceNotes = [...walked.notes];
  if (mention.unresolved > 0) {
    tsSourceNotes.push({
      level: "warning",
      code: "mention-unresolved",
      message: `${mention.unresolved} mention(s) could not be resolved to a display name.`,
    });
  }

  const resolvedOutputPath = resolve(outputPath);
  const macroSetup = await buildTsEngineMacroOptions(profile, client, "docx", liveMacros);
  const report = await runExport(
    {
      details: page,
      blocks: mention.blocks,
      sourceNotes: tsSourceNotes,
      template: template.meta,
      embedImages,
      ...(keepIgnored ? { exportControls: "passthrough" as const } : {}),
      deps: {
        getSpace: async (key: string) => (await spaceInfo(key)).space,
        getCurrentUser: currentUser,
        getPageOwner: pageOwner,
        getSpaceHomepageStorage: spaceHomepage,
        // Spec 005 logo pass: the space icon path feeds $scroll.spacelogo /
        // $scroll.globallogo; bytes then ride the asset fetcher below. A
        // custom logo's icon.path is a cookie-only `/download/attachments/
        // {contentId}/{filename}` URL that 401s under token auth (same Cloud
        // behavior as page attachments), so the content id + filename are
        // carried on the ref — the fetcher then resolves them through the
        // REST attachment listing, which honors token auth.
        getSpaceLogo: async (key: string) => {
          const icon = (await spaceInfo(key)).icon;
          if (!icon) return null;
          const m = icon.path.match(/^\/download\/attachments\/(\d+)\/([^/?]+)/);
          return {
            url: icon.path,
            pageId: m?.[1],
            filename: m ? decodeURIComponent(m[2]) : undefined,
          };
        },
        // Cross-page include (spec 005 D1): the shared, isomorphic loader owns
        // id-sorted determinism, ambiguity, and per-class error mapping —
        // identical to the extension path. Title lookups go through the DIRECT
        // content endpoint (findPagesByTitle), NOT CQL, so a page created moments
        // before the export is findable immediately (the search index lags).
        // Concurrency lives ONLY in the engine's include pool, so this loader
        // stays throttle-agnostic; the pool de-duplicates repeated refs.
        getIncludedPage: buildGetIncludedPage({
          getPage: (id) => client.getPage(id),
          findPagesByTitle: (title, spaceKey) => client.findPagesByTitle(title, { spaceKey }),
          defaultSpaceKey: page.spaceKey,
        }),
      },
    },
    {
      templates: { getBytes: async () => templateBytes },
      assets: macroSetup.wrapAssets(tokenAssetFetcher(client, assetCache)),
      rasterizer: rasterizer ?? undefined,
      macros: macroSetup.macros,
      output: fileOutputSink(resolvedOutputPath),
    }
  );

  // Unified report (spec 008 review): the SAME atlcli.export-report/1 schema
  // and exit-code kernel the PDF path uses — one JSON shape per invocation.
  emitReportOutcome(
    {
      ok: true,
      report: buildReport({
        format: "docx",
        engine: "ts",
        // Per-page provenance for the one page in scope, projected from the
        // engine's RECONCILED source notes (spec 010) — the same list the PDF
        // path projects, so both formats describe this page identically. Never
        // project the pre-export walk: its `macro-not-rendered` is provisional
        // and contradicts the aggregate the moment a macro renders live.
        sourcePages: [
          {
            id: page.id,
            title: page.title,
            notes: (report.sourceNotes ?? []).map((n) => noteToIssue(n, "compose", page.id)),
          },
        ],
        outputDetails: [
          {
            output: resolvedOutputPath,
            embeddedImages: report.embeddedImages,
            renderedDiagrams: report.renderedDiagrams,
            skippedAssets: report.skippedImages,
          },
        ],
        issues: [
          ...template.notes.map((n) => noteToIssue(n, "prepare")),
          ...report.notes.map((n) => noteToIssue(n, "prepare")),
          ...cliNotes.map((message) => ({
            code: "cli-note",
            severity: "warning" as const,
            phase: "prepare",
            retryable: false,
            message,
          })),
        ],
        timings: { totalMs: report.durationMs },
        // Completeness contract (spec 002): present on EVERY successful export,
        // not just tree/space, so `jq -r '.complete'` is never null on success.
        // Single-page exports are always complete. Scope traceability
        // (requestedScope/resolvedScope) stays tree/space-only by design — and
        // is absent on the PDF single-page path too (symmetric).
        complete: report.complete,
        placeholders: { resolved: report.resolvedCount, unsupported: report.unsupportedNames },
        strict,
      }),
    },
    opts
  );
}

interface TreeEngineArgs {
  client: ConfluenceClient;
  profile: Profile;
  request: ParsedExportRequest;
  baseUrl: string;
  /** Absolute template path, or undefined for the bundled default (spec 010 W3-D). */
  resolvedTemplatePath: string | undefined;
  outputPath: string;
  embedImages: boolean;
  /** spec 004: `false` under `--no-live-macros`. */
  liveMacros: boolean;
  strict: boolean;
  opts: OutputOptions;
}

/**
 * Progress router (spec 002 A5). In `--json` mode stdout must carry EXACTLY one
 * JSON document, so every progress event goes to stderr as JSONL (one
 * `ExportProgressEvent` per line). Otherwise a single-line spinner is written to
 * stderr, plus a one-time human page-count line once the tree size is known
 * (the "pre-flight count" — printed from the walk's own `onProgress` total,
 * since `fetchExportTree` discovers and body-fetches in one pass with no
 * separate pre-count hook).
 */
function makeProgressReporter(opts: OutputOptions): {
  report: ExportProgressCallback;
  clear: () => void;
} {
  const json = opts.json;
  let announcedTotal = false;
  let dirty = false;
  const report: ExportProgressCallback = (event) => {
    if (json) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
      return;
    }
    if (event.phase === "fetch" && event.total !== null && !announcedTotal) {
      announcedTotal = true;
      process.stderr.write(`Exporting ${event.total} page${event.total === 1 ? "" : "s"}...\n`);
    }
    const total = event.total === null ? "?" : String(event.total);
    const detail = event.detail ? ` ${event.detail}` : "";
    const line = `[${event.phase}] ${event.done}/${total}${detail}`;
    process.stderr.write(`\r${line.slice(0, 120).padEnd(120)}`);
    dirty = true;
  };
  const clear = () => {
    if (!json && dirty) process.stderr.write(`\r${" ".repeat(120)}\r`);
  };
  return { report, clear };
}

/**
 * True when any composed block needs a rasterizer: a mermaid code block
 * (spec 005a) or an image block that could be an SVG attachment (spec 006 G4).
 * The block model does not always know an attachment's bytes ahead of the
 * fetch, so any attachment image conservatively triggers the build — matching
 * the single-page CLI gate's over-triggering-by-design stance.
 */
function blocksNeedRasterizer(blocks: readonly ExportBlock[]): boolean {
  for (const block of blocks) {
    switch (block.type) {
      case "codeBlock":
        if ((block.language ?? "").toLowerCase() === "mermaid") return true;
        break;
      case "image":
        return true;
      case "callout":
      case "blockquote":
      case "orientation":
        if (blocksNeedRasterizer(block.content)) return true;
        break;
      case "list":
        for (const item of block.items) if (blocksNeedRasterizer(item.content)) return true;
        break;
      case "table":
        for (const row of block.rows)
          for (const cell of row.cells) if (blocksNeedRasterizer(cell.content)) return true;
        break;
    }
  }
  return false;
}

/**
 * Tree/space DOCX export (spec 002 CLI task). Drives the shared orchestration
 * layer — `fetchExportTree` → `composeChapters` → `runExport` — the same
 * isomorphic pipeline the extension host will consume. A `space` request is
 * resolved to its homepage id here (one construction site, `buildExportScope`),
 * so `--scope space` becomes a tree rooted at the homepage with the requested
 * scope still recorded for the `--json` report.
 */
async function exportTreeWithTsEngine(args: TreeEngineArgs): Promise<void> {
  const {
    client,
    profile,
    request,
    baseUrl,
    resolvedTemplatePath,
    outputPath,
    embedImages,
    liveMacros,
    strict,
    opts,
  } = args;

  // Ctrl-C → AbortController, installed BEFORE any network work so root
  // resolution, discovery, body fetch, asset fetch and the final write all stop
  // promptly (the underlying client + sinks honor the signal). Removed again in
  // the finally so later CLI work is unaffected.
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);

  const { report: onProgress, clear: clearProgress } = makeProgressReporter(opts);

  try {
    // Resolve the root page id (the one construction site for ExportScope).
    let rootId: string;
    if (request.scopeKind === "space") {
      const homepageId = await client.getSpaceHomepageId(request.spaceKey!, {
        signal: controller.signal,
      });
      if (!homepageId) throw new SpaceHomepageError(request.spaceKey!);
      rootId = homepageId;
    } else {
      rootId = await resolvePageId(client, request.pageRef!, opts, controller.signal);
    }
    const scope: ExportScope = buildExportScope(request, rootId);

    // Fetch the ordered tree (label pruning + completeness contract inside).
    const treeResult = await fetchExportTree(confluenceTreeSource(client), scope, {
      ...(request.labels ? { labels: request.labels } : {}),
      completenessMode: request.completenessMode,
      ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
      ...(request.maxFolders !== undefined ? { maxFolders: request.maxFolders } : {}),
      signal: controller.signal,
      onProgress: (p) =>
        onProgress({ phase: "fetch", done: p.fetched, total: p.total, detail: p.currentTitle }),
    });

    // Compose one chapterized document. Out-of-scope links become absolute URLs
    // built via buildConfluenceUrl (NEVER hand-concatenated with "/wiki/", which
    // would double the Cloud wiki segment / add one DC never has).
    const resolveExternalUrl: NonNullable<ComposeOptions["resolveExternalUrl"]> = (
      target,
      anchor
    ) => {
      let path: string;
      if (target.contentId) {
        path = target.spaceKey
          ? `spaces/${target.spaceKey}/pages/${target.contentId}`
          : `pages/viewpage.action?pageId=${target.contentId}`;
      } else if (target.spaceKey) {
        path = `display/${target.spaceKey}/${encodeURIComponent(target.contentTitle)}`;
      } else {
        path = `search?text=${encodeURIComponent(target.contentTitle)}`;
      }
      const url = buildConfluenceUrl(profile, path);
      return anchor ? `${url}#${anchor}` : url;
    };

    const composed = composeChapters(treeResult.nodes, { resolveExternalUrl });
    const sourceNotes: ExportNote[] = [...treeResult.notes, ...composed.notes];

    // Root page details drive template placeholders (title/author/…) — the same
    // convention single-page export uses.
    const rootDetails = await client.getPageDetails(rootId, { signal: controller.signal });

    // Load engine + template + optional rasterizer. No `--template` resolves to
    // the bundled default (spec 010 W3-D), with a `template-default-used` note.
    const internalsPromise = import("./export-internals.js");
    const [{ runExport, fileOutputSink }, { createAssetByteCache, tokenAssetFetcher, tokenMentionLookup }, template] =
      await Promise.all([
        import("@atlcli/docx"),
        internalsPromise,
        internalsPromise.then((m) => m.loadExportTemplate(resolvedTemplatePath)),
      ]);
    const templateBytes = template.bytes;
    const assetCache = createAssetByteCache(baseUrl);

    // Resolve @mentions across the WHOLE composed document with one deduped bulk
    // lookup (spec 008 T3.2 parity). Account ids are deduped inside
    // resolveExportMentions, so a name repeated across chapters costs one call.
    const mention = await resolveExportMentions(composed.blocks, tokenMentionLookup(client));
    if (mention.unresolved > 0) {
      sourceNotes.push({
        level: "warning",
        code: "mention-unresolved",
        message: `${mention.unresolved} mention(s) could not be resolved to a display name.`,
      });
    }

    let rasterizer: import("@atlcli/docx").SvgRasterizer | undefined;
    const cliNotes: string[] = [];
    if (embedImages && blocksNeedRasterizer(composed.blocks)) {
      let rasterizerError: string | undefined;
      try {
        const { buildDiagramRasterizer } = await import("./export-rasterizer.js");
        rasterizer = (await buildDiagramRasterizer((message) => {
          rasterizerError = message;
        })) ?? undefined;
      } catch (err) {
        rasterizerError = err instanceof Error ? err.message : String(err);
        rasterizer = undefined;
      }
      if (!rasterizer) {
        cliNotes.push(
          "diagram rasterizer unavailable; mermaid diagrams export as code blocks and SVG attachments are skipped" +
            (rasterizerError ? ` (${rasterizerError})` : "") +
            "."
        );
      }
    }

    const resolvedOutputPath = resolve(outputPath);
    const treeMacroSetup = await buildTsEngineMacroOptions(
      profile,
      client,
      "docx",
      liveMacros,
      composed.chapterAnchorById
    );
    const docxReport = await runExport(
      {
        details: rootDetails,
        blocks: mention.blocks,
        sourceNotes,
        complete: treeResult.complete,
        signal: controller.signal,
        onProgress,
        template: template.meta,
        embedImages,
        deps: {
          getSpace: async (key: string) => (await client.getSpaceWithIcon(key)).space,
          getCurrentUser: () => client.getCurrentUser(),
          getPageOwner: (id: string) => client.getPageOwner(id),
          getSpaceHomepageStorage: (key: string) => client.getSpaceHomepageStorage(key),
          getSpaceLogo: async (key: string) => {
            const icon = (await client.getSpaceWithIcon(key)).icon;
            if (!icon) return null;
            const m = icon.path.match(/^\/download\/attachments\/(\d+)\/([^/?]+)/);
            return {
              url: icon.path,
              pageId: m?.[1],
              filename: m ? decodeURIComponent(m[2]) : undefined,
            };
          },
        },
        ...(rasterizer ? { rasterizer } : {}),
      },
      {
        templates: { getBytes: async () => templateBytes },
        assets: treeMacroSetup.wrapAssets(tokenAssetFetcher(client, assetCache)),
        ...(rasterizer ? { rasterizer } : {}),
        macros: treeMacroSetup.macros,
        output: fileOutputSink(resolvedOutputPath),
      }
    );

    clearProgress();

    // Unified report (spec 008 review): the SAME atlcli.export-report/1 schema
    // and exit-code kernel the PDF path uses. Spec 002's report content
    // (requestedScope/resolvedScope/complete/notesByCode) rides WITHIN the
    // unified schema as first-class optional fields.
    const sourcePages = treeResult.nodes
      .filter((node): node is Extract<typeof node, { kind: "page" }> => node.kind === "page")
      .map((node) => ({
        id: node.pageId,
        title: node.title,
        notes: node.notes.map((note) => noteToIssue(note, "compose", node.pageId)),
      }));

    emitReportOutcome(
      {
        ok: true,
        report: buildTreeExportReport({
          format: "docx",
          engine: "ts",
          sourcePages,
          outputDetails: [
            {
              output: resolvedOutputPath,
              embeddedImages: docxReport.embeddedImages,
              renderedDiagrams: docxReport.renderedDiagrams,
              skippedAssets: docxReport.skippedImages,
            },
          ],
          issues: [
            ...template.notes.map((n) => noteToIssue(n, "prepare")),
            ...docxReport.notes.map((n) => noteToIssue(n, "prepare")),
            ...cliNotes.map((message) => ({
              code: "cli-note",
              severity: "warning" as const,
              phase: "prepare",
              retryable: false,
              message,
            })),
          ],
          timings: { durationMs: docxReport.durationMs, ...docxReport.timings },
          // Scope traceability (spec 002 A5) from the ONE shared builder the PDF
          // path also uses — both formats emit an identical field set here.
          // `scope` + `complete` are REQUIRED by buildTreeExportReport, so a tree
          // path can no longer drop them and still compile.
          scope: buildScopeReportFields(request, scope),
          complete: docxReport.complete,
          placeholders: {
            resolved: docxReport.resolvedCount,
            unsupported: docxReport.unsupportedNames,
          },
          strict,
        }),
      },
      opts
    );
  } catch (error) {
    clearProgress();
    // Same classified failure path as PDF: one JSON document, documented codes.
    const classified = classifyError(error);
    emitReportOutcome(
      {
        ok: false,
        report: buildReport({
          format: "docx",
          engine: "ts",
          sourcePages: [],
          outputDetails: [],
          issues: [classified.issue],
          failureExitCode: classified.exitCode,
        }),
      },
      opts
    );
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function findPythonExecutable(): string {
  // Check for venv in the export package directory (development mode)
  // Go up from dist/commands to find packages/export/.venv
  const projectRoot = resolve(__dirname, "..", "..", "..", "..");
  const venvPython = join(projectRoot, "packages", "export", ".venv", "bin", "python");

  if (existsSync(venvPython)) {
    return venvPython;
  }

  // Fall back to system Python
  return process.platform === "win32" ? "python" : "python3";
}

interface ExportResult {
  output: string;
  hasToc: boolean;
}

async function callExportSubprocess(
  pageData: object,
  templatePath: string,
  outputPath: string,
  opts: OutputOptions
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    // Find Python executable
    const pythonCmd = findPythonExecutable();

    const proc = spawn(pythonCmd, [
      "-m", "atlcli_export.cli",
      "--template", templatePath,
      "--output", outputPath,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send page data as JSON to stdin
    proc.stdin.write(JSON.stringify(pageData));
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        // Try to parse error from stdout (our JSON response)
        try {
          const response = JSON.parse(stdout);
          if (response.error) {
            fail(opts, 1, ERROR_CODES.IO, `Export failed: ${response.error}`);
          }
        } catch {
          // Ignore parse error, use stderr
        }
        fail(opts, 1, ERROR_CODES.IO, `Export failed: ${stderr || stdout || "Unknown error"}`);
      }

      try {
        const response = JSON.parse(stdout);
        if (response.success) {
          resolve({
            output: response.output,
            hasToc: response.hasToc ?? false,
          });
        } else {
          fail(opts, 1, ERROR_CODES.IO, `Export failed: ${response.error}`);
        }
      } catch {
        fail(opts, 1, ERROR_CODES.IO, `Invalid response from export: ${stdout}`);
      }
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fail(opts, 1, ERROR_CODES.IO,
          `Python not found. Install Python 3.12+ and atlcli-export package:\n` +
          `  pip install atlcli-export`
        );
      }
      fail(opts, 1, ERROR_CODES.IO, `Failed to spawn Python: ${err.message}`);
    });
  });
}

function exportHelp(): string {
  return `atlcli wiki export <page> [--template <name>] --output <path>

Export a Confluence page to DOCX using a Word template (--engine ts falls back
to a bundled default template when --template is omitted).

Arguments:
  <page>              Page reference (ID, SPACE:Title, or URL)

Options:
  --format <fmt>      Output format: "docx" (default) or "pdf"
  --template, -t      Template name or path (DOCX only). Required with
                      --engine python; OPTIONAL with --engine ts, which falls
                      back to a bundled default template (page title, export
                      date, page body) and reports which template it used.
                      The ts engine fills $scroll.* placeholders only — a
                      docxtpl/Jinja template ({{ … }}, {% … %}) exports with
                      those left as literal text and a warning note.
  --output, -o        Output file path (required, or use --out-dir for PDF)
  --no-images         Do not embed images from page attachments (default embeds)
  --no-merge          Keep children as separate array (for loops in templates)
  --no-toc-prompt     Disable TOC dirty flag (Word won't prompt to update fields)
  --keep-ignored      Keep scroll-only/scroll-ignore content for debugging
                      (--engine ts, single page; export is marked in the report)
  --no-live-macros    Deterministic export: skip live (Jira/export_view/attachment)
                      macro rendering. Pure macros (TOC, includes) still render.
                      Requires --engine ts. NOT network-free — the page body and
                      its own attachments still fetch.
  --engine <name>     Rendering engine: "python" (default, docxtpl) or "ts"
                      (isomorphic @atlcli/docx engine — same as the browser
                      extension; $scroll.* placeholders + image embedding +
                      mermaid diagram rendering, no Python needed; required for
                      tree/space/label export)
  --profile <name>    Use a specific auth profile
  --report json       Synonym for --json (emit the report to stdout); applies to
                      PDF and ts-engine DOCX exports alike

PDF Options (--format pdf):
  --out-dir <dir>           Write to a directory with a derived <pageId>-<slug>.pdf
                            name (alternative to --output; not both)
  --force                   Overwrite an existing regular output file
  --strict                  Exit code 2 if the export completed with warnings
  --no-cache                Do not persist downloaded assets across invocations
  --exported-at <ISO8601>   Fix the export timestamp (reproducible builds; also
                            honors the SOURCE_DATE_EPOCH env var)
  (--template and --engine are not valid with --format pdf.)

Profile-free auth (CI, any format):
  --base-url <url>          Confluence base URL (or ATLCLI_BASE_URL); requires
                            HTTPS unless --allow-http
  --email <addr>            Account email (or ATLCLI_EMAIL); required for
                            api-token auth, forbidden for bearer
  --auth-type <kind>        api-token (default) | bearer (or ATLCLI_AUTH_TYPE)
  --allow-http              Permit a plain-HTTP --base-url (Data Center opt-in)
  (The token comes from ATLCLI_API_TOKEN. Ephemeral mode is fail-closed: use a
   named --profile OR a full ephemeral set, never a mix.)

Scope Options (--engine ts):
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

Exit Codes (--format pdf and --engine ts; the legacy python engine exits 0/1):
  0    Success
  1    Usage / config / local IO error
  2    Completed with warnings (only under --strict)
  3    Authentication error (401/403)
  4    Remote/API error (page not found, fetch failed)
  5    Compile / validation failure (incl. tree limits, label filters, budget)
  130  Cancelled (Ctrl-C / SIGINT)

JSON Output (--json / --report json):
  PDF and ts-engine exports emit EXACTLY one "atlcli.export-report/1" document
  on stdout (sourcePages, outputDetails, issues, scope traceability, exitCode).
  Progress events go to stderr.

Template Resolution:
  Templates are resolved in order (first match wins):
  1. Direct file path (if exists)
  2. Project: .atlcli/templates/confluence/<name>.docx
  3. Profile: ~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx
  4. Global: ~/.atlcli/templates/confluence/<name>.docx
  With --engine ts and no --template at all: the bundled default template
  (reported as the info note "template-default-used").

Template Management:
  atlcli wiki export template list                    List available templates
  atlcli wiki export template save <name> --file <path> [--level global|profile|project]
  atlcli wiki export template delete <name> --confirm

Examples:
  # Zero-config: one page to DOCX with the bundled default template
  atlcli wiki export 12345 --output page.docx --engine ts

  # Minimal: one page tree to a single DOCX
  atlcli wiki export 12345 --template corporate --output handbook.docx --engine ts --scope tree

  # Advanced: whole space, drop internal pages, machine-readable report for CI
  atlcli wiki export --template corporate --output space.docx --engine ts --scope space \\
    --space DOCSY --label-exclude internal --completeness partial --json

  # PDF: single page to a tagged, font-embedded PDF with a JSON report for CI
  atlcli wiki export 12345 --format pdf --output ./report.pdf --json

  atlcli wiki export 12345678 --template corporate --output ./report.docx
  atlcli wiki export "DOCS:Architecture" -t ./my-template.docx -o ./arch.docx
  atlcli wiki export 12345 -t basic -o out.docx --no-images
  atlcli wiki export 12345 -t scroll-corporate.docx -o out.docx --engine ts
  atlcli wiki export template save corporate --file ./template.docx --level global
  atlcli wiki export template list
`;
}
