/**
 * Manifest-driven batch import with checkpoint/resume
 * (specs/import-docx/010-batch-import, full form).
 *
 * `wiki import --manifest batch.yaml [--resume] [--confirm]`
 *
 * - every document is an independently auditable transaction (failure rolls
 *   back only that document's pages, the batch continues);
 * - `relativeParentPath` folders become pages, so directory hierarchy maps
 *   to page hierarchy;
 * - an atomic local state file (`<manifest>.state.json`, tmp+rename after
 *   every item) records per-item digests and page ids;
 * - `--resume` verifies REMOTE state against the recorded digests before
 *   skipping anything: a complete item is only skipped when its root page
 *   still exists and its body digest matches.
 */
import { dirname, join, resolve } from "node:path";
import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveDeploymentType,
  sha256Hex,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  assessEditability,
  countPages,
  digestAdfValue,
  parseBatchManifest,
  parseDocx,
  splitDocument,
  validateBatchState,
  type BatchStateItemV1,
  type DocxBatchManifestV1,
  type DocxBatchStateV1,
  type SplitResult,
  type ImportedDocument,
} from "@atlcli/import-docx";
import { assertCliAuthSupported } from "./session-guard.js";
import {
  applyRestriction,
  findFreeTitle,
  publishOnePage,
  publishTree,
} from "./wiki-import.js";

/** True only when the page exists AND is current (not trashed). */
async function pageIsCurrent(client: ConfluenceClient, pageId: string): Promise<boolean> {
  try {
    // v1 content GET defaults to status=current — trashed pages 404 here,
    // while v2 getPageAdf still serves trashed bodies (proven live).
    await client.getPage(pageId);
    return true;
  } catch {
    return false;
  }
}

interface PlannedItem {
  doc: ImportedDocument;
  title: string;
  split?: SplitResult;
  sourceSha256: string;
  labels: string[];
  relativeParentPath?: string;
}

export async function handleManifestBatch(
  manifestPath: string,
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  const confirm = hasFlag(flags, "confirm");
  const resume = hasFlag(flags, "resume");

  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch (err) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Cannot read manifest: ${(err as Error).message}`, {});
  }
  const { manifest, digest: manifestDigest, errors } = await parseBatchManifest(manifestText);
  if (!manifest || !manifestDigest) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Invalid batch manifest:\n  ${errors.join("\n  ")}`, { errors });
  }
  const baseDir = dirname(resolve(manifestPath));
  const statePath = getFlag(flags, "state") ?? `${resolve(manifestPath)}.state.json`;

  // Load or initialize the checkpoint state.
  let state: DocxBatchStateV1 = {
    schema: "atlcli.docx-batch-state/1",
    batchId: manifest.batchId,
    manifestDigest,
    folderPages: {},
    items: [],
  };
  if (resume) {
    if (!existsSync(statePath)) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `--resume: no state file at ${statePath}.`, {});
    }
    const loaded = validateBatchState(
      JSON.parse(readFileSync(statePath, "utf8")),
      manifest.batchId,
      manifestDigest,
    );
    if (!loaded.state) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `--resume: state file is unusable: ${loaded.reason}.`, {});
    }
    state = loaded.state;
  }
  const saveState = (): void => {
    const tmp = `${statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, statePath);
  };

  // Plan every document up front (bounded planning concurrency: sequential).
  const planned = new Map<string, PlannedItem | { error: string }>();
  for (const docSpec of manifest.documents) {
    try {
      const bytes = new Uint8Array(readFileSync(join(baseDir, docSpec.sourcePath)));
      const doc = parseDocx(bytes);
      const title =
        docSpec.title ?? doc.titleCandidate ?? docSpec.sourcePath.replace(/^.*\//, "").replace(/\.docx$/i, "");
      const splitLevel = docSpec.splitHeading ?? manifest.defaults.splitHeading;
      const split =
        splitLevel !== undefined
          ? splitDocument(doc, { level: splitLevel, rootTitle: title }, manifest.defaults.titleConflict)
          : undefined;
      if (split) doc.issues.push(...split.issues);
      planned.set(docSpec.sourcePath, {
        doc,
        title,
        split,
        sourceSha256: await sha256Hex(bytes),
        labels: docSpec.labels ?? [],
        relativeParentPath: docSpec.relativeParentPath,
      });
    } catch (err) {
      planned.set(docSpec.sourcePath, { error: (err as Error).message });
    }
  }

  if (!confirm) {
    const items = manifest.documents.map((docSpec) => {
      const plan = planned.get(docSpec.sourcePath)!;
      if ("error" in plan) return { sourcePath: docSpec.sourcePath, error: plan.error };
      return {
        sourcePath: docSpec.sourcePath,
        title: plan.title,
        parentPath: plan.relativeParentPath ?? "",
        pages: plan.split ? countPages(plan.split.root) : 1,
        labels: plan.labels,
        issues: plan.doc.issues.length,
        editability: assessEditability(plan.doc.blocks).level,
      };
    });
    if (opts.json) {
      output({ mode: "manifest-preview", batchId: manifest.batchId, manifestDigest, destination: manifest.destination, items }, opts);
    } else {
      output(`Batch "${manifest.batchId}" → space ${manifest.destination.spaceKey} (staging: ${manifest.destination.staging}):`, opts);
      for (const item of items) {
        if ("error" in item && item.error) output(`  ✗ ${item.sourcePath}: REJECTED — ${item.error}`, opts);
        else if ("title" in item) {
          output(
            `  • ${item.sourcePath} → ${item.parentPath ? `${item.parentPath}/` : ""}"${item.title}" (${item.pages} page(s), ${item.issues} issue(s))`,
            opts,
          );
        }
      }
      output(`\nDry preview only — re-run with --confirm to import the batch.`, opts);
    }
    return;
  }

  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {});
  assertCliAuthSupported(profile, opts);
  if (resolveDeploymentType(profile) !== "cloud") {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Batch import currently supports Confluence Cloud profiles only.", {});
  }
  const client = new ConfluenceClient(profile);
  const spacePage = await client.listSpacesV2({ keys: [manifest.destination.spaceKey], limit: 1 });
  const space = spacePage.spaces.find((s) => s.key === manifest.destination.spaceKey);
  if (!space) {
    fail(opts, 1, ERROR_CODES.API, `Space ${manifest.destination.spaceKey} not found or not accessible.`, {});
  }

  // Batch root: optional private staging parent, verified on resume.
  let batchRootId = manifest.destination.parentId;
  if (manifest.destination.staging === "private") {
    const me = await client.getCurrentUser();
    const stagingTitle = `Import batch ${manifest.batchId}`;
    if (state.stagingRootId) {
      if (await pageIsCurrent(client, state.stagingRootId)) batchRootId = state.stagingRootId;
      else state.stagingRootId = undefined; // vanished remotely — recreate
    }
    if (!state.stagingRootId) {
      const ids: string[] = [];
      const staging = await publishOnePage(client, space.id, stagingTitle, manifest.destination.parentId, [], [], ids, {
        forceShell: true,
        afterShell: async (id) => {
          await applyRestriction(
            client,
            id,
            { schema: "atlcli.docx-destination-governance/1", restriction: { mode: "private" }, staging: { mode: "none" }, labels: [], contentProperties: [] },
            me.accountId,
          );
        },
      });
      state.stagingRootId = staging.id;
      batchRootId = staging.id;
      saveState();
    }
  }

  // Folder pages: relativeParentPath segments become (reused) pages.
  const ensureFolder = async (path: string): Promise<string> => {
    if (state.folderPages[path]) {
      if (await pageIsCurrent(client, state.folderPages[path])) return state.folderPages[path];
      delete state.folderPages[path]; // vanished — recreate below
    }
    const segments = path.split("/");
    const parentPath = segments.slice(0, -1).join("/");
    const parentId = parentPath ? await ensureFolder(parentPath) : batchRootId;
    const ids: string[] = [];
    const page = await publishOnePage(client, space.id, segments[segments.length - 1], parentId, [], [], ids, {
      forceShell: true,
    });
    state.folderPages[path] = page.id;
    saveState();
    return page.id;
  };

  const results: BatchStateItemV1[] = [];
  for (const docSpec of manifest.documents) {
    const plan = planned.get(docSpec.sourcePath)!;
    const previous = state.items.find((i) => i.sourcePath === docSpec.sourcePath);

    if ("error" in plan) {
      results.push({ sourcePath: docSpec.sourcePath, sourceSha256: "", status: "failed", pageIds: [], lastError: plan.error });
      continue;
    }

    // Resume: skip only when the remote root page still matches the digest
    // this state recorded — never trust local state alone.
    const resumable = previous?.status === "complete" || previous?.status === "skipped";
    if (resume && previous && resumable && previous.sourceSha256 === plan.sourceSha256 && previous.rootPageId) {
      if (await pageIsCurrent(client, previous.rootPageId)) {
        try {
          const remote = await client.getPageAdf(previous.rootPageId);
          const digest = await digestAdfValue(remote.body.value);
          if (digest === previous.verifiedBodyDigest) {
            results.push({ ...previous, status: "skipped" });
            continue;
          }
        } catch {
          // fall through: unreadable → re-import
        }
      }
      // fall through: trashed/deleted or drifted → re-import
    }

    try {
      const parentId = plan.relativeParentPath ? await ensureFolder(plan.relativeParentPath) : batchRootId;

      // Space-level title preflight per manifest titleConflict policy.
      const titles: string[] = [];
      const pushTitles = (p: typeof plan): void => {
        if (p.split) {
          const walk = (node: SplitResult["root"]): void => {
            titles.push(node.title);
            node.children.forEach(walk);
          };
          walk(p.split.root);
        } else titles.push(p.title);
      };
      pushTitles(plan);
      for (const t of titles) {
        const matches = await client.findPagesByTitle(t, { spaceKey: manifest.destination.spaceKey });
        if (matches.length > 0) {
          if (manifest.defaults.titleConflict === "rename") {
            const free = await findFreeTitle(client, manifest.destination.spaceKey, t);
            if (plan.split) {
              const rename = (node: SplitResult["root"]): boolean => {
                if (node.title === t) {
                  node.title = free;
                  return true;
                }
                return node.children.some(rename);
              };
              rename(plan.split.root);
            }
            if (plan.title === t) plan.title = free;
          } else {
            throw new Error(`title "${t}" already exists in ${manifest.destination.spaceKey}`);
          }
        }
      }

      const createdPageIds: string[] = [];
      let root;
      try {
        root = plan.split
          ? await publishTree(client, space.id, plan.split, parentId, createdPageIds)
          : await publishOnePage(client, space.id, plan.title, parentId, plan.doc.blocks, plan.doc.assets, createdPageIds);
        if (plan.labels.length > 0) {
          await client.addLabels(root.id, plan.labels);
        }
      } catch (err) {
        for (const id of [...createdPageIds].reverse()) {
          try {
            await client.deletePage(id);
          } catch {
            // recorded via lastError; the batch keeps going
          }
        }
        throw err;
      }
      const readback = await client.getPageAdf(root.id);
      results.push({
        sourcePath: docSpec.sourcePath,
        sourceSha256: plan.sourceSha256,
        status: "complete",
        rootPageId: root.id,
        pageIds: createdPageIds,
        verifiedBodyDigest: await digestAdfValue(readback.body.value),
      });
    } catch (err) {
      results.push({
        sourcePath: docSpec.sourcePath,
        sourceSha256: plan.sourceSha256,
        status: "failed",
        pageIds: [],
        lastError: (err as Error).message,
      });
    }

    // Checkpoint after EVERY item (atomic tmp+rename). "skipped" is a
    // run-level outcome; it persists as "complete" so later resumes keep
    // trusting the recorded digests.
    state.items = manifest.documents.map(
      (d) =>
        results
          .map((r) => (r.status === "skipped" ? { ...r, status: "complete" as const } : r))
          .find((r) => r.sourcePath === d.sourcePath) ??
        state.items.find((i) => i.sourcePath === d.sourcePath) ?? {
          sourcePath: d.sourcePath,
          sourceSha256: "",
          status: "planned" as const,
          pageIds: [],
        },
    );
    saveState();
  }

  // Final sync: skip-only iterations `continue` past the per-item
  // checkpoint, so persist the normalized result set once more here.
  state.items = manifest.documents.map(
    (d) =>
      results
        .map((r) => (r.status === "skipped" ? { ...r, status: "complete" as const } : r))
        .find((r) => r.sourcePath === d.sourcePath) ??
      state.items.find((i) => i.sourcePath === d.sourcePath) ?? {
        sourcePath: d.sourcePath,
        sourceSha256: "",
        status: "planned" as const,
        pageIds: [],
      },
  );
  saveState();

  const complete = results.filter((r) => r.status === "complete");
  const skipped = results.filter((r) => r.status === "skipped");
  const failed = results.filter((r) => r.status === "failed");
  if (opts.json) {
    output(
      {
        mode: "manifest-published",
        batchId: manifest.batchId,
        manifestDigest,
        statePath,
        stagingRootId: state.stagingRootId,
        summary: { complete: complete.length, skipped: skipped.length, failed: failed.length },
        results,
      },
      opts,
    );
  } else {
    for (const r of results) {
      const mark = r.status === "complete" ? "✓" : r.status === "skipped" ? "→" : "✗";
      output(`  ${mark} ${r.sourcePath}: ${r.status}${r.rootPageId ? ` (root ${r.rootPageId})` : ""}${r.lastError ? ` — ${r.lastError}` : ""}`, opts);
    }
    output(`\nBatch "${manifest.batchId}": ${complete.length} complete, ${skipped.length} skipped, ${failed.length} failed. State: ${statePath}`, opts);
  }
  if (failed.length > 0) process.exit(1);
}
