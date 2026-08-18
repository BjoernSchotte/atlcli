/**
 * `atlcli wiki import <file.docx>` — review-first semantic DOCX import
 * (specs/import-docx-mvp vertical slice).
 *
 * Without `--confirm` the command parses, previews, and exits without any
 * network write. With `--confirm` it publishes exactly the previewed ADF to a
 * new Cloud page, verifies the readback, and rolls the page back if
 * publication cannot be verified.
 */
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  getFlags,
  hasFlag,
  loadConfig,
  output,
  resolveDeploymentType,
  sha256Hex,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  assessEditability,
  buildImportPreview,
  documentToAdf,
  renderImportPreview,
  type AdfMediaResolution,
  IMPORT_DOCUMENT_SCHEMA_V2,
  importReferenceKey,
  type ImportBlock,
  type AdfNode,
} from "@atlcli/import-core";
import {
  createPreparedCloudShell,
  finalizePreparedCloudPage,
  prepareConfluencePage,
  publishPreparedCloudPage,
  publishPreparedDcPage,
  rollbackOwnedPages,
  verifyAdfSemanticReadback,
} from "@atlcli/import-confluence";
import {
  SplitTitleConflictError,
  buildGovernance,
  governanceHasEffects,
  principalId,
  renderGovernanceSummary,
  renderPolicySummary,
  resolveImportPolicy,
  type PolicyLayerInput,
  type ResolvedImportPolicy,
  countPages,
  parseDocx,
  splitDocument,
  type ImportPagePlan,
  extractDocxEntriesFromZip,
  type ImportComment,
  type ImportedDocument,
  type SplitResult,
} from "@atlcli/import-docx";
import { assertCliAuthSupported } from "./session-guard.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { handleRecipeCommand, loadRecipeById, loadRecipeFile } from "./wiki-import-recipe.js";
import { handleManifestBatch } from "./wiki-import-batch.js";
import {
  applyMetadata,
  applyRestriction,
  findFreeTitle,
} from "./wiki-import-destination.js";
import {
  BASELINE_PROPERTY_KEY,
  buildBaseline,
  diffAdfBlocks,
  digestAdfValue,
  parseRecipe,
  recipeApplicability,
  renderSemanticDiffLines,
  validateBaseline,
  type ImportedPageBaselineV1,
} from "@atlcli/import-docx";

interface RecipeInfo {
  id: string;
  version: string;
  digest: string;
  source: "repo" | "user";
}

const PDF_ONLY_FLAGS = [
  "scan-policy",
  "visual-fallback",
  "accept-reported-pages",
  "reading-order",
  "attach-source",
  "max-wiki-pages",
] as const;

function rejectPdfOnlyFlagsForDocx(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): void {
  const found = PDF_ONLY_FLAGS.filter((flag) => hasFlag(flags, flag));
  if (found.length > 0) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `PDF-only option(s) cannot be used with DOCX: ${found.map((flag) => `--${flag}`).join(", ")}.`, {
      flags: found,
    });
  }
}

/** Load `--recipe <file>` / `--recipe-id <id>` into a policy layer. */
async function loadRecipeLayer(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<{ layer?: PolicyLayerInput; info?: RecipeInfo }> {
  const path = getFlag(flags, "recipe");
  const id = getFlag(flags, "recipe-id");
  if (path && id) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Give either --recipe <file> or --recipe-id <id>, not both.", {});
  }
  if (!path && !id) return {};
  const result = path ? await loadRecipeFile(path) : await loadRecipeById(id!);
  if (!result.entry) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Invalid recipe:\n  ${result.errors.join("\n  ")}`, {
      errors: result.errors,
    });
  }
  const parsed = result.entry.parsed!;
  const applicability = recipeApplicability(parsed.recipe, "cloud");
  if (applicability) {
    fail(opts, 1, ERROR_CODES.VALIDATION, applicability, { recipeId: parsed.recipe.id });
  }
  return {
    layer: parsed.policyLayer,
    info: {
      id: parsed.recipe.id,
      version: parsed.recipe.version,
      digest: parsed.digest,
      source: result.entry.source,
    },
  };
}

/**
 * Resolve the layered import policy from CLI flags and an optional override
 * file (plan 007 baseline: defaults < recipe < CLI < override file).
 * Fails closed on any validation or precedence conflict.
 */
function resolvePolicyFromFlags(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  recipeLayer?: PolicyLayerInput,
): ResolvedImportPolicy {
  const cli: PolicyLayerInput = {};
  const revisions = getFlag(flags, "revisions");
  const unsupported = getFlag(flags, "unsupported");
  if (revisions || unsupported) {
    cli.options = {
      ...(revisions ? { revisions: revisions as never } : {}),
      ...(unsupported ? { unsupported: unsupported as never } : {}),
    };
  }
  const mapStyles = getFlags(flags, "map-style");
  if (mapStyles.length > 0) {
    cli.styleMappings = {};
    for (const pair of mapStyles) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        fail(opts, 1, ERROR_CODES.VALIDATION, `Invalid --map-style "${pair}": expected <style>=<target>.`, {});
      }
      cli.styleMappings[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  let overrideFile: PolicyLayerInput | undefined;
  const overridesPath = getFlag(flags, "overrides");
  if (overridesPath) {
    let parsed: unknown;
    try {
      const text = readFileSync(overridesPath, "utf8");
      parsed = overridesPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text, { uniqueKeys: true });
    } catch (err) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Cannot read override file: ${(err as Error).message}`, {
        file: overridesPath,
      });
    }
    const obj = parsed as { schema?: string; styleMappings?: Record<string, string>; options?: Record<string, string> };
    if (obj?.schema !== "atlcli.docx-import-overrides/1") {
      fail(
        opts,
        1,
        ERROR_CODES.VALIDATION,
        `Override file must declare schema: atlcli.docx-import-overrides/1 (got ${JSON.stringify(obj?.schema)}).`,
        { file: overridesPath },
      );
    }
    overrideFile = { styleMappings: obj.styleMappings, options: obj.options as never };
  }

  const { policy, errors } = resolveImportPolicy({ recipe: recipeLayer, cli, overrideFile });
  if (errors.length > 0) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Invalid import policy:\n  ${errors.join("\n  ")}`, { errors });
  }
  return policy;
}

/** Enforce options.unsupported=fail at confirm time (plan 007 options). */
function enforceUnsupportedPolicy(
  doc: ImportedDocument,
  policy: ResolvedImportPolicy,
  opts: OutputOptions,
): void {
  if (policy.options.unsupported !== "fail") return;
  const blocking = doc.issues.filter((i) => i.severity === "warning" && i.outcome === "reported");
  if (blocking.length > 0) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `Policy unsupported=fail: ${blocking.length} construct(s) would be lost:\n  ${blocking
        .map((i) => `${i.code}: ${i.message}`)
        .join("\n  ")}`,
      { issues: blocking.map((i) => i.code) },
    );
  }
}

export async function handleWikiImport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  if (args[0] === "recipe") {
    if (args[1] === "export") {
      await handleRecipeExport(flags, opts);
      return;
    }
    await handleRecipeCommand(args.slice(1), flags, opts);
    return;
  }

  if (hasFlag(flags, "help")) {
    output(importHelp(), opts);
    return;
  }
  if (hasFlag(flags, "confirm") && hasFlag(flags, "dry-run")) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--confirm and --dry-run are mutually exclusive.", {});
  }

  const requestedFormat = getFlag(flags, "format");
  if (hasFlag(flags, "format") && requestedFormat === undefined) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--format requires docx or pdf.", {});
  }
  if (requestedFormat && requestedFormat !== "docx" && requestedFormat !== "pdf") {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--format must be docx or pdf.", {});
  }
  const candidateName = getFlag(flags, "attachment") ?? args[0];
  const inferredFormat = candidateName?.toLowerCase().endsWith(".pdf")
    ? "pdf"
    : candidateName?.toLowerCase().endsWith(".docx")
      ? "docx"
      : undefined;
  const format = requestedFormat ?? inferredFormat;
  if (format === "pdf") {
    const { handlePdfWikiImport } = await import("./wiki-import-pdf.js");
    await handlePdfWikiImport(args, flags, opts);
    return;
  }
  rejectPdfOnlyFlagsForDocx(flags, opts);

  const manifestPath = getFlag(flags, "manifest");
  if (manifestPath) {
    await handleManifestBatch(manifestPath, flags, opts);
    return;
  }

  const [file] = args;
  const fromPage = getFlag(flags, "from-page");
  const attachmentName = getFlag(flags, "attachment");

  if (hasFlag(flags, "help") || (!file && !fromPage)) {
    output(importHelp(), opts);
    return;
  }
  if (file && fromPage) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Give either a local file OR --from-page, not both.", {});
  }
  if (fromPage && !attachmentName) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--from-page requires --attachment <filename>.", {});
  }

  // Batch mode: a directory, or several files (specs/import-docx/010 slice).
  if (!fromPage && file !== "-") {
    const batchFiles = resolveBatchFiles(args, opts);
    if (batchFiles) {
      await handleBatchImport(batchFiles, flags, opts);
      return;
    }
  }

  const sourceName = file ?? attachmentName!;
  if (!sourceName.toLowerCase().endsWith(".docx") && requestedFormat !== "docx") {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Import supports .docx or .pdf; use --format for stdin or an extensionless input.", { file: sourceName });
  }

  const confirm = hasFlag(flags, "confirm");
  const spaceFlag = getFlag(flags, "space");
  const updatePageId = getFlag(flags, "update-page");
  if (updatePageId && (getFlag(flags, "split") || getFlag(flags, "parent"))) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--update-page cannot be combined with --split or --parent.", {});
  }

  // The preview of a local file is a purely local projection: no config,
  // profile, or network access unless the run publishes, needs the profile's
  // default space, or downloads its source from Confluence.
  let profile: Awaited<ReturnType<typeof getActiveProfile>> | undefined;
  if (confirm || !spaceFlag || fromPage || updatePageId) {
    const config = await loadConfig();
    const profileName = getFlag(flags, "profile");
    profile = getActiveProfile(config, profileName);
    if (!profile) {
      fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {
        profile: profileName,
      });
    }
    assertCliAuthSupported(profile, opts);
    if ((confirm || fromPage || updatePageId) && resolveDeploymentType(profile) !== "cloud") {
      // Data Center path (contract-tested, not project-live-certified,
      // MVP §2.1): single-page Storage publication via REST v1. Features
      // that depend on Cloud v2 contracts stay Cloud-only and fail closed.
      const dcBlockers: string[] = [];
      if (updatePageId) dcBlockers.push("--update-page (baseline properties use REST v2)");
      if (getFlag(flags, "split")) dcBlockers.push("--split (tree publication uses REST v2)");
      if (getFlag(flags, "restriction")) dcBlockers.push("--restriction (Cloud restriction contract)");
      if (getFlag(flags, "staging-parent")) dcBlockers.push("--staging-parent");
      if (getFlags(flags, "content-property").length > 0) dcBlockers.push("--content-property (v2)");
      if (dcBlockers.length > 0) {
        fail(
          opts,
          1,
          ERROR_CODES.VALIDATION,
          `Data Center import supports single pages only; unsupported here: ${dcBlockers.join(", ")}.`,
          { profile: profile.name },
        );
      }
    }
  }

  // Acquire source bytes. The parser stays byte-oriented; the imperative
  // shell owns file/network acquisition (plan 004 source adapter).
  let bytes: Uint8Array;
  let source: { kind: "file"; path: string } | { kind: "attachment"; pageId: string; attachmentId: string; version: number };
  if (fromPage) {
    const sourceClient = new ConfluenceClient(profile!);
    const attachments = await sourceClient.listAttachments(fromPage);
    const attachment = attachments.find((a) => a.filename === attachmentName);
    if (!attachment) {
      fail(
        opts,
        1,
        ERROR_CODES.API,
        `Attachment "${attachmentName}" not found on page ${fromPage}.`,
        { pageId: fromPage, available: attachments.map((a) => a.filename).slice(0, 20) },
      );
    }
    bytes = await sourceClient.downloadAttachment(attachment);
    source = {
      kind: "attachment",
      pageId: fromPage,
      attachmentId: attachment.id,
      version: attachment.version,
    };
  } else if (file === "-") {
    bytes = new Uint8Array(readFileSync(0));
    source = { kind: "file", path: "-" };
  } else {
    try {
      bytes = new Uint8Array(readFileSync(file!));
    } catch (err) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Cannot read file: ${(err as Error).message}`, { file });
    }
    source = { kind: "file", path: file! };
  }

  const recipe = await loadRecipeLayer(flags, opts);
  const policy = resolvePolicyFromFlags(flags, opts, recipe.layer);
  let doc: ImportedDocument;
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Format mismatch: selected DOCX input does not have an OOXML ZIP byte signature.", {});
  }
  try {
    doc = parseDocx(bytes, {
      styleMappings: policy.styleMappings,
      revisions: policy.options.revisions,
    });
  } catch (err) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Rejected DOCX package: ${(err as Error).message}`, {
      file: sourceName,
    });
  }

  if (updatePageId) {
    await handleUpdateImport(updatePageId, doc, bytes, source, flags, opts, profile!, confirm, policy);
    return;
  }

  const spaceKey = spaceFlag ?? profile?.space;
  if (!spaceKey) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "No space given. Use --space <KEY> or set a profile space.", {});
  }
  let title = getFlag(flags, "title") ?? doc.titleCandidate ?? basename(sourceName, ".docx");
  const parentId = getFlag(flags, "parent");

  // Optional page-tree split (specs/import-docx/009, full form): heading
  // levels 1..6 open pages; in-tree title conflicts fail or rename per
  // --title-conflict; split issues join the document issues.
  const splitFlag = getFlag(flags, "split");
  const titleConflict = (getFlag(flags, "title-conflict") ?? "fail") as "fail" | "rename";
  if (titleConflict !== "fail" && titleConflict !== "rename") {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--title-conflict must be fail or rename.", {});
  }
  let split: SplitResult | undefined;
  if (splitFlag !== undefined) {
    const level = Number(splitFlag);
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      fail(opts, 1, ERROR_CODES.VALIDATION, "--split must be 1..6 (heading levels that open new pages).", {});
    }
    try {
      split = splitDocument(doc, { level: level as 1 | 2 | 3 | 4 | 5 | 6, rootTitle: title }, titleConflict);
      doc.issues.push(...split.issues);
    } catch (err) {
      if (err instanceof SplitTitleConflictError) {
        fail(opts, 1, ERROR_CODES.VALIDATION, err.message, { duplicates: err.duplicates });
      }
      throw err;
    }
  }
  const tree = split?.root;

  // Destination governance (plan 005 slice): validated fully offline; the
  // policy is proven against the target only at publish time.
  const { governance, errors: governanceErrors } = buildGovernance({
    restriction: getFlag(flags, "restriction"),
    viewers: getFlags(flags, "viewer"),
    editors: getFlags(flags, "editor"),
    labels: getFlags(flags, "label"),
    contentProperties: getFlags(flags, "content-property"),
    stagingParentTitle: getFlag(flags, "staging-parent"),
  });
  if (governanceErrors.length > 0) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Invalid destination governance:\n  ${governanceErrors.join("\n  ")}`, {
      errors: governanceErrors,
    });
  }

  const preview = await buildImportPreview(doc, { spaceKey, title, parentId });

  if (!confirm) {
    if (opts.json) {
      output(
        {
          mode: "preview",
          source,
          ...(recipe.info ? { recipe: recipe.info } : {}),
          policy,
          governance,
          ...(tree ? { tree: treeSummary(tree) } : {}),
          preview,
        },
        opts,
      );
    } else {
      output(renderImportPreview(preview), opts);
      if (doc.comments.length > 0) {
        const anchored = doc.comments.filter((c) => c.anchorText).length;
        const replies = doc.comments.reduce((sum, c) => sum + c.replies.length, 0);
        output("", opts);
        output(
          `Comments: ${doc.comments.length} thread(s) (${anchored} anchored, ${replies} repl${replies === 1 ? "y" : "ies"}) — mode ${policy.options.comments}`,
          opts,
        );
      }
      const policyLines = renderPolicySummary(policy);
      if (recipe.info) {
        output("", opts);
        output(
          `Recipe: ${recipe.info.id}@${recipe.info.version} [${recipe.info.source}] (sha256:${recipe.info.digest.slice(0, 16)}…)`,
          opts,
        );
      }
      if (policyLines.length > 0) {
        output("", opts);
        output("Policy:", opts);
        for (const line of policyLines) output(`  ${line}`, opts);
      }
      if (governanceHasEffects(governance)) {
        output("", opts);
        output("Governance:", opts);
        for (const line of renderGovernanceSummary(governance)) output(`  ${line}`, opts);
      }
      if (tree) {
        output(`\nPage tree (--split ${splitFlag}, ${countPages(tree)} pages):`, opts);
        output(renderTree(tree, 0), opts);
        if (governance.restriction.mode !== "inherit") {
          output("  (view restrictions on the root cascade to its children in Confluence Cloud)", opts);
        }
      }
      output("\nDry preview only — nothing was published. Re-run with --confirm to create the page.", opts);
    }
    return;
  }

  enforceUnsupportedPolicy(doc, policy, opts);

  const client = new ConfluenceClient(profile!);

  if (resolveDeploymentType(profile!) !== "cloud") {
    // Data Center publication: REST v1 Storage, attachment references by
    // filename, labels via v1. No baseline (v2 property) — reported.
    if (doc.comments.length > 0 && policy.options.comments !== "skip") {
      doc.issues.push({
        code: "docx-import/comments-unsupported-on-dc",
        severity: "warning",
        outcome: "reported",
        message: "Word comments are not imported on Data Center (Cloud v2 comment contract).",
        context: { occurrences: doc.comments.length },
      });
      enforceUnsupportedPolicy(doc, policy, opts);
    }
    const matches = await client.findPagesByTitle(title, { spaceKey });
    if (matches.length > 0) {
      if (titleConflict === "rename") {
        title = await findFreeTitle(client, spaceKey, title);
        output(`Title exists — renamed to "${title}".`, opts);
      } else {
        fail(opts, 1, ERROR_CODES.VALIDATION, `Title "${title}" already exists in ${spaceKey}.`, {});
      }
    }
    const dcCreated: string[] = [];
    let dcResult: PublishedPageReport;
    try {
      dcResult = await publishOnePageDc(client, spaceKey, title, parentId, doc, governance.labels, dcCreated);
    } catch (err) {
      const rollback = await rollbackOwnedPages(client, dcCreated);
      if (rollback.failed.length > 0) {
        fail(opts, 1, ERROR_CODES.API, `DC publication failed AND rollback failed for page ${rollback.failed[0]}: ${(err as Error).message}`, { pageId: rollback.failed[0] });
      }
      fail(opts, 1, ERROR_CODES.API, `DC publication could not be verified; the page was rolled back: ${(err as Error).message}`, {});
    }
    if (opts.json) {
      output(
        {
          mode: "published",
          deployment: "data-center",
          source,
          page: dcResult,
          adfDigest: preview.adfDigest,
          attachments: preview.assets,
          issues: doc.issues,
        },
        opts,
      );
    } else {
      output(`Created page "${dcResult.title}" (${dcResult.id}) [data-center]`, opts);
      if (dcResult.url) output(dcResult.url, opts);
    }
    return;
  }

  const spacePage = await client.listSpacesV2({ keys: [spaceKey], limit: 1 });
  const space = spacePage.spaces.find((s) => s.key === spaceKey);
  if (!space) {
    fail(opts, 1, ERROR_CODES.API, `Space ${spaceKey} not found or not accessible.`, {
      spaceKey,
    });
  }

  // Title preflight (§2.12): every page title this run would create must be
  // free in the target space BEFORE the first write.
  const plannedTitles: string[] = [];
  if (governance.staging.mode === "private-parent") plannedTitles.push(governance.staging.title);
  if (tree) collectTreeTitles(tree, plannedTitles);
  else plannedTitles.push(title);
  const conflicts: string[] = [];
  for (const planned of plannedTitles) {
    const matches = await client.findPagesByTitle(planned, { spaceKey });
    if (matches.length > 0) conflicts.push(planned);
  }
  if (conflicts.length > 0 && titleConflict === "rename") {
    // Rename conflicting plan titles to a free " (n)" variant (plan 009).
    for (const conflicting of conflicts) {
      const freeTitle = await findFreeTitle(client, spaceKey, conflicting);
      if (tree) renameInTree(tree, conflicting, freeTitle);
      if (title === conflicting) title = freeTitle;
      output(`Title "${conflicting}" exists — renamed to "${freeTitle}".`, opts);
    }
    conflicts.length = 0;
  }
  if (conflicts.length > 0) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `These titles already exist in ${spaceKey}: ${conflicts.join(", ")}. ` +
        `Use --title, rename the headings, use --title-conflict rename, or remove the existing pages.`,
      { conflicts },
    );
  }

  // Publication transaction. Every created page id is tracked; any failure
  // rolls back ALL pages created by this run (children before parents).
  const needsRestriction = governance.restriction.mode !== "inherit";
  const needsStaging = governance.staging.mode === "private-parent";
  const importer = needsRestriction || needsStaging ? await client.getCurrentUser() : undefined;

  const createdPageIds: string[] = [];
  let rootResult: PublishedPageReport;
  let stagingParentId: string | undefined;
  try {
    let effectiveParent = parentId;
    if (governance.staging.mode === "private-parent") {
      // Staging parent: empty, restricted to the importer, marker property —
      // proven BEFORE any imported content exists below it.
      const parent = await publishOnePage(
        client,
        space.id,
        governance.staging.title,
        parentId,
        [],
        [],
        createdPageIds,
        {
          forceShell: true,
          afterShell: async (id) => {
            await applyRestriction(
              client,
              id,
              { ...governance, restriction: { mode: "private" } },
              importer!.accountId,
            );
            await client.createPageProperty(id, "atlcli.import.staging", true);
            const marker = await client.getPagePropertyByKey(id, "atlcli.import.staging");
            if (marker !== true) throw new Error(`staging marker readback failed on page ${id}`);
          },
        },
      );
      stagingParentId = parent.id;
      effectiveParent = parent.id;
    }

    // Restriction-first on the root page: the shell is restricted and read
    // back before any sensitive body or attachment lands (plan 005 task 0).
    const rootOptions = needsRestriction
      ? {
          forceShell: true,
          afterShell: (id: string) => applyRestriction(client, id, governance, importer!.accountId),
        }
      : undefined;

    if (split) {
      rootResult = await publishTree(client, space.id, split, effectiveParent, createdPageIds, rootOptions, {
        doc,
        mode: policy.options.comments,
      });
    } else {
      // Single pages seal a plan-006 baseline so they can be updated in
      // place later. Trees stay baseline-free (tree update is a later plan).
      const sourceSha256 = await sha256Hex(bytes);
      rootResult = await publishOnePage(
        client,
        space.id,
        title,
        effectiveParent,
        doc.blocks,
        doc.assets,
        createdPageIds,
        {
          ...rootOptions,
          baseline: { sourceSha256, importPlanDigest: preview.adfDigest },
          comments: { list: doc.comments, mode: policy.options.comments, issues: doc.issues },
        },
      );
    }

    // Labels/properties are required outcomes (invariant 7): a failure here
    // throws and rolls the whole run back.
    await applyMetadata(client, rootResult.id, governance);
  } catch (err) {
    const rollback = await rollbackOwnedPages(client, createdPageIds);
    const failedRollbacks = rollback.failed;
    if (failedRollbacks.length > 0) {
      fail(
        opts,
        1,
        ERROR_CODES.API,
        `Publication failed AND rollback failed for page(s) ${failedRollbacks.join(", ")} — manual cleanup needed: ${(err as Error).message}`,
        { pageIds: failedRollbacks },
      );
    }
    fail(
      opts,
      1,
      ERROR_CODES.API,
      `Publication could not be completed/verified; all ${createdPageIds.length} created page(s) were rolled back: ${(err as Error).message}`,
      {},
    );
  }

  if (opts.json) {
    output(
      {
        mode: "published",
        source,
        ...(recipe.info ? { recipe: recipe.info } : {}),
        ...(governanceHasEffects(governance) ? { governance } : {}),
        ...(stagingParentId ? { stagingParentId } : {}),
        page: rootResult,
        pagesCreated: createdPageIds.length,
        adfDigest: preview.adfDigest,
        attachments: preview.assets,
        issues: doc.issues,
      },
      opts,
    );
  } else {
    output(`Created ${createdPageIds.length} page(s), root "${rootResult.title}" (${rootResult.id})`, opts);
    if (rootResult.url) output(rootResult.url, opts);
    if (doc.issues.length > 0) {
      output(`${doc.issues.length} issue(s) — run without --confirm to review them in the preview.`, opts);
    }
  }
}

/**
 * `wiki import recipe export` (plan 007): distill the CURRENT resolved
 * policy (CLI flags + optional --overrides file) into a reusable recipe
 * file. Only non-default decisions are exported; there are no
 * source-digest-bound node overrides in the slice, so nothing document-
 * specific can leak. The written file is re-parsed as a self-test and
 * written atomically (tmp + rename).
 */
async function handleRecipeExport(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Usage: wiki import recipe export --id <id> [--version v] [--title t] [--output file] [policy flags]", {});
  }
  const version = getFlag(flags, "version") ?? "1.0";
  const title = getFlag(flags, "title") ?? id;
  const outputPath = getFlag(flags, "output") ?? join(".atlcli", "import-recipes", `${id}.yaml`);

  const policy = resolvePolicyFromFlags(flags, opts);
  const options: Record<string, string> = {};
  for (const key of ["revisions", "unsupported"] as const) {
    if (policy.provenance[`options.${key}`] !== "default") options[key] = policy.options[key];
  }
  const recipe = {
    schema: "atlcli.docx-import-recipe/1",
    id,
    version,
    title,
    targets: ["cloud"],
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(Object.keys(policy.styleMappings).length > 0
      ? { overrides: { styleMappings: policy.styleMappings } }
      : {}),
  };
  const yamlText = stringifyYaml(recipe);

  // Self-test: what we wrote must round-trip through the hardened parser.
  const check = await parseRecipe(yamlText);
  if (!check.parsed) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Exported recipe failed validation:\n  ${check.errors.join("\n  ")}`, {
      errors: check.errors,
    });
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, yamlText, "utf8");
  renameSync(tmpPath, outputPath);

  if (opts.json) {
    output({ file: outputPath, id, version, digest: check.parsed.digest }, opts);
  } else {
    output(`Exported ${id}@${version} to ${outputPath} (sha256:${check.parsed.digest.slice(0, 16)}…)`, opts);
  }
}

/**
 * Detect batch input: a directory (all *.docx directly inside, sorted) or
 * more than one positional file. A single regular file returns undefined —
 * the single-import path owns it.
 */
export interface BatchSource {
  /** Display name for reports (path or zip-entry path). */
  display: string;
  read: () => Uint8Array;
}

function resolveBatchFiles(args: string[], opts: OutputOptions): BatchSource[] | undefined {
  if (args.length === 1) {
    // Safe outer ZIP as a batch source (plan 010): sorted .docx entries.
    if (args[0].toLowerCase().endsWith(".zip")) {
      let entries;
      try {
        entries = extractDocxEntriesFromZip(new Uint8Array(readFileSync(args[0])));
      } catch (err) {
        fail(opts, 1, ERROR_CODES.VALIDATION, `Batch ZIP rejected: ${(err as Error).message}`, {});
      }
      return entries.map((entry) => ({
        display: `${args[0]}!${entry.path}`,
        read: () => entry.bytes,
      }));
    }
    let stat;
    try {
      stat = statSync(args[0]);
    } catch {
      return undefined; // Missing path — let the single path report it.
    }
    if (!stat.isDirectory()) return undefined;
    const files = readdirSync(args[0])
      .filter((name) => name.toLowerCase().endsWith(".docx") && !name.startsWith("~$"))
      .sort()
      .map((name) => join(args[0], name));
    if (files.length === 0) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `No .docx files found in ${args[0]}.`, {});
    }
    return files.map((file) => ({ display: file, read: () => new Uint8Array(readFileSync(file)) }));
  }
  for (const arg of args) {
    if (!arg.toLowerCase().endsWith(".docx")) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Batch input must be .docx files; got ${arg}.`, {});
    }
  }
  return args.map((file) => ({ display: file, read: () => new Uint8Array(readFileSync(file)) }));
}

interface BatchItemPlan {
  file: string;
  doc?: ImportedDocument;
  title?: string;
  split?: SplitResult;
  parseError?: string;
}

interface BatchItemResult {
  file: string;
  title?: string;
  status: "created" | "skipped" | "failed";
  pages?: number;
  rootPageId?: string;
  url?: string;
  error?: string;
}

/**
 * Batch import (plan 010 slice): each file is an independently auditable
 * transaction — a failure rolls back only that file's pages, records the
 * error, and the batch continues. `--skip-existing` turns space-level title
 * conflicts into skips, which makes an interrupted batch safely re-runnable
 * without duplicating verified content.
 */
async function handleBatchImport(
  files: BatchSource[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  if (getFlag(flags, "title")) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--title cannot be used in batch mode (titles come from each document).", {});
  }
  const confirm = hasFlag(flags, "confirm");
  const skipExisting = hasFlag(flags, "skip-existing");
  const splitFlag = getFlag(flags, "split");
  const splitLevel = splitFlag !== undefined ? Number(splitFlag) : undefined;
  if (splitLevel !== undefined && (!Number.isInteger(splitLevel) || splitLevel < 1 || splitLevel > 6)) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--split must be 1..6 (heading levels that open new pages).", {});
  }

  const spaceFlag = getFlag(flags, "space");
  let profile: Awaited<ReturnType<typeof getActiveProfile>> | undefined;
  if (confirm || !spaceFlag) {
    const config = await loadConfig();
    profile = getActiveProfile(config, getFlag(flags, "profile"));
    if (!profile) {
      fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {});
    }
    assertCliAuthSupported(profile, opts);
    if (confirm && resolveDeploymentType(profile) !== "cloud") {
      fail(opts, 1, ERROR_CODES.VALIDATION, "wiki import currently supports Confluence Cloud profiles only.", {});
    }
  }
  const spaceKey = spaceFlag ?? profile?.space;
  if (!spaceKey) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "No space given. Use --space <KEY> or set a profile space.", {});
  }
  const parentId = getFlag(flags, "parent");

  // Plan every file up front — the whole batch is reviewed before any write.
  const recipe = await loadRecipeLayer(flags, opts);
  const policy = resolvePolicyFromFlags(flags, opts, recipe.layer);
  const parsePolicy = {
    styleMappings: policy.styleMappings,
    revisions: policy.options.revisions,
  };
  const plans: BatchItemPlan[] = [];
  for (const source of files) {
    const file = source.display;
    try {
      const doc = parseDocx(source.read(), parsePolicy);
      const title = doc.titleCandidate ?? basename(file, ".docx");
      const split =
        splitLevel !== undefined
          ? splitDocument(doc, { level: splitLevel as 1 | 2 | 3 | 4 | 5 | 6, rootTitle: title })
          : undefined;
      if (split) doc.issues.push(...split.issues);
      plans.push({ file, doc, title, split });
    } catch (err) {
      plans.push({ file, parseError: (err as Error).message });
    }
  }

  // In-batch title conflicts fail closed before preview or publish.
  const titleOwners = new Map<string, string>();
  const inBatchConflicts: string[] = [];
  for (const plan of plans) {
    if (!plan.title) continue;
    const titles: string[] = [];
    if (plan.split) collectTreeTitles(plan.split.root, titles);
    else titles.push(plan.title);
    for (const t of titles) {
      const key = t.toLowerCase();
      const owner = titleOwners.get(key);
      if (owner && owner !== plan.file) inBatchConflicts.push(`"${t}" (${owner} vs ${plan.file})`);
      titleOwners.set(key, plan.file);
    }
  }
  if (inBatchConflicts.length > 0) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `Multiple batch files would create the same title: ${inBatchConflicts.join("; ")}. Rename the documents/headings.`,
      {},
    );
  }

  if (!confirm) {
    const items = plans.map((plan) =>
      plan.parseError
        ? { file: plan.file, error: plan.parseError }
        : {
            file: plan.file,
            title: plan.title,
            pages: plan.split ? countPages(plan.split.root) : 1,
            blocks: plan.doc!.blocks.length,
            attachments: plan.doc!.assets.length,
            issues: plan.doc!.issues.length,
            editability: assessEditability(plan.doc!.blocks).level,
          },
    );
    if (opts.json) {
      output({ mode: "batch-preview", spaceKey, parentId, items }, opts);
    } else {
      output(`Batch preview — ${files.length} file(s) → space ${spaceKey}:`, opts);
      for (const item of items) {
        if ("error" in item && item.error) {
          output(`  ✗ ${item.file}: REJECTED — ${item.error}`, opts);
        } else if ("title" in item) {
          const editability = item.editability !== "ok" ? ` [editability: ${String(item.editability).toUpperCase()}]` : "";
          output(
            `  • ${item.file} → "${item.title}" (${item.pages} page(s), ${item.blocks} blocks, ${item.attachments} attachment(s), ${item.issues} issue(s))${editability}`,
            opts,
          );
        }
      }
      output("\nDry preview only — nothing was published. Re-run with --confirm to import the batch.", opts);
    }
    return;
  }

  const client = new ConfluenceClient(profile!);
  const spacePage = await client.listSpacesV2({ keys: [spaceKey], limit: 1 });
  const space = spacePage.spaces.find((s) => s.key === spaceKey);
  if (!space) {
    fail(opts, 1, ERROR_CODES.API, `Space ${spaceKey} not found or not accessible.`, { spaceKey });
  }

  const results: BatchItemResult[] = [];
  for (const plan of plans) {
    if (plan.parseError || !plan.doc || !plan.title) {
      results.push({ file: plan.file, status: "failed", error: plan.parseError ?? "unparsed" });
      continue;
    }
    if (policy.options.unsupported === "fail") {
      const blocking = plan.doc.issues.filter((i) => i.severity === "warning" && i.outcome === "reported");
      if (blocking.length > 0) {
        results.push({
          file: plan.file,
          title: plan.title,
          status: "failed",
          error: `policy unsupported=fail: ${blocking.map((i) => i.code).join(", ")}`,
        });
        continue;
      }
    }
    const titles: string[] = [];
    if (plan.split) collectTreeTitles(plan.split.root, titles);
    else titles.push(plan.title);

    let conflict: string | undefined;
    for (const t of titles) {
      const matches = await client.findPagesByTitle(t, { spaceKey });
      if (matches.length > 0) {
        conflict = t;
        break;
      }
    }
    if (conflict) {
      results.push(
        skipExisting
          ? { file: plan.file, title: plan.title, status: "skipped", error: `title "${conflict}" already exists` }
          : { file: plan.file, title: plan.title, status: "failed", error: `title "${conflict}" already exists (use --skip-existing to resume past it)` },
      );
      continue;
    }

    const createdPageIds: string[] = [];
    try {
      const root = plan.split
        ? await publishTree(client, space.id, plan.split, parentId, createdPageIds, undefined, {
            doc: plan.doc,
            mode: policy.options.comments,
          })
        : await publishOnePage(client, space.id, plan.title, parentId, plan.doc.blocks, plan.doc.assets, createdPageIds, {
            comments: { list: plan.doc.comments, mode: policy.options.comments, issues: plan.doc.issues },
          });
      results.push({
        file: plan.file,
        title: plan.title,
        status: "created",
        pages: createdPageIds.length,
        rootPageId: root.id,
        url: root.url,
      });
    } catch (err) {
      await rollbackOwnedPages(client, createdPageIds);
      results.push({ file: plan.file, title: plan.title, status: "failed", error: (err as Error).message });
    }
  }

  const created = results.filter((r) => r.status === "created");
  const skipped = results.filter((r) => r.status === "skipped");
  const failed = results.filter((r) => r.status === "failed");

  if (opts.json) {
    output(
      {
        mode: "batch-published",
        spaceKey,
        summary: { created: created.length, skipped: skipped.length, failed: failed.length },
        results,
      },
      opts,
    );
  } else {
    for (const r of results) {
      const mark = r.status === "created" ? "✓" : r.status === "skipped" ? "→" : "✗";
      output(`  ${mark} ${r.file}: ${r.status}${r.pages ? ` (${r.pages} page(s))` : ""}${r.error ? ` — ${r.error}` : ""}`, opts);
    }
    output(`\nBatch done: ${created.length} created, ${skipped.length} skipped, ${failed.length} failed.`, opts);
  }
  if (failed.length > 0) {
    process.exit(1);
  }
}

/**
 * In-place reimport into one existing page (plan 006 slice).
 *
 * Safety model: page identity/URL/history are preserved (a v2 body PUT, no
 * delete/recreate); `--expect-version` is a mandatory lost-update guard at
 * confirm time; on failed verification the previous body is restored as a
 * new version. Unrelated attachments are untouched; same-name attachments
 * are updated in place. Inline comments anchored to changed text may lose
 * their anchors — surfaced as a warning, never silently.
 */
export async function handleUpdateImport(
  pageId: string,
  doc: ImportedDocument,
  sourceBytes: Uint8Array,
  source: unknown,
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  profile: NonNullable<Awaited<ReturnType<typeof getActiveProfile>>>,
  confirm: boolean,
  policy: ResolvedImportPolicy,
  clientOverride?: ConfluenceClient,
): Promise<void> {
  const client = clientOverride ?? new ConfluenceClient(profile);
  const current = await client.getPage(pageId);
  const currentAdfPage = await client.getPageAdf(pageId);
  const currentAdf = JSON.parse(currentAdfPage.body.value) as { content?: AdfNode[] };

  // Update authority (plan 006 invariants 1-3): the page must carry a
  // validated import baseline, and its current body must still match the
  // baseline body digest. Divergence shows a diff and never mutates —
  // there is deliberately no force flag.
  const storedBaseline = await client.getPagePropertyByKey(pageId, BASELINE_PROPERTY_KEY);
  if (storedBaseline === undefined) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `Page ${pageId} has no AtlCLI import baseline. In-place updates are only supported for pages created by \`wiki import\` (with baseline); import as a new page instead.`,
      { pageId },
    );
  }
  const baselineCheck = await validateBaseline(storedBaseline, pageId);
  if (!baselineCheck.baseline) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Page ${pageId} baseline is invalid: ${baselineCheck.reason}.`, {
      pageId,
    });
  }
  const baseline = baselineCheck.baseline;

  const title = getFlag(flags, "title") ?? current.title;
  const newAdf = documentToAdf(doc);
  const diff = diffAdfBlocks(currentAdf.content ?? [], newAdf.content);

  const currentBodyDigest = await digestAdfValue(currentAdfPage.body.value);
  const diverged = currentBodyDigest !== baseline.bodyDigest;

  // Only FOREIGN inline comments gate the update — import-owned ones (bound
  // in the baseline) are reconciled by this very run.
  const ownedCommentIds = new Set(
    (baseline.documentCommentBindings ?? []).map((b) => b.confluenceCommentId),
  );
  const inlineComments = (await client.getInlineComments(pageId)).filter(
    (c) => !ownedCommentIds.has(c.id),
  );
  const acceptAnchorLoss = hasFlag(flags, "accept-anchor-loss");

  const summary = {
    pageId,
    title,
    currentVersion: currentAdfPage.version,
    newVersion: currentAdfPage.version + 1,
    baseline: {
      importedPageVersion: baseline.importedPageVersion,
      sourceSha256: baseline.sourceSha256,
      diverged,
    },
    inlineComments: inlineComments.length,
    diff,
    attachments: doc.assets.map((a) => a.fileName),
  };

  if (!confirm) {
    if (opts.json) {
      output({ mode: "update-preview", source, update: summary, issues: doc.issues }, opts);
    } else {
      output(`Update preview for page ${pageId} ("${current.title}")`, opts);
      output(`  Version:  ${summary.currentVersion} → ${summary.newVersion}`, opts);
      output(`  Baseline: imported at v${baseline.importedPageVersion}, source sha256:${baseline.sourceSha256.slice(0, 12)}…`, opts);
      if (diverged) {
        output(`  ⚠ TARGET DIVERGED: the page was edited since the import — a confirmed update will be BLOCKED.`, opts);
      }
      output(`  Diff:     ${renderSemanticDiffLines(diff).join("\n  ")}`, opts);
      if (summary.attachments.length > 0) {
        output(`  Attachments to reconcile: ${summary.attachments.join(", ")}`, opts);
      }
      if (inlineComments.length > 0) {
        output(
          `  ⚠ ${inlineComments.length} inline comment(s) on this page — anchors to changed text cannot be preserved; a confirmed update requires --accept-anchor-loss.`,
          opts,
        );
      }
      output(`\nDry preview only — re-run with --confirm to update the page.`, opts);
    }
    return;
  }

  if (diverged) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `target-diverged: page ${pageId} was edited since the import (baseline v${baseline.importedPageVersion}); its current body no longer matches the import baseline. There is no force override — reconcile manually or import as a new page.\nDiff (current vs. new plan):\n  ${renderSemanticDiffLines(diff).join("\n  ")}`,
      { pageId, code: "target-diverged" },
    );
  }
  if (inlineComments.length > 0 && !acceptAnchorLoss) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `Page ${pageId} carries ${inlineComments.length} inline comment(s) whose anchors cannot be proven to survive a body replace. Re-run with --accept-anchor-loss to proceed anyway (comments stay, anchors may detach).`,
      { pageId, inlineComments: inlineComments.length },
    );
  }
  // Optional extra guard on top of the digest check.
  const expectFlag = getFlag(flags, "expect-version");
  if (expectFlag !== undefined && Number(expectFlag) !== currentAdfPage.version) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `Page ${pageId} is at version ${currentAdfPage.version}, not ${expectFlag}.`,
      { currentVersion: currentAdfPage.version },
    );
  }

  // Asset reconciliation (invariants 6/7): unchanged assets (same sha256 as
  // the baseline binding) skip the upload; new/changed ones upload under
  // their import-owned filename; superseded import-owned attachments are
  // deleted only AFTER the new body verifies.
  const bindingBySourceId = new Map(baseline.assetBindings.map((b) => [b.sourceAssetId, b]));
  const assetShas = new Map<string, string>();
  for (const asset of doc.assets) assetShas.set(asset.id, await sha256Hex(asset.bytes));
  let finalAdf = newAdf;
  if (doc.assets.length > 0) {
    for (const asset of doc.assets) {
      const binding = bindingBySourceId.get(asset.id);
      if (binding && binding.sha256 === assetShas.get(asset.id)) continue; // unchanged
      await client.uploadAttachment({
        pageId,
        filename: asset.fileName,
        data: asset.bytes,
        mimeType: asset.mediaType,
      });
    }
    const mediaList = await client.listPageAttachmentMedia(pageId);
    const fileIdByName = new Map(mediaList.attachments.map((a) => [a.filename, a.fileId]));
    const media = new Map<string, AdfMediaResolution>();
    for (const asset of doc.assets) {
      const fileId = fileIdByName.get(asset.fileName);
      if (!fileId) throw new Error(`attachment ${asset.fileName} has no resolvable media fileId`);
      media.set(asset.id, { fileId, collection: `contentId-${pageId}` });
    }
    finalAdf = documentToAdf(doc, { media });
  }

  const updated = await client.updatePageAdf({
    id: pageId,
    title,
    adf: finalAdf,
    version: currentAdfPage.version + 1,
  });

  const orphanWarnings: string[] = [];
  try {
    const readback = await client.getPageAdf(pageId);
    await verifyAdfSemanticReadback(finalAdf, readback.body.value);

    // Comment reconciliation (plan 006 invariant 9): authoritative source
    // ids from the baseline bindings only — never text/name matching.
    const previousBindings = baseline.documentCommentBindings ?? [];
    const flattenIds = (comments: ImportComment[]): string[] =>
      comments.flatMap((c) => [c.id, ...c.replies.map((r) => r.id)]);
    const currentIds = new Set(flattenIds(doc.comments));
    const boundIds = new Set(previousBindings.map((b) => b.sourceCommentId));
    const keptBindings = previousBindings.filter((b) => currentIds.has(b.sourceCommentId));
    const orphanedBindings = previousBindings.filter((b) => !currentIds.has(b.sourceCommentId));

    // New whole threads publish normally; new replies on bound threads
    // attach to the existing Confluence comment.
    const newThreads = doc.comments.filter((c) => !boundIds.has(c.id));
    const newBindings =
      newThreads.length > 0
        ? await publishComments(client, pageId, newThreads, policy.options.comments, doc.issues)
        : [];
    const replyBindings: PublishedCommentBinding[] = [];
    for (const thread of doc.comments) {
      const parentBinding = previousBindings.find((b) => b.sourceCommentId === thread.id);
      if (!parentBinding) continue;
      for (const reply of thread.replies) {
        if (boundIds.has(reply.id)) continue;
        const created =
          parentBinding.location === "inline"
            ? await client.createInlineComment({
                pageId,
                body: commentStorageBody(reply),
                textSelection: "",
                parentCommentId: parentBinding.confluenceCommentId,
              })
            : await client.createFooterComment({
                pageId,
                body: commentStorageBody(reply),
                parentCommentId: parentBinding.confluenceCommentId,
              });
        replyBindings.push({
          sourceCommentId: reply.id,
          confluenceCommentId: created.id,
          location: parentBinding.location,
        });
      }
    }

    // Seal the successor baseline before any destructive cleanup.
    const assetBindings = doc.assets.map((a) => ({
      sourceAssetId: a.id,
      remoteFilename: a.fileName,
      sha256: assetShas.get(a.id)!,
    }));
    const nextBaseline = await buildBaseline({
      pageId,
      sourceSha256: await sha256Hex(sourceBytes),
      importPlanDigest: await digestAdfValue(JSON.stringify(newAdf)),
      bodyDigest: await digestAdfValue(readback.body.value),
      importedPageVersion: readback.version,
      assetBindings,
      documentCommentBindings: [...keptBindings, ...newBindings, ...replyBindings],
    });
    await client.upsertPageProperty(pageId, BASELINE_PROPERTY_KEY, nextBaseline);

    // Retire import-owned comments whose source comment disappeared —
    // AFTER the successor baseline is sealed; a failed delete is an orphan
    // warning, never a rollback. Native/user comments are never touched
    // (only baseline-bound ids are candidates).
    const orphanTopLevel = orphanedBindings.filter(
      (b) => !orphanedBindings.some((other) => other !== b && other.confluenceCommentId === b.confluenceCommentId),
    );
    for (const binding of orphanTopLevel) {
      try {
        await client.deleteComment(binding.confluenceCommentId, binding.location);
      } catch (err) {
        orphanWarnings.push(
          `orphaned imported comment ${binding.confluenceCommentId} (source ${binding.sourceCommentId}): ${(err as Error).message}`,
        );
      }
    }

    // Delete superseded import-owned attachments AFTER everything verified;
    // a deletion failure is an explicit orphan warning, never a rollback.
    const currentSourceIds = new Set(doc.assets.map((a) => a.id));
    const superseded = baseline.assetBindings.filter((b) => !currentSourceIds.has(b.sourceAssetId));
    if (superseded.length > 0) {
      const attachments = await client.listAttachments(pageId);
      for (const b of superseded) {
        const match = attachments.find((a) => a.filename === b.remoteFilename);
        if (!match) continue;
        try {
          await client.deleteAttachment(match.id);
        } catch (err) {
          orphanWarnings.push(`orphaned attachment ${b.remoteFilename} (${match.id}): ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    // Restore the previous body as a NEW version — history is preserved and
    // the page never stays in an unverified state.
    try {
      await client.updatePageAdf({
        id: pageId,
        title: current.title,
        adf: currentAdf,
        version: currentAdfPage.version + 2,
      });
    } catch {
      fail(
        opts,
        1,
        ERROR_CODES.API,
        `Update verification failed AND restoring the previous body failed — page ${pageId} needs manual review: ${(err as Error).message}`,
        { pageId },
      );
    }
    fail(
      opts,
      1,
      ERROR_CODES.API,
      `Update could not be verified; the previous content was restored as version ${currentAdfPage.version + 2}: ${(err as Error).message}`,
      { pageId },
    );
  }

  if (opts.json) {
    output(
      {
        mode: "updated",
        source,
        page: { id: updated.id, title: updated.title, url: updated.url, version: updated.version },
        previousVersion: currentAdfPage.version,
        diff,
        attachments: doc.assets.map((a) => a.fileName),
        ...(orphanWarnings.length > 0 ? { orphanWarnings } : {}),
        issues: doc.issues,
      },
      opts,
    );
  } else {
    output(`Updated page "${updated.title}" (${updated.id}) to version ${updated.version}`, opts);
    if (updated.url) output(updated.url, opts);
    for (const warning of orphanWarnings) output(`  ⚠ ${warning}`, opts);
  }
}

function countTypes(types: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of types) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

function formatTypeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? "empty page"
    : entries.map(([k, v]) => `${v} ${k}`).join(", ");
}

interface PublishedPageReport {
  id: string;
  title: string;
  url?: string;
  version?: number;
  children?: PublishedPageReport[];
}

/**
 * Publish one page: shell-create when assets exist (attachments need a page
 * id), upload assets, substitute media identities into the final ADF, and
 * verify the readback block sequence. Registers the created id BEFORE any
 * follow-up call so the caller's rollback always sees it.
 */
export async function publishOnePage(
  client: ConfluenceClient,
  spaceId: string,
  title: string,
  parentId: string | undefined,
  blocks: ImportedDocument["blocks"],
  assets: ImportedDocument["assets"],
  createdPageIds: string[],
  options: {
    /** Create an empty shell first even without assets (restriction-first). */
    forceShell?: boolean;
    /**
     * Runs after the shell exists and BEFORE any content/attachment lands —
     * the restriction-before-sensitive-content hook. A throw rolls back.
     */
    afterShell?: (pageId: string) => Promise<void>;
    /**
     * Seal an import baseline (plan 006) after verification: sha256 of the
     * source bytes + the plan digest. Required for later in-place updates.
     */
    baseline?: { sourceSha256: string; importPlanDigest: string };
    /** Publish imported Word comments after the body verifies (MVP §9.4). */
    comments?: {
      list: ImportComment[];
      mode: "auto" | "inline" | "footer" | "skip";
      issues: ImportedDocument["issues"];
    };
  } = {},
): Promise<PublishedPageReport> {
  const pageDoc: ImportedDocument = {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "docx",
    blocks,
    assets,
    comments: [],
    commentOwners: new Map(),
    issues: [],
  };
  const prepared = prepareConfluencePage({ title, parentId, document: pageDoc });
  if (blocks.length === 0 && assets.length === 0 && options.forceShell === true) {
    // Nothing to publish beyond the shell (e.g. a staging parent). Cloud
    // normalizes an empty doc to one empty paragraph, so there is no
    // meaningful block sequence to verify either.
    const shell = await createPreparedCloudShell(client, spaceId, prepared, (id) => createdPageIds.push(id));
    if (options.afterShell) await options.afterShell(shell.id);
    return { id: shell.id, title: shell.title, url: shell.url, version: shell.version };
  }
  const published = await publishPreparedCloudPage(client, spaceId, prepared, {
    forceShell: options.forceShell,
    afterShell: options.afterShell,
    onOwnedPage: (id) => createdPageIds.push(id),
  });
  const finalPage = published.page;
  const readbackValue = published.readbackValue;

  let commentBindings: PublishedCommentBinding[] = [];
  if (options.comments && options.comments.list.length > 0) {
    commentBindings = await publishComments(
      client,
      finalPage.id,
      options.comments.list,
      options.comments.mode,
      options.comments.issues,
    );
  }
  if (options.baseline) {
    await sealBaseline(
      client,
      finalPage.id,
      readbackValue,
      finalPage.version ?? 1,
      assets,
      options.baseline,
      commentBindings,
    );
  }
  return { id: finalPage.id, title: finalPage.title, url: finalPage.url, version: finalPage.version };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Storage body for an imported comment: attribution line + text (§2.10). */
function commentStorageBody(comment: ImportComment): string {
  const date = comment.date ? `, ${comment.date.slice(0, 10)}` : "";
  const attribution = `<p><em>Imported DOCX comment — original author: ${escapeXml(comment.author)}${date}</em></p>`;
  const body = comment.text
    .split("\n")
    .map((line) => `<p>${escapeXml(line)}</p>`)
    .join("");
  return attribution + body;
}

export interface PublishedCommentBinding {
  sourceCommentId: string;
  confluenceCommentId: string;
  location: "inline" | "footer";
}

/**
 * Publish imported Word comments onto a page (MVP §9.4, plan 006 comment
 * reconciliation source). The comment ACTOR is the authenticated importer;
 * original authorship is a visible attribution line. `auto` tries an inline
 * comment on the exact anchored text and falls back to a footer comment
 * with an issue when the anchor cannot be resolved; replies thread under
 * their parent; resolved threads are re-resolved after creation.
 */
export async function publishComments(
  client: ConfluenceClient,
  pageId: string,
  comments: ImportComment[],
  mode: "auto" | "inline" | "footer" | "skip",
  issues: ImportedDocument["issues"],
): Promise<PublishedCommentBinding[]> {
  const bindings: PublishedCommentBinding[] = [];
  if (mode === "skip") {
    if (comments.length > 0) {
      issues.push({
        code: "docx-import/comments-skipped",
        severity: "warning",
        outcome: "reported",
        message: `Comments were skipped by policy (comments=skip).`,
        context: { occurrences: comments.length },
      });
    }
    return bindings;
  }

  for (const comment of comments) {
    let location: "inline" | "footer" = "footer";
    let created: { id: string } | undefined;

    const wantInline = (mode === "auto" || mode === "inline") && !!comment.anchorText;
    if (wantInline) {
      try {
        created = await client.createInlineComment({
          pageId,
          body: commentStorageBody(comment),
          textSelection: comment.anchorText!,
        });
        location = "inline";
      } catch (err) {
        if (mode === "inline") {
          throw new Error(
            `inline comment for source comment ${comment.id} failed (anchor "${comment.anchorText}"): ${(err as Error).message}`,
          );
        }
        issues.push({
          code: "docx-import/comment-anchor-unresolved",
          severity: "info",
          outcome: "approximated",
          message: `Comment anchor could not be matched on the page; the comment was imported as a footer comment.`,
          context: { sourceCommentId: comment.id },
        });
      }
    } else if (mode === "inline" && !comment.anchorText) {
      issues.push({
        code: "docx-import/comment-anchor-missing",
        severity: "info",
        outcome: "approximated",
        message: "Comment has no anchored text range; imported as a footer comment.",
        context: { sourceCommentId: comment.id },
      });
    }
    if (!created) {
      created = await client.createFooterComment({ pageId, body: commentStorageBody(comment) });
      location = "footer";
    }
    bindings.push({ sourceCommentId: comment.id, confluenceCommentId: created.id, location });

    for (const reply of comment.replies) {
      const replyCreated =
        location === "inline"
          ? await client.createInlineComment({
              pageId,
              body: commentStorageBody(reply),
              textSelection: "",
              parentCommentId: created.id,
            })
          : await client.createFooterComment({
              pageId,
              body: commentStorageBody(reply),
              parentCommentId: created.id,
            });
      bindings.push({ sourceCommentId: reply.id, confluenceCommentId: replyCreated.id, location });
    }

    if (comment.resolved) {
      await client.resolveComment(created.id, location);
    }
  }
  return bindings;
}

/**
 * Data Center single-page publication (MVP §2.1 contract track): create a
 * v1 Storage shell, upload attachments (referenced by FILENAME in the
 * body), publish the full Storage body as version 2, verify the readback
 * structural tag sequence, and apply/verify labels. Every created id is
 * registered before follow-up calls so the caller's rollback sees it.
 */
export async function publishOnePageDc(
  client: ConfluenceClient,
  spaceKey: string,
  title: string,
  parentId: string | undefined,
  doc: ImportedDocument,
  labels: string[],
  createdPageIds: string[],
): Promise<PublishedPageReport> {
  const result = await publishPreparedDcPage(
    client,
    spaceKey,
    prepareConfluencePage({ title, parentId, document: doc }),
    { labels, onOwnedPage: (id) => createdPageIds.push(id) },
  );
  return result.page;
}

/**
 * Finalize an EXISTING shell page: upload assets, encode the final ADF with
 * media identities and (optionally) cross-page anchor links, PUT it as
 * version 2, and verify the readback.
 */
export async function finalizePageContent(
  client: ConfluenceClient,
  pageId: string,
  title: string,
  blocks: ImportedDocument["blocks"],
  assets: ImportedDocument["assets"],
  encode: { anchors?: ReadonlyMap<string, string> },
): Promise<{ page: PublishedPageReport; readbackValue: string }> {
  const pageDoc: ImportedDocument = {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "docx",
    blocks,
    assets,
    comments: [],
    commentOwners: new Map(),
    issues: [],
  };
  const references = encode.anchors
    ? new Map([...encode.anchors].map(([target, url]) => [
        importReferenceKey({ namespace: "docx-bookmark", target }),
        url,
      ]))
    : undefined;
  const result = await finalizePreparedCloudPage(
    client,
    pageId,
    prepareConfluencePage({ title, document: pageDoc }),
    { ...(references ? { references } : {}) },
  );
  return {
    page: result.page,
    readbackValue: result.readbackValue,
  };
}

/**
 * Seal the plan-006 import baseline as a page property AND read it back.
 * The body digest comes from the verified readback ADF, so a later update
 * can detect any human edit as a pure digest comparison.
 */
async function sealBaseline(
  client: ConfluenceClient,
  pageId: string,
  readbackAdfValue: string,
  pageVersion: number | undefined,
  assets: ImportedDocument["assets"],
  seed: { sourceSha256: string; importPlanDigest: string },
  commentBindings: PublishedCommentBinding[] = [],
): Promise<void> {
  const bodyDigest = await digestAdfValue(readbackAdfValue);
  const assetBindings = await Promise.all(
    assets.map(async (a) => ({
      sourceAssetId: a.id,
      remoteFilename: a.fileName,
      sha256: await sha256Hex(a.bytes),
    })),
  );
  const baseline = await buildBaseline({
    pageId,
    sourceSha256: seed.sourceSha256,
    importPlanDigest: seed.importPlanDigest,
    bodyDigest,
    importedPageVersion: pageVersion ?? 1,
    assetBindings,
    documentCommentBindings: commentBindings,
  });
  await client.upsertPageProperty(pageId, BASELINE_PROPERTY_KEY, baseline);
  const stored = await client.getPagePropertyByKey(pageId, BASELINE_PROPERTY_KEY);
  const check = await validateBaseline(stored, pageId);
  if (!check.baseline || check.baseline.provenanceDigest !== baseline.provenanceDigest) {
    throw new Error(`baseline readback failed on page ${pageId}: ${check.reason ?? "digest mismatch"}`);
  }
}

/**
 * Publish a split tree in TWO phases (plan 009 full form): first create
 * every page as an empty shell (parents before children, so ids and URLs
 * exist for the whole tree), then finalize each page's content with the
 * bookmark→page-URL map so cross-page references become real links.
 */
export async function publishTree(
  client: ConfluenceClient,
  spaceId: string,
  split: SplitResult,
  parentId: string | undefined,
  createdPageIds: string[],
  rootOptions?: Parameters<typeof publishOnePage>[7],
  commentsCtx?: {
    doc: ImportedDocument;
    mode: "auto" | "inline" | "footer" | "skip";
  },
): Promise<PublishedPageReport> {
  const shells = new Map<ImportPagePlan, { id: string; url?: string }>();

  // Comment → page assignment (plan 009 rule 8): a comment lands on the
  // page owning the top-level block where its range starts; the heading
  // that BECAME a page title maps to that page; everything else (no
  // anchor, owner block inside a nested structure) falls back to the root.
  const commentsByPage = new Map<ImportPagePlan, ImportComment[]>();
  if (commentsCtx && commentsCtx.doc.comments.length > 0) {
    const blockOwner = new Map<ImportBlock, ImportPagePlan>();
    const indexBlocks = (plan: ImportPagePlan): void => {
      if (plan.sourceHeading) blockOwner.set(plan.sourceHeading, plan);
      for (const block of plan.blocks) blockOwner.set(block, plan);
      for (const child of plan.children) indexBlocks(child);
    };
    indexBlocks(split.root);
    for (const comment of commentsCtx.doc.comments) {
      const ownerBlock = commentsCtx.doc.commentOwners.get(comment.id);
      const page = (ownerBlock ? blockOwner.get(ownerBlock) : undefined) ?? split.root;
      const list = commentsByPage.get(page) ?? [];
      list.push(comment);
      commentsByPage.set(page, list);
    }
  }

  const createShells = async (plan: ImportPagePlan, parent: string | undefined): Promise<void> => {
    const page = await createPreparedCloudShell(
      client,
      spaceId,
      prepareConfluencePage({
        title: plan.title,
        parentId: parent,
        document: {
          schema: IMPORT_DOCUMENT_SCHEMA_V2,
          sourceKind: "docx",
          blocks: plan.blocks,
          assets: plan.assets,
          issues: [],
        },
      }),
      (id) => createdPageIds.push(id),
    );
    if (plan === split.root && rootOptions?.afterShell) await rootOptions.afterShell(page.id);
    shells.set(plan, { id: page.id, url: page.url });
    for (const child of plan.children) await createShells(child, page.id);
  };
  await createShells(split.root, parentId);

  // Bookmark → absolute page URL, resolvable only now that shells exist.
  const anchors = new Map<string, string>();
  for (const [name, owner] of split.anchorOwners) {
    const shell = shells.get(owner);
    if (shell?.url) anchors.set(name, shell.url);
  }

  const finalize = async (plan: ImportPagePlan): Promise<PublishedPageReport> => {
    const shell = shells.get(plan)!;
    let page: PublishedPageReport = { id: shell.id, title: plan.title, url: shell.url };
    if (plan.blocks.length > 0 || plan.assets.length > 0) {
      const finalized = await finalizePageContent(client, shell.id, plan.title, plan.blocks, plan.assets, {
        anchors,
      });
      page = { ...finalized.page, url: finalized.page.url ?? shell.url };
    }
    const pageComments = commentsByPage.get(plan);
    if (commentsCtx && pageComments && pageComments.length > 0) {
      await publishComments(client, shell.id, pageComments, commentsCtx.mode, commentsCtx.doc.issues);
    }
    const children: PublishedPageReport[] = [];
    for (const child of plan.children) children.push(await finalize(child));
    return children.length > 0 ? { ...page, children } : page;
  };
  return finalize(split.root);
}

function collectTreeTitles(plan: ImportPagePlan, into: string[]): void {
  into.push(plan.title);
  for (const child of plan.children) collectTreeTitles(child, into);
}

function renameInTree(plan: ImportPagePlan, from: string, to: string): boolean {
  if (plan.title === from) {
    plan.title = to;
    return true;
  }
  return plan.children.some((child) => renameInTree(child, from, to));
}

function treeSummary(plan: ImportPagePlan): {
  title: string;
  blocks: number;
  assets: string[];
  editability: ReturnType<typeof assessEditability>;
  children: ReturnType<typeof treeSummary>[];
} {
  return {
    title: plan.title,
    blocks: plan.blocks.length,
    assets: plan.assets.map((a) => a.fileName),
    editability: assessEditability(plan.blocks),
    children: plan.children.map(treeSummary),
  };
}

function renderTree(plan: ImportPagePlan, depth: number): string {
  const level = assessEditability(plan.blocks).level;
  const marker = level === "ok" ? "" : ` [editability: ${level.toUpperCase()}]`;
  const lines = [
    `${"  ".repeat(depth)}${depth === 0 ? "•" : "└"} ${plan.title} (${plan.blocks.length} blocks${plan.assets.length ? `, ${plan.assets.length} attachment(s)` : ""})${marker}`,
  ];
  for (const child of plan.children) lines.push(renderTree(child, depth + 1));
  return lines.join("\n");
}

function importHelp(): string {
  return `atlcli wiki import <file.docx|file.pdf> [options]
atlcli wiki import <dir-or-files…> [options]           (batch)
atlcli wiki import --from-page <id> --attachment <name.docx|name.pdf> [options]

Semantic DOCX/PDF import to Confluence page(s), review-first.

Without --confirm the command only previews: block counts, heading outline,
issues, page-tree resolution, and the digest-bound publication plan.
PDF defaults to --split auto: short, editable PDFs stay on one page; longer
PDFs become a bounded page tree instead of one oversized wiki page.

Options:
  --format <kind>        docx|pdf; required for stdin and extensionless input
  --from-page <id>       Source: page id carrying the source attachment
  --attachment <name>    Source: exact attachment file name on that page
  --space <KEY>     Target space key (default: profile space)
  --title <title>   Page title (DOCX: first Heading 1; PDF: file name)
  --parent <id>     Parent page id
  --split <mode>    DOCX: heading level 1..6 when given. PDF: auto (default),
                    off, heading:<1..6>, pages:<5..40>, or numeric alias 1..6
  --max-wiki-pages <n>  PDF page-tree cap, 1..200 (default 50)
  --title-conflict <m>  PDF: fail|rename for planned/existing titles (default fail)
  --scan-policy <mode>  PDF: fail|page-image|report (default fail)
  --visual-fallback <m> PDF: auto|inline|collapsed|appendix; implies page-image
  --reading-order <m>   PDF: auto|tags|geometry (default auto)
  --accept-reported-pages  PDF: acknowledge explicitly omitted reported pages
  --attach-source       PDF: also retain the original PDF (default off)
  --dry-run             Preview only; never prompt or write
  --skip-existing   Batch: skip files whose titles already exist (resume)
  --update-page <id>      Reimport INTO this existing page (keeps id/URL/history)
  --expect-version <n>    Required with --update-page --confirm (lost-update guard)
  --restriction <mode>    inherit|private|explicit (default inherit)
  --viewer <principal>    Repeatable; explicit mode: account:<id> | group-id:<id>
  --editor <principal>    Repeatable; explicit mode: account:<id> | group-id:<id>
  --staging-parent <t>    Create a private import-owned parent titled <t>
  --label <name>          Repeatable; applied and verified on the root page
  --content-property k=v  Repeatable; atlcli.* namespaced page metadata
  --map-style <s>=<t>     Repeatable; map a Word style (id or name) to
                          paragraph|heading-1..6|blockquote|code
  --revisions <mode>      accept|reject tracked changes (default accept)
  --unsupported <mode>    report|fail on lossy constructs (default report)
  --overrides <file>      Format-specific digest-bound override file (YAML/JSON)
  --recipe <file>         Apply a recipe file (atlcli.docx-import-recipe/1)
  --recipe-id <id>        Apply a catalog recipe (.atlcli/import-recipes/, ~/.atlcli/…)

Recipe commands:
  wiki import recipe validate <file>
  wiki import recipe list
  wiki import recipe show <file|id>
  --confirm         Actually create/update the page(s)
  --profile <name>  Use a specific auth profile
  --json            JSON output

Examples:
  atlcli wiki import handbook.docx --space DOCSY
  atlcli wiki import handbook.docx --space DOCSY --parent 12345 --confirm
  atlcli wiki import handbook.pdf --space DOCSY
  atlcli wiki import handbook.pdf --space DOCSY --split pages:20 --max-wiki-pages 25
`;
}
