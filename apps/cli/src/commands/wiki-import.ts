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
  SplitTitleConflictError,
  assessEditability,
  buildGovernance,
  buildImportPreview,
  governanceHasEffects,
  principalId,
  renderGovernanceSummary,
  type DestinationGovernance,
  renderPolicySummary,
  resolveImportPolicy,
  type PolicyLayerInput,
  type ResolvedImportPolicy,
  countPages,
  documentToAdf,
  parseDocx,
  renderImportPreview,
  splitDocument,
  type AdfMediaResolution,
  type ImportPagePlan,
  type ImportedDocument,
} from "@atlcli/import-docx";
import { assertCliAuthSupported } from "./session-guard.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { handleRecipeCommand, loadRecipeById, loadRecipeFile } from "./wiki-import-recipe.js";
import {
  BASELINE_PROPERTY_KEY,
  buildBaseline,
  diffAdfBlocks,
  digestAdfValue,
  parseRecipe,
  recipeApplicability,
  renderSemanticDiffLines,
  validateBaseline,
  type AdfNode,
  type ImportedPageBaselineV1,
} from "@atlcli/import-docx";

interface RecipeInfo {
  id: string;
  version: string;
  digest: string;
  source: "repo" | "user";
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
  if (!fromPage) {
    const batchFiles = resolveBatchFiles(args, opts);
    if (batchFiles) {
      await handleBatchImport(batchFiles, flags, opts);
      return;
    }
  }

  const sourceName = file ?? attachmentName!;
  if (!sourceName.toLowerCase().endsWith(".docx")) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Only .docx files are supported.", { file: sourceName });
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
      fail(
        opts,
        1,
        ERROR_CODES.VALIDATION,
        "wiki import currently supports Confluence Cloud profiles only (Data Center follows the plan's contract track).",
        { profile: profile.name },
      );
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
    await handleUpdateImport(updatePageId, doc, bytes, source, flags, opts, profile!, confirm);
    return;
  }

  const spaceKey = spaceFlag ?? profile?.space;
  if (!spaceKey) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "No space given. Use --space <KEY> or set a profile space.", {});
  }
  const title = getFlag(flags, "title") ?? doc.titleCandidate ?? basename(sourceName, ".docx");
  const parentId = getFlag(flags, "parent");

  // Optional page-tree split (specs/import-docx/009, slice): heading levels
  // 1..N become their own pages below the root. Title conflicts inside the
  // resulting tree block before any preview is shown.
  const splitFlag = getFlag(flags, "split");
  let tree: ImportPagePlan | undefined;
  if (splitFlag !== undefined) {
    const level = Number(splitFlag);
    if (level !== 1 && level !== 2) {
      fail(opts, 1, ERROR_CODES.VALIDATION, "--split must be 1 or 2 (heading levels that open new pages).", {});
    }
    try {
      tree = splitDocument(doc, { level: level as 1 | 2, rootTitle: title });
    } catch (err) {
      if (err instanceof SplitTitleConflictError) {
        fail(opts, 1, ERROR_CODES.VALIDATION, err.message, { duplicates: err.duplicates });
      }
      throw err;
    }
  }

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
  if (conflicts.length > 0) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      `These titles already exist in ${spaceKey}: ${conflicts.join(", ")}. ` +
        `Use --title, rename the headings, or remove the existing pages.`,
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

    if (tree) {
      rootResult = await publishTree(client, space.id, tree, effectiveParent, createdPageIds, rootOptions);
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
        },
      );
    }

    // Labels/properties are required outcomes (invariant 7): a failure here
    // throws and rolls the whole run back.
    await applyMetadata(client, rootResult.id, governance);
  } catch (err) {
    const failedRollbacks: string[] = [];
    for (const id of [...createdPageIds].reverse()) {
      try {
        await client.deletePage(id);
      } catch {
        failedRollbacks.push(id);
      }
    }
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
function resolveBatchFiles(args: string[], opts: OutputOptions): string[] | undefined {
  if (args.length === 1) {
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
    return files;
  }
  for (const arg of args) {
    if (!arg.toLowerCase().endsWith(".docx")) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Batch input must be .docx files; got ${arg}.`, {});
    }
  }
  return args;
}

interface BatchItemPlan {
  file: string;
  doc?: ImportedDocument;
  title?: string;
  tree?: ImportPagePlan;
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
  files: string[],
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
  if (splitLevel !== undefined && splitLevel !== 1 && splitLevel !== 2) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--split must be 1 or 2 (heading levels that open new pages).", {});
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
  for (const file of files) {
    try {
      const doc = parseDocx(new Uint8Array(readFileSync(file)), parsePolicy);
      const title = doc.titleCandidate ?? basename(file, ".docx");
      const tree =
        splitLevel !== undefined
          ? splitDocument(doc, { level: splitLevel as 1 | 2, rootTitle: title })
          : undefined;
      plans.push({ file, doc, title, tree });
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
    if (plan.tree) collectTreeTitles(plan.tree, titles);
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
            pages: plan.tree ? countPages(plan.tree) : 1,
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
    if (plan.tree) collectTreeTitles(plan.tree, titles);
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
      const root = plan.tree
        ? await publishTree(client, space.id, plan.tree, parentId, createdPageIds)
        : await publishOnePage(client, space.id, plan.title, parentId, plan.doc.blocks, plan.doc.assets, createdPageIds);
      results.push({
        file: plan.file,
        title: plan.title,
        status: "created",
        pages: createdPageIds.length,
        rootPageId: root.id,
        url: root.url,
      });
    } catch (err) {
      for (const id of [...createdPageIds].reverse()) {
        try {
          await client.deletePage(id);
        } catch {
          // Recorded below; the batch keeps going either way.
        }
      }
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
async function handleUpdateImport(
  pageId: string,
  doc: ImportedDocument,
  sourceBytes: Uint8Array,
  source: unknown,
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  profile: NonNullable<Awaited<ReturnType<typeof getActiveProfile>>>,
  confirm: boolean,
): Promise<void> {
  const client = new ConfluenceClient(profile);
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

  const inlineComments = await client.getInlineComments(pageId);
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
    const published = JSON.parse(readback.body.value) as { content?: { type?: string }[] };
    const expectedTypes = finalAdf.content.map((n) => n.type).join(",");
    const actualTypes = (published.content ?? []).map((n) => n.type).join(",");
    if (expectedTypes !== actualTypes) {
      throw new Error(
        `published block sequence [${actualTypes}] does not match the reviewed plan [${expectedTypes}]`,
      );
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
    });
    await client.upsertPageProperty(pageId, BASELINE_PROPERTY_KEY, nextBaseline);

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
async function publishOnePage(
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
  } = {},
): Promise<PublishedPageReport> {
  const pageDoc: ImportedDocument = { blocks, assets, issues: [] };
  const hasAssets = assets.length > 0;
  const useShell = hasAssets || options.forceShell === true;
  const page = await client.createPageAdf({
    spaceId,
    title,
    adf: useShell ? { version: 1, type: "doc", content: [] } : documentToAdf(pageDoc),
    parentId,
  });
  createdPageIds.push(page.id);
  if (options.afterShell) await options.afterShell(page.id);

  let adf = documentToAdf(pageDoc);
  let finalPage = page;
  if (blocks.length === 0 && !hasAssets) {
    // Nothing to publish beyond the shell (e.g. a staging parent). Cloud
    // normalizes an empty doc to one empty paragraph, so there is no
    // meaningful block sequence to verify either.
    return { id: page.id, title: page.title, url: page.url, version: page.version };
  }
  if (useShell) {
    let media: Map<string, AdfMediaResolution> | undefined;
    if (hasAssets) {
      for (const asset of assets) {
        await client.uploadAttachment({
          pageId: page.id,
          filename: asset.fileName,
          data: asset.bytes,
          mimeType: asset.mediaType,
        });
      }
      const mediaList = await client.listPageAttachmentMedia(page.id);
      const fileIdByName = new Map(mediaList.attachments.map((a) => [a.filename, a.fileId]));
      media = new Map<string, AdfMediaResolution>();
      for (const asset of assets) {
        const fileId = fileIdByName.get(asset.fileName);
        if (!fileId) {
          throw new Error(`uploaded attachment ${asset.fileName} has no resolvable media fileId`);
        }
        media.set(asset.id, { fileId, collection: `contentId-${page.id}` });
      }
    }
    adf = documentToAdf(pageDoc, media ? { media } : {});
    finalPage = await client.updatePageAdf({ id: page.id, title, adf, version: 2 });
    finalPage = { ...finalPage, url: finalPage.url ?? page.url };
  }

  const readback = await client.getPageAdf(page.id);
  const published = JSON.parse(readback.body.value) as { content?: { type?: string }[] };
  const expectedTypes = adf.content.map((n) => n.type).join(",");
  const actualTypes = (published.content ?? []).map((n) => n.type).join(",");
  if (expectedTypes !== actualTypes) {
    throw new Error(
      `page "${title}": published block sequence [${actualTypes}] does not match the previewed plan [${expectedTypes}]`,
    );
  }

  if (options.baseline) {
    await sealBaseline(client, page.id, readback.body.value, finalPage.version ?? readback.version, assets, options.baseline);
  }
  return { id: finalPage.id, title: finalPage.title, url: finalPage.url, version: finalPage.version };
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
  });
  await client.upsertPageProperty(pageId, BASELINE_PROPERTY_KEY, baseline);
  const stored = await client.getPagePropertyByKey(pageId, BASELINE_PROPERTY_KEY);
  const check = await validateBaseline(stored, pageId);
  if (!check.baseline || check.baseline.provenanceDigest !== baseline.provenanceDigest) {
    throw new Error(`baseline readback failed on page ${pageId}: ${check.reason ?? "digest mismatch"}`);
  }
}

/** Publish a split tree depth-first: each page before its children. */
async function publishTree(
  client: ConfluenceClient,
  spaceId: string,
  plan: ImportPagePlan,
  parentId: string | undefined,
  createdPageIds: string[],
  rootOptions?: Parameters<typeof publishOnePage>[7],
): Promise<PublishedPageReport> {
  const page = await publishOnePage(
    client,
    spaceId,
    plan.title,
    parentId,
    plan.blocks,
    plan.assets,
    createdPageIds,
    rootOptions,
  );
  const children: PublishedPageReport[] = [];
  for (const child of plan.children) {
    children.push(await publishTree(client, spaceId, child, page.id, createdPageIds));
  }
  return children.length > 0 ? { ...page, children } : page;
}

/**
 * Apply and PROVE a restriction policy on one page. The importing user is
 * always included in both operations — a policy that locks the importer out
 * would break the rest of the transaction and strand the page.
 */
async function applyRestriction(
  client: ConfluenceClient,
  pageId: string,
  governance: DestinationGovernance,
  importerAccountId: string,
): Promise<void> {
  const r = governance.restriction;
  if (r.mode === "inherit") return;
  const withImporter = (ids: string[]) =>
    ids.includes(importerAccountId) ? ids : [...ids, importerAccountId];
  const readAccounts =
    r.mode === "private"
      ? [importerAccountId]
      : withImporter(r.viewers.filter((p) => p.kind === "cloud-account").map((p) => p.accountId));
  const readGroups = r.mode === "private" ? [] : r.viewers.filter((p) => p.kind === "cloud-group").map((p) => p.groupId);
  const updateAccounts =
    r.mode === "private"
      ? [importerAccountId]
      : withImporter(r.editors.filter((p) => p.kind === "cloud-account").map((p) => p.accountId));
  const updateGroups = r.mode === "private" ? [] : r.editors.filter((p) => p.kind === "cloud-group").map((p) => p.groupId);

  await client.setContentRestrictions(pageId, {
    read: { accountIds: readAccounts, groupIds: readGroups },
    update: { accountIds: updateAccounts, groupIds: updateGroups },
  });

  // Readback proof: every required principal must actually be in effect.
  const effective = await client.getContentRestrictions(pageId);
  const missing: string[] = [];
  for (const id of readAccounts) if (!effective.read.accountIds.includes(id)) missing.push(`read account:${id}`);
  for (const id of readGroups) if (!effective.read.groupIds.includes(id)) missing.push(`read group-id:${id}`);
  for (const id of updateAccounts) if (!effective.update.accountIds.includes(id)) missing.push(`update account:${id}`);
  for (const id of updateGroups) if (!effective.update.groupIds.includes(id)) missing.push(`update group-id:${id}`);
  if (effective.read.accountIds.length === 0 && effective.read.groupIds.length === 0) {
    missing.push("read restriction set is empty (page would stay space-visible)");
  }
  if (missing.length > 0) {
    throw new Error(`restriction readback failed on page ${pageId}: ${missing.join("; ")}`);
  }
}

/**
 * Apply and PROVE labels and content properties. Required outcomes, not
 * best-effort last mutations (invariant 7): any miss throws → rollback.
 */
async function applyMetadata(
  client: ConfluenceClient,
  pageId: string,
  governance: DestinationGovernance,
): Promise<void> {
  if (governance.labels.length > 0) {
    await client.addLabels(pageId, governance.labels);
    const effective = new Set((await client.getLabels(pageId)).map((l) => l.name));
    const missing = governance.labels.filter((l) => !effective.has(l));
    if (missing.length > 0) {
      throw new Error(`label readback failed on page ${pageId}: missing ${missing.join(", ")}`);
    }
  }
  for (const prop of governance.contentProperties) {
    await client.createPageProperty(pageId, prop.key, prop.value);
    const value = await client.getPagePropertyByKey(pageId, prop.key);
    if (JSON.stringify(value) !== JSON.stringify(prop.value)) {
      throw new Error(
        `property readback failed on page ${pageId}: ${prop.key} is ${JSON.stringify(value)}, expected ${JSON.stringify(prop.value)}`,
      );
    }
  }
}

function collectTreeTitles(plan: ImportPagePlan, into: string[]): void {
  into.push(plan.title);
  for (const child of plan.children) collectTreeTitles(child, into);
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
  return `atlcli wiki import <file.docx> [options]
atlcli wiki import <dir-or-files…> [options]           (batch)
atlcli wiki import --from-page <id> --attachment <name.docx> [options]

Semantic DOCX import to a new Confluence Cloud page (review-first).

Without --confirm the command only previews: block counts, heading outline,
issues, and the digest of the exact ADF payload a confirmed run publishes.
The source is a local file, or a DOCX already attached to a Confluence page.

Options:
  --from-page <id>       Source: page id carrying the DOCX attachment
  --attachment <name>    Source: exact attachment file name on that page
  --space <KEY>     Target space key (default: profile space)
  --title <title>   Page title (default: first Heading 1, else file name)
  --parent <id>     Parent page id
  --split <1|2>     Split into a page tree at heading levels 1 (or 1+2)
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
  --overrides <file>      Override file (atlcli.docx-import-overrides/1, YAML/JSON)
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
`;
}
