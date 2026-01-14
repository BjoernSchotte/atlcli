import { readdir, writeFile, readFile, mkdir, stat, unlink } from "node:fs/promises";
import { FSWatcher, watch, existsSync } from "node:fs";
import { join, basename, extname, dirname, relative, resolve } from "node:path";
import {
  ERROR_CODES,
  OutputOptions,
  ensureDir,
  fail,
  getActiveProfile,
  getFlag,
  getLogger,
  hasFlag,
  loadConfig,
  output,
  readTextFile,
  slugify,
  writeTextFile,
  // New template system
  GlobalTemplateStorage,
  ProfileTemplateStorage,
  SpaceTemplateStorage,
  TemplateResolver,
  TemplateEngine,
} from "@atlcli/core";
import {
  ConfluenceClient,
  hashContent,
  markdownToStorage,
  normalizeMarkdown,
  resolveConflicts,
  storageToMarkdown,
  replaceAttachmentPaths,
  extractAttachmentRefs,
  isImageFile,
  // Local storage
  findAtlcliDir,
  initAtlcliDir,
  isInitialized,
  readConfig,
  readState,
  writeState,
  updatePageState,
  getPageByPath,
  getPageById,
  computeSyncState as computeSyncStateFromHashes,
  readBaseContent,
  writeBaseContent,
  slugifyTitle,
  generateUniqueFilename,
  getRelativePath,
  AtlcliConfig,
  AtlcliState,
  PageState,
  SyncState as CoreSyncState,
  // Attachments
  getAttachmentsDirName,
  updateAttachmentState,
  removeAttachmentState,
  getPageAttachments,
  writeAttachmentBase,
  deleteAttachmentBase,
  computeAttachmentSyncState,
  AttachmentState,
  AttachmentInfo,
  LARGE_FILE_THRESHOLD,
  formatFileSize,
  generateConflictFilename,
  // Frontmatter
  parseFrontmatter,
  addFrontmatter,
  stripFrontmatter,
  extractTitleFromMarkdown,
  AtlcliFrontmatter,
  // Hierarchy
  computeFilePath,
  buildPathMap,
  moveFile,
  hasPageMoved,
  PageHierarchyInfo,
  // Scope
  parseScope,
  buildCqlFromScope,
  scopeToString,
  SyncScope,
  // Config v2
  initAtlcliDirV2,
  getConfigScope,
  isConfigV2,
  ConfigScope,
  // Diff
  generateDiff,
  formatDiffWithColors,
  formatDiffSummary,
  // Ignore
  loadIgnorePatterns,
  shouldIgnore,
  IgnoreResult,
  // Comments
  getCommentsFilePath,
  writeCommentsFile,
  PageComments,
  // Validation
  validateFile,
  validateDirectory,
  formatValidationReport,
  ValidationResult,
} from "@atlcli/confluence";
import type { Ignore } from "@atlcli/confluence";
import { handleSync, syncHelp } from "./sync.js";

/** Sync state for bidirectional sync tracking */
export type SyncState = "synced" | "local-modified" | "remote-modified" | "conflict";

/** Enhanced metadata structure for bidirectional sync */
export interface EnhancedMeta {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  lastSyncedAt: string;
  localHash: string;
  remoteHash: string;
  baseHash: string;
  syncState: SyncState;
}

/** Legacy metadata structure for backwards compatibility */
interface LegacyMeta {
  id?: string;
  title?: string;
  spaceKey?: string;
  version?: number;
}

export async function handleDocs(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "init":
      await handleInit(args.slice(1), flags, opts);
      return;
    case "pull":
      await handlePull(args.slice(1), flags, opts);
      return;
    case "push":
      await handlePush(args.slice(1), flags, opts);
      return;
    case "add":
      await handleAdd(args.slice(1), flags, opts);
      return;
    case "watch":
      await handleWatch(args.slice(1), flags, opts);
      return;
    case "sync":
      await handleSync(args.slice(1), flags, opts);
      return;
    case "status":
      await handleStatus(args.slice(1), flags, opts);
      return;
    case "resolve":
      await handleResolve(args.slice(1), flags, opts);
      return;
    case "diff":
      await handleDocsDiff(args.slice(1), flags, opts);
      return;
    case "check":
      await handleCheck(args.slice(1), flags, opts);
      return;
    default:
      output(docsHelp(), opts);
      return;
  }
}

async function getClient(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<ConfluenceClient> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  return new ConfluenceClient(profile);
}

/**
 * Initialize a directory for Confluence sync.
 * Creates .atlcli/ with config.json, state.json, and cache/ directory.
 */
async function handleInit(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const dir = args[0] || ".";

  if (isInitialized(dir)) {
    fail(opts, 1, ERROR_CODES.USAGE, `Directory already initialized: ${dir}/.atlcli/`);
  }

  // Get profile info for baseUrl
  const appConfig = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(appConfig, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }

  // Parse scope from flags
  const parsedScope = parseScope(flags);
  let scope: ConfigScope;
  let space: string | undefined = getFlag(flags, "space");

  if (parsedScope) {
    // Convert SyncScope to ConfigScope
    switch (parsedScope.scope.type) {
      case "page":
        scope = { type: "page", pageId: parsedScope.scope.pageId };
        break;
      case "tree":
        scope = { type: "tree", ancestorId: parsedScope.scope.ancestorId };
        break;
      case "space":
        scope = { type: "space" };
        space = parsedScope.scope.spaceKey;
        break;
    }
  } else if (space) {
    // Only --space provided
    scope = { type: "space" };
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "--space, --page-id, or --ancestor is required.");
  }

  // Auto-detect space from page/ancestor if not provided
  if (!space && (scope.type === "page" || scope.type === "tree")) {
    const client = await getClient(flags, opts);
    const pageId = scope.type === "page" ? scope.pageId : scope.ancestorId;
    const pageInfo = await client.getPage(pageId);
    space = pageInfo.spaceKey;
    if (!opts.json) {
      output(`Auto-detected space: ${space}`, opts);
    }
  }

  if (!space) {
    fail(opts, 1, ERROR_CODES.USAGE, "Could not determine space. Specify --space explicitly.");
  }

  await ensureDir(dir);
  await initAtlcliDirV2(dir, {
    scope,
    space,
    baseUrl: profile.baseUrl,
    profile: profile.name,
    settings: {
      autoCreatePages: false,
      preserveHierarchy: true,
      defaultParentId: null,
    },
  });

  // Build scope description for output
  let scopeDesc: string;
  switch (scope.type) {
    case "page":
      scopeDesc = `page ${scope.pageId}`;
      break;
    case "tree":
      scopeDesc = `tree under ${scope.ancestorId}`;
      break;
    case "space":
      scopeDesc = `space ${space}`;
      break;
  }

  output(
    opts.json
      ? { schemaVersion: "2", initialized: true, dir, scope, space }
      : `Initialized ${dir}/.atlcli/ for ${scopeDesc}`,
    opts
  );
}

async function handlePull(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const outDir = args[0] || getFlag(flags, "out") || ".";
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const force = hasFlag(flags, "force");
  const labelFilter = getFlag(flags, "label");

  // Check if directory is initialized
  let atlcliDir = findAtlcliDir(outDir);
  let dirConfig: AtlcliConfig | null = null;

  if (atlcliDir) {
    dirConfig = await readConfig(atlcliDir);
  }

  // Parse scope from flags
  const parsedScope = parseScope(flags);
  let scope: SyncScope;
  let space: string | undefined;

  if (parsedScope) {
    scope = parsedScope.scope;
    space = parsedScope.spaceKey;
  } else if (dirConfig) {
    // Use scope from config
    const configScope = getConfigScope(dirConfig);
    space = dirConfig.space;

    // Convert ConfigScope to SyncScope
    switch (configScope.type) {
      case "page":
        scope = { type: "page", pageId: configScope.pageId };
        break;
      case "tree":
        scope = { type: "tree", ancestorId: configScope.ancestorId };
        break;
      case "space":
        scope = { type: "space", spaceKey: space };
        break;
    }
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "--space, --page-id, or --ancestor is required (or run 'docs init' first).");
  }

  const client = await getClient(flags, opts);

  // For single page or tree scope without space, auto-detect space from page
  if (!space && (scope.type === "page" || scope.type === "tree")) {
    const pageId = scope.type === "page" ? scope.pageId : scope.ancestorId;
    const pageInfo = await client.getPage(pageId);
    space = pageInfo.spaceKey;
    if (!opts.json) {
      output(`Auto-detected space: ${space}`, opts);
    }
  }

  // Fetch pages based on scope
  let pages: { id: string; title: string }[];
  let cql = buildCqlFromScope(scope);

  // Add label filter if specified
  if (labelFilter) {
    if (cql) {
      cql += ` AND label = "${labelFilter}"`;
    } else if (scope.type === "page") {
      // For single page with label filter, we'll check after fetch
      // and skip if page doesn't have the label
    }
  }

  if (cql) {
    // Tree or space scope: use CQL search
    pages = await client.searchPages(cql, Number.isNaN(limit) ? 50 : limit);
  } else {
    // Single page scope: direct fetch
    const pageId = (scope as { type: "page"; pageId: string }).pageId;
    const page = await client.getPage(pageId);

    // If label filter is specified for single page, verify it has the label
    if (labelFilter) {
      const labels = await client.getLabels(pageId);
      if (!labels.some((l) => l.name === labelFilter)) {
        if (!opts.json) {
          output(`Page ${page.title} does not have label "${labelFilter}", skipping.`, opts);
        }
        output({
          schemaVersion: "1",
          results: { pulled: 0, skipped: 1, moved: 0, outDir, attachments: 0 },
          note: `Page does not have label "${labelFilter}".`,
        }, opts);
        return;
      }
    }

    pages = [{ id: page.id, title: page.title }];
  }

  if (!opts.json) {
    output(`Pulling ${pages.length} page(s) from ${scopeToString(scope)}...`, opts);
  }

  // If not initialized, auto-init
  if (!atlcliDir && space) {
    const appConfig = await loadConfig();
    const profileName = getFlag(flags, "profile");
    const profile = getActiveProfile(appConfig, profileName);
    if (profile) {
      await ensureDir(outDir);
      await initAtlcliDir(outDir, {
        space,
        baseUrl: profile.baseUrl,
        profile: profile.name,
      });
      atlcliDir = outDir;
    }
  }

  await ensureDir(outDir);
  const state = atlcliDir ? await readState(atlcliDir) : null;
  const existingPaths = state ? new Set(Object.keys(state.pathIndex)) : new Set<string>();

  // Fetch full page details with ancestors
  const pageDetails: Array<{
    id: string;
    title: string;
    storage: string;
    version: number;
    spaceKey: string;
    parentId: string | null;
    ancestors: { id: string; title: string }[];
  }> = [];

  for (const page of pages) {
    const detail = await client.getPage(page.id);
    pageDetails.push({
      id: detail.id,
      title: detail.title,
      storage: detail.storage,
      version: detail.version ?? 1,
      spaceKey: detail.spaceKey ?? space!,
      parentId: detail.parentId ?? null,
      ancestors: detail.ancestors ?? [],
    });
  }

  // Build hierarchy info for path computation
  const hierarchyPages: PageHierarchyInfo[] = pageDetails.map((p) => ({
    id: p.id,
    title: p.title,
    parentId: p.parentId,
    ancestors: p.ancestors.map((a) => a.id),
  }));

  // Build ancestor title map (include all ancestors)
  const ancestorTitles = new Map<string, string>();
  for (const page of pageDetails) {
    ancestorTitles.set(page.id, page.title);
    for (const ancestor of page.ancestors) {
      ancestorTitles.set(ancestor.id, ancestor.title);
    }
  }

  // Detect space home page for flattening hierarchy
  // When syncing a space, find the root page (the one with no ancestors)
  let homePageId: string | undefined;
  if (scope.type === "space" && pageDetails.length > 0) {
    const homePage = pageDetails.find((p) => !p.parentId && p.ancestors.length === 0);
    if (homePage) {
      homePageId = homePage.id;
      if (!opts.json) {
        output(`Using "${homePage.title}" as space home page (children will be at root level)`, opts);
      }
    }
  }

  // Compute nested paths
  const pathMap = buildPathMap(hierarchyPages, {
    existingPaths,
    rootAncestorId: homePageId,
  });

  let pulled = 0;
  let skipped = 0;
  let moved = 0;

  // Check if attachments are enabled (default: true)
  const pullAttachments = !hasFlag(flags, "no-attachments");
  let attachmentsPulled = 0;

  // Check if comments should be pulled
  const pullComments = hasFlag(flags, "comments");
  let commentsPulled = 0;

  for (const detail of pageDetails) {
    // Convert storage to markdown, then apply page-specific attachment paths
    const rawMarkdown = storageToMarkdown(detail.storage);
    const ancestorIds = detail.ancestors.map((a) => a.id);

    // Get computed path for this page
    const computed = pathMap.get(detail.id);
    if (!computed) {
      output(`Warning: Could not compute path for page ${detail.id}`, opts);
      skipped++;
      continue;
    }

    // Check if we already have this page
    const existingState = state?.pages[detail.id];
    let relativePath = computed.relativePath;

    if (existingState) {
      // Check if page has moved in Confluence
      const oldAncestors = existingState.ancestors ?? [];
      if (hasPageMoved(oldAncestors, ancestorIds)) {
        // Page has moved - move the local file
        if (atlcliDir) {
          try {
            await moveFile(atlcliDir, existingState.path, relativePath);
            if (!opts.json) {
              output(`Moved ${existingState.path} -> ${relativePath}`, opts);
            }
            moved++;
            getLogger().sync({
              eventType: "status",
              file: relativePath,
              pageId: detail.id,
              title: `Moved from ${existingState.path}`,
              details: { oldPath: existingState.path, newPath: relativePath },
            });
          } catch (err) {
            // File might not exist, just use new path
          }
        }
      } else {
        // Keep existing path if not moved
        relativePath = existingState.path;
      }

      // Check if local has modifications
      if (!force) {
        const localPath = join(atlcliDir!, relativePath);
        try {
          const localContent = await readTextFile(localPath);
          const { content: localWithoutFrontmatter } = parseFrontmatter(localContent);
          const localHash = hashContent(normalizeMarkdown(localWithoutFrontmatter));

          if (localHash !== existingState.baseHash) {
            // Local has modifications, skip unless --force
            output(`Skipping ${relativePath} (local modifications, use --force)`, opts);
            skipped++;
            getLogger().sync({
              eventType: "status",
              file: relativePath,
              pageId: detail.id,
              title: `Skipped: local modifications`,
            });
            continue;
          }
        } catch {
          // File doesn't exist, will be re-created
        }
      }
    }

    const filePath = join(outDir, relativePath);
    const pageFilename = basename(relativePath);
    const pageDir = dirname(filePath);

    // Fetch and download attachments if enabled
    let attachments: AttachmentInfo[] = [];
    if (pullAttachments) {
      try {
        attachments = await client.listAttachments(detail.id);
      } catch (err) {
        // Log warning but don't fail the pull
        if (!opts.json) {
          output(`Warning: Could not fetch attachments for ${relativePath}`, opts);
        }
      }

      if (attachments.length > 0) {
        // Create attachments directory
        const attachmentsDir = join(pageDir, getAttachmentsDirName(pageFilename));
        await mkdir(attachmentsDir, { recursive: true });

        for (const attachment of attachments) {
          // Skip attachments with empty or invalid filenames
          if (!attachment.filename) {
            continue;
          }

          // Warn about large files
          if (attachment.fileSize >= LARGE_FILE_THRESHOLD && !opts.json) {
            output(`Warning: Large attachment ${attachment.filename} (${formatFileSize(attachment.fileSize)})`, opts);
          }

          try {
            const data = await client.downloadAttachment(attachment);
            const attachmentPath = join(attachmentsDir, attachment.filename);
            const remoteHash = hashContent(data.toString("base64"));

            // Check for conflict with local changes
            const existingAttState = state?.pages[detail.id]?.attachments?.[attachment.id];
            if (existingAttState && existsSync(attachmentPath)) {
              // Read local file to get current hash
              const localData = await readFile(attachmentPath);
              const localHash = hashContent(localData.toString("base64"));

              const syncState = computeAttachmentSyncState(
                localHash,
                remoteHash,
                existingAttState.baseHash
              );

              if (syncState === "conflict") {
                // Both local and remote changed - save remote as conflict file
                const conflictFilename = generateConflictFilename(attachment.filename);
                const conflictPath = join(attachmentsDir, conflictFilename);
                await writeFile(conflictPath, data);

                if (!opts.json) {
                  output(`Conflict: ${attachment.filename} - saved remote as ${conflictFilename}`, opts);
                }

                // Update state to mark as conflict
                if (state) {
                  updateAttachmentState(state, detail.id, attachment.id, {
                    remoteHash,
                    syncState: "conflict",
                    lastSyncedAt: new Date().toISOString(),
                  });
                }
                continue; // Don't overwrite local file
              }
            }

            // No conflict - write normally
            await writeFile(attachmentPath, data);
            attachmentsPulled++;
          } catch (err) {
            if (!opts.json) {
              output(`Warning: Could not download attachment ${attachment.filename}`, opts);
            }
          }
        }

        // Check for deleted attachments (were in state but not in remote list)
        const existingState = state?.pages[detail.id];
        if (state && existingState?.attachments && atlcliDir) {
          const remoteFilenames = new Set(attachments.map((a) => a.filename));

          for (const [attId, attState] of Object.entries(existingState.attachments)) {
            if (!remoteFilenames.has(attState.filename)) {
              // Attachment was deleted in Confluence - delete local file
              const localAttPath = join(attachmentsDir, attState.filename);
              try {
                await unlink(localAttPath);
                removeAttachmentState(state, detail.id, attId);
                await deleteAttachmentBase(atlcliDir, detail.id, attId, extname(attState.filename));
                if (!opts.json) {
                  output(`Deleted ${attState.filename} (removed from Confluence)`, opts);
                }
              } catch {
                // File may not exist, continue
              }
            }
          }
        }
      }
    }

    // Apply page-specific attachment paths to markdown
    const markdown = replaceAttachmentPaths(rawMarkdown, pageFilename);
    const normalizedMd = normalizeMarkdown(markdown);
    const contentHash = hashContent(normalizedMd);

    // Add frontmatter with page ID
    const frontmatter: AtlcliFrontmatter = {
      id: detail.id,
      title: detail.title,
    };
    const contentWithFrontmatter = addFrontmatter(markdown, frontmatter);

    await ensureDir(pageDir);
    await writeTextFile(filePath, contentWithFrontmatter);

    // Update state and cache
    if (state && atlcliDir) {
      updatePageState(state, detail.id, {
        path: relativePath,
        title: detail.title,
        spaceKey: detail.spaceKey,
        version: detail.version,
        lastSyncedAt: new Date().toISOString(),
        localHash: contentHash,
        remoteHash: contentHash,
        baseHash: contentHash,
        syncState: "synced",
        parentId: detail.parentId,
        ancestors: ancestorIds,
        hasAttachments: attachments.length > 0,
      });

      // Update attachment state
      for (const attachment of attachments) {
        try {
          const attachmentPath = join(pageDir, getAttachmentsDirName(pageFilename), attachment.filename);
          const attachmentData = await readFile(attachmentPath);
          const attachmentHash = hashContent(attachmentData.toString("base64"));

          updateAttachmentState(state, detail.id, attachment.id, {
            attachmentId: attachment.id,
            filename: attachment.filename,
            localPath: join(getAttachmentsDirName(pageFilename), attachment.filename),
            mediaType: attachment.mediaType,
            fileSize: attachment.fileSize,
            version: attachment.version,
            localHash: attachmentHash,
            remoteHash: attachmentHash,
            baseHash: attachmentHash,
            lastSyncedAt: new Date().toISOString(),
            syncState: "synced",
          });

          // Write base content for conflict detection
          await writeAttachmentBase(
            atlcliDir,
            detail.id,
            attachment.id,
            extname(attachment.filename),
            attachmentData
          );
        } catch (err) {
          // Attachment state update failed, continue
        }
      }

      // Write base content for 3-way merge (without frontmatter)
      await writeBaseContent(atlcliDir, detail.id, normalizedMd);
    }

    // Pull comments if enabled
    if (pullComments) {
      try {
        const comments = await client.getAllComments(detail.id);
        if (comments.footerComments.length > 0 || comments.inlineComments.length > 0) {
          const commentsPath = getCommentsFilePath(filePath);
          await writeCommentsFile(commentsPath, comments);
          commentsPulled++;
          if (!opts.json) {
            const total = comments.footerComments.length + comments.inlineComments.length;
            output(`  Saved ${total} comment(s) to ${basename(commentsPath)}`, opts);
          }
        }
      } catch (err) {
        // Log warning but don't fail the pull
        if (!opts.json) {
          output(`Warning: Could not fetch comments for ${relativePath}`, opts);
        }
      }
    }

    pulled++;

    // Log sync event
    getLogger().sync({
      eventType: "pull",
      file: relativePath,
      pageId: detail.id,
      title: detail.title,
    });
  }

  // Save state
  if (state && atlcliDir) {
    state.lastSync = new Date().toISOString();
    await writeState(atlcliDir, state);
  }

  const pullResults: Record<string, unknown> = { pulled, skipped, moved, outDir };
  if (pullAttachments && attachmentsPulled > 0) {
    pullResults.attachments = attachmentsPulled;
  }
  if (pullComments && commentsPulled > 0) {
    pullResults.comments = commentsPulled;
  }

  output(
    {
      schemaVersion: "1",
      results: pullResults,
      note: "Files use nested directory structure matching Confluence hierarchy.",
    },
    opts
  );
}

async function handlePush(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const pathArg = args[0] ?? getFlag(flags, "dir") ?? ".";
  const pageIdFlag = getFlag(flags, "page-id");
  const client = await getClient(flags, opts);

  // Determine if pushing single file, by page ID, or directory
  let files: string[];
  let atlcliDir: string | null;
  let isSingleFile = false;

  if (pageIdFlag) {
    // Push by page ID - find the file in state
    atlcliDir = findAtlcliDir(pathArg);
    if (!atlcliDir) {
      fail(opts, 1, ERROR_CODES.USAGE, "Not in an initialized directory. Run 'docs init' first.");
    }
    const state = await readState(atlcliDir);
    const pageState = state.pages[pageIdFlag];
    if (!pageState) {
      fail(opts, 1, ERROR_CODES.USAGE, `Page ${pageIdFlag} not found in state. Pull it first or use file path.`);
    }
    files = [join(atlcliDir, pageState.path)];
    isSingleFile = true;
  } else if (pathArg.endsWith(".md")) {
    // Single file push
    files = [resolve(pathArg)];
    atlcliDir = findAtlcliDir(dirname(pathArg));
    isSingleFile = true;
  } else {
    // Directory push - collect all markdown files, respecting ignore patterns
    atlcliDir = findAtlcliDir(pathArg);
    const ignoreResult = await loadIgnorePatterns(atlcliDir ?? pathArg);
    files = await collectMarkdownFiles(pathArg, {
      ignore: ignoreResult.ignore,
      rootDir: atlcliDir ?? pathArg,
    });
  }

  let space = getFlag(flags, "space");
  let state: AtlcliState | undefined;

  if (atlcliDir) {
    const dirConfig = await readConfig(atlcliDir);
    space = space || dirConfig.space;
    state = await readState(atlcliDir);
  }

  // Run validation if --validate flag is set
  if (hasFlag(flags, "validate") && atlcliDir) {
    const strict = hasFlag(flags, "strict");
    const result = await validateDirectory(atlcliDir, state ?? null, atlcliDir, {
      checkBrokenLinks: true,
      checkMacroSyntax: true,
      checkPageSize: true,
      maxPageSizeKb: 500,
    });

    if (!result.passed) {
      output(formatValidationReport(result), opts);
      fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed - push aborted");
    }

    if (result.totalWarnings > 0) {
      output(formatValidationReport(result), opts);
      if (strict) {
        fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed (strict mode: warnings are errors) - push aborted");
      }
      if (!opts.json) {
        output("Proceeding with push despite warnings...\n", opts);
      }
    }
  }

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const filePath of files) {
    const result = await pushFile({ client, filePath, space, opts, atlcliDir: atlcliDir || undefined, state });
    if (result === "updated") updated += 1;
    else if (result === "created") created += 1;
    else skipped += 1;
  }

  // Save state if we have one
  if (state && atlcliDir) {
    state.lastSync = new Date().toISOString();
    await writeState(atlcliDir, state);
  }

  if (isSingleFile && files.length === 1) {
    // Single file output
    const result = updated > 0 ? "updated" : created > 0 ? "created" : "skipped";
    output(
      opts.json
        ? { schemaVersion: "1", file: files[0], result }
        : `${basename(files[0])}: ${result}`,
      opts
    );
  } else {
    output(
      {
        schemaVersion: "1",
        results: { updated, created, skipped },
        note: "Frontmatter stripped before push. State saved to .atlcli/",
      },
      opts
    );
  }
}

/**
 * Add a local file to Confluence tracking.
 * Creates the page in Confluence and adds frontmatter to the local file.
 */
async function handleAdd(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const filePath = args[0];
  const templateName = getFlag(flags, "template");

  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "File path is required.");
  }

  // Find .atlcli directory
  const atlcliDir = findAtlcliDir(dirname(filePath));
  if (!atlcliDir) {
    fail(opts, 1, ERROR_CODES.USAGE, "Not in an initialized directory. Run 'docs init' first.");
  }

  const dirConfig = await readConfig(atlcliDir);
  const state = await readState(atlcliDir);
  const client = await getClient(flags, opts);

  // Read file content
  const content = await readTextFile(filePath);
  const { frontmatter: existingFrontmatter, content: rawMarkdownContent } = parseFrontmatter(content);

  // Check if already tracked
  if (existingFrontmatter?.id) {
    fail(opts, 1, ERROR_CODES.USAGE, `File already tracked with page ID: ${existingFrontmatter.id}`);
  }

  // Get title: --title flag > H1 heading > filename
  let title = getFlag(flags, "title");
  if (!title) {
    title = extractTitleFromMarkdown(rawMarkdownContent) ?? undefined;
  }
  if (!title) {
    title = titleFromFilename(filePath);
  }

  // Get parent page ID if specified
  const parentId = getFlag(flags, "parent");

  // Get space (from flag or config)
  const space = getFlag(flags, "space") || dirConfig.space;

  // Apply template if specified
  let markdownContent = rawMarkdownContent;
  let labels: string[] | undefined;

  if (templateName) {
    // Create template resolver
    const globalConfig = await loadConfig();
    const activeProfile = getActiveProfile(globalConfig);

    const global = new GlobalTemplateStorage();
    const profile = activeProfile?.name ? new ProfileTemplateStorage(activeProfile.name) : undefined;
    const spaceStorage = space ? new SpaceTemplateStorage(space, atlcliDir) : undefined;
    const resolver = new TemplateResolver(global, profile, spaceStorage);

    const template = await resolver.resolve(templateName);
    if (!template) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template "${templateName}" not found.`);
    }

    const targetParentId = parentId ?? template.metadata.target?.parent;

    // Parse --var flags
    const variables = parseVarFlags(flags);

    // Apply defaults
    for (const v of template.metadata.variables ?? []) {
      if (!(v.name in variables) && v.default !== undefined) {
        variables[v.name] = v.default;
      }
    }

    // Build builtins context for rendering
    const builtins: Record<string, unknown> = {
      user: activeProfile?.name,
      space,
      profile: activeProfile?.name,
      title,
      parentId: targetParentId,
    };

    // Render template
    const engine = new TemplateEngine();
    const rendered = engine.render(template, { variables, builtins });
    markdownContent = rendered.content;
    labels = template.metadata.labels;
  }

  // Convert to storage format (strip frontmatter if any)
  const storage = markdownToStorage(markdownContent);

  // Create page in Confluence
  const page = await client.createPage({
    spaceKey: space,
    title,
    storage,
    parentId: parentId || dirConfig.settings?.defaultParentId || undefined,
  });

  // Add labels if template specified them
  if (labels && labels.length > 0) {
    await client.addLabels(page.id, labels);
  }

  // Add frontmatter to file
  const frontmatter: AtlcliFrontmatter = {
    id: page.id,
    title: page.title,
  };
  const contentWithFrontmatter = addFrontmatter(markdownContent, frontmatter);
  await writeTextFile(filePath, contentWithFrontmatter);

  // Update state
  const relativePath = getRelativePath(atlcliDir, filePath);
  const normalizedMd = normalizeMarkdown(markdownContent);
  const contentHash = hashContent(normalizedMd);

  // Get ancestors from the created page
  const ancestorIds = page.ancestors?.map((a) => a.id) ?? [];

  updatePageState(state, page.id, {
    path: relativePath,
    title: page.title,
    spaceKey: page.spaceKey ?? space,
    version: page.version ?? 1,
    lastSyncedAt: new Date().toISOString(),
    localHash: contentHash,
    remoteHash: contentHash,
    baseHash: contentHash,
    syncState: "synced",
    parentId: parentId || null,
    ancestors: ancestorIds,
  });

  await writeState(atlcliDir, state);

  // Write base content for 3-way merge
  await writeBaseContent(atlcliDir, page.id, normalizedMd);

  // Log sync event
  getLogger().sync({
    eventType: "push",
    file: relativePath,
    pageId: page.id,
    title: page.title,
    details: { created: true, viaAdd: true },
  });

  output(
    opts.json
      ? { schemaVersion: "1", added: true, pageId: page.id, title: page.title, path: relativePath }
      : `Added ${relativePath} as page "${page.title}" (ID: ${page.id})`,
    opts
  );
}

async function handleWatch(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const dir = args[0] ?? getFlag(flags, "dir") ?? "./docs";
  const space = getFlag(flags, "space");
  const debounceMs = Number(getFlag(flags, "debounce") ?? 500);
  const client = await getClient(flags, opts);

  if (!opts.json) {
    output(`Watching ${dir} for Markdown changes...`, opts);
  } else {
    output({ schemaVersion: "1", status: "watching", dir, debounceMs }, opts);
  }

  const watchers = await createWatchers(dir, (filePath) => {
    if (extname(filePath).toLowerCase() !== ".md") return;
    schedulePush(filePath);
  });

  let timer: NodeJS.Timeout | null = null;
  const queue = new Set<string>();

  function schedulePush(filePath: string): void {
    queue.add(filePath);
    if (timer) return;
    timer = setTimeout(async () => {
      const batch = Array.from(queue);
      queue.clear();
      timer = null;

      for (const file of batch) {
        try {
          const result = await pushFile({ client, filePath: file, space, opts });
          const payload = { schemaVersion: "1", file, result };
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(payload)}\n`);
          } else {
            output(`Updated ${file} (${result})`, opts);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const payload = { schemaVersion: "1", file, result: "error", message };
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(payload)}\n`);
          } else {
            output(`Error updating ${file}: ${message}`, opts);
          }
        }
      }
    }, Number.isNaN(debounceMs) ? 500 : debounceMs);
  }

  process.on("SIGINT", () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    process.exit(0);
  });
}

type PushResult = "updated" | "created" | "skipped";

async function pushFile(params: {
  client: ConfluenceClient;
  filePath: string;
  space?: string;
  opts: OutputOptions;
  atlcliDir?: string;
  state?: AtlcliState;
}): Promise<PushResult> {
  const { client, filePath, space, opts, atlcliDir, state } = params;

  // Read file and parse frontmatter
  const rawContent = await readTextFile(filePath);
  const { frontmatter, content: markdownContent } = parseFrontmatter(rawContent);

  // Also check legacy .meta.json
  const legacyMeta = await readMeta(filePath);

  // Get page ID from frontmatter or legacy meta
  const pageId = frontmatter?.id || legacyMeta?.id;

  // Strip frontmatter before converting to storage format
  const storage = markdownToStorage(markdownContent);

  // Check for attachment references and upload them
  const pageFilename = basename(filePath);
  const pageDir = dirname(filePath);
  const attachmentRefs = extractAttachmentRefs(markdownContent);
  const attachmentsDir = join(pageDir, getAttachmentsDirName(pageFilename));

  if (pageId) {
    // Upload attachments before updating the page
    if (attachmentRefs.length > 0) {
      // Get existing attachments from Confluence
      let existingAttachments: AttachmentInfo[] = [];
      try {
        existingAttachments = await client.listAttachments(pageId);
      } catch {
        // Page might not have any attachments yet
      }
      const existingByName = new Map(existingAttachments.map((a) => [a.filename, a]));

      // Get existing attachment state for change detection
      const existingPageState = state?.pages[pageId];
      const attachmentStates = existingPageState?.attachments || {};

      for (const filename of attachmentRefs) {
        const localPath = join(attachmentsDir, filename);
        try {
          const data = await readFile(localPath);
          const localHash = hashContent(data.toString("base64"));
          const existing = existingByName.get(filename);

          // Warn about large files
          if (data.length >= LARGE_FILE_THRESHOLD && !opts.json) {
            output(`Warning: Large attachment ${filename} (${formatFileSize(data.length)})`, opts);
          }

          // Find attachment state by filename
          const attachmentEntry = Object.values(attachmentStates).find(
            (a) => a.filename === filename
          );

          // Skip upload if unchanged (same hash as base) AND exists on remote
          // If attachment was deleted from Confluence, we need to re-upload
          if (attachmentEntry && localHash === attachmentEntry.baseHash && existing) {
            continue;
          }

          if (existing) {
            // Update existing attachment
            await client.updateAttachment({
              attachmentId: existing.id,
              pageId,
              filename,
              data,
            });

            // Update attachment state after successful upload
            if (state && attachmentEntry) {
              updateAttachmentState(state, pageId, existing.id, {
                localHash,
                remoteHash: localHash,
                baseHash: localHash,
                lastSyncedAt: new Date().toISOString(),
                syncState: "synced",
              });
            }
          } else {
            // Upload new attachment
            const newAttachment = await client.uploadAttachment({
              pageId,
              filename,
              data,
            });

            // Add new attachment to state
            if (state && newAttachment) {
              updateAttachmentState(state, pageId, newAttachment.id, {
                attachmentId: newAttachment.id,
                filename: newAttachment.filename,
                localPath: filename,
                mediaType: newAttachment.mediaType,
                fileSize: newAttachment.fileSize,
                version: newAttachment.version,
                localHash,
                remoteHash: localHash,
                baseHash: localHash,
                lastSyncedAt: new Date().toISOString(),
                syncState: "synced",
              });
            }
          }
        } catch (err) {
          if (!opts.json) {
            output(`Warning: Could not upload attachment ${filename}`, opts);
          }
        }
      }

      // Check for locally deleted attachments (in state but file doesn't exist)
      const pageState = state?.pages[pageId];
      if (state && pageState?.attachments && atlcliDir) {
        const referencedFiles = new Set(attachmentRefs);

        for (const [attId, attState] of Object.entries(pageState.attachments)) {
          const localAttPath = join(attachmentsDir, attState.filename);

          // If file doesn't exist locally AND not referenced in markdown, delete from Confluence
          if (!existsSync(localAttPath) && !referencedFiles.has(attState.filename)) {
            try {
              await client.deleteAttachment(attId);
              removeAttachmentState(state, pageId, attId);
              await deleteAttachmentBase(atlcliDir, pageId, attId, extname(attState.filename));
              if (!opts.json) {
                output(`Deleted ${attState.filename} from Confluence`, opts);
              }
            } catch (err) {
              if (!opts.json) {
                output(`Warning: Could not delete attachment ${attState.filename}`, opts);
              }
            }
          }
        }
      }
    }

    // Update existing page
    const current = await client.getPage(pageId);
    const title = frontmatter?.title || legacyMeta?.title || current.title;
    const version = (current.version ?? 1) + 1;
    const page = await client.updatePage({ id: pageId, title, storage, version });

    // Update state if available
    if (atlcliDir && state) {
      const relativePath = getRelativePath(atlcliDir, filePath);
      const normalizedMd = normalizeMarkdown(markdownContent);
      const contentHash = hashContent(normalizedMd);

      // Preserve ancestors from existing state
      const existingPageState = state.pages[page.id];
      const ancestors = existingPageState?.ancestors ?? [];

      updatePageState(state, page.id, {
        path: relativePath,
        title: page.title,
        spaceKey: page.spaceKey ?? space ?? "",
        version: page.version ?? version,
        lastSyncedAt: new Date().toISOString(),
        localHash: contentHash,
        remoteHash: contentHash,
        baseHash: contentHash,
        syncState: "synced",
        parentId: existingPageState?.parentId ?? null,
        ancestors,
      });

      await writeBaseContent(atlcliDir, page.id, normalizedMd);
    } else {
      // Fall back to legacy meta
      await writeMeta(filePath, {
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey ?? legacyMeta?.spaceKey ?? space,
        version: page.version ?? version,
      });
    }

    // Log sync event
    getLogger().sync({
      eventType: "push",
      file: atlcliDir ? getRelativePath(atlcliDir, filePath) : basename(filePath),
      pageId: page.id,
      title: page.title,
    });

    return "updated";
  }

  // No page ID - skip (use 'docs add' to create new pages)
  const targetSpace = legacyMeta?.spaceKey ?? space;
  if (!targetSpace) {
    return "skipped";
  }

  // For backwards compatibility, still create if legacy meta exists with space
  const title = legacyMeta?.title ?? titleFromFilename(filePath);
  const page = await client.createPage({ spaceKey: targetSpace, title, storage });

  // Upload attachments after creating the page
  if (attachmentRefs.length > 0) {
    for (const filename of attachmentRefs) {
      const localPath = join(attachmentsDir, filename);
      try {
        const data = await readFile(localPath);
        await client.uploadAttachment({
          pageId: page.id,
          filename,
          data,
        });
      } catch (err) {
        if (!opts.json) {
          output(`Warning: Could not upload attachment ${filename}`, opts);
        }
      }
    }
  }

  // Add frontmatter to file
  const newFrontmatter: AtlcliFrontmatter = {
    id: page.id,
    title: page.title,
  };
  const contentWithFrontmatter = addFrontmatter(markdownContent, newFrontmatter);
  await writeTextFile(filePath, contentWithFrontmatter);

  // Update state if available
  if (atlcliDir && state) {
    const relativePath = getRelativePath(atlcliDir, filePath);
    const normalizedMd = normalizeMarkdown(markdownContent);
    const contentHash = hashContent(normalizedMd);

    // Get ancestors from created page
    const ancestorIds = page.ancestors?.map((a) => a.id) ?? [];

    updatePageState(state, page.id, {
      path: relativePath,
      title: page.title,
      spaceKey: page.spaceKey ?? targetSpace,
      version: page.version ?? 1,
      lastSyncedAt: new Date().toISOString(),
      localHash: contentHash,
      remoteHash: contentHash,
      baseHash: contentHash,
      syncState: "synced",
      parentId: page.parentId ?? null,
      ancestors: ancestorIds,
    });

    await writeBaseContent(atlcliDir, page.id, normalizedMd);
  }

  // Log sync event
  getLogger().sync({
    eventType: "push",
    file: atlcliDir ? getRelativePath(atlcliDir, filePath) : basename(filePath),
    pageId: page.id,
    title: page.title,
    details: { created: true },
  });

  return "created";
}

/**
 * Reads metadata from .meta.json file.
 * Supports both legacy and enhanced metadata formats.
 */
async function readMeta(path: string): Promise<EnhancedMeta | LegacyMeta | null> {
  try {
    const raw = await readTextFile(`${path}.meta.json`);
    return JSON.parse(raw) as EnhancedMeta | LegacyMeta;
  } catch {
    return null;
  }
}

/**
 * Writes enhanced metadata to .meta.json file.
 */
async function writeMeta(path: string, meta: EnhancedMeta | LegacyMeta): Promise<void> {
  await writeTextFile(`${path}.meta.json`, JSON.stringify(meta, null, 2));
}

/**
 * Reads base content from .base file (used for three-way merge).
 */
export async function readBase(mdPath: string): Promise<string | null> {
  try {
    return await readTextFile(`${mdPath}.base`);
  } catch {
    return null;
  }
}

/**
 * Writes base content to .base file.
 */
export async function writeBase(mdPath: string, content: string): Promise<void> {
  await writeTextFile(`${mdPath}.base`, content);
}

/**
 * Checks if metadata is in enhanced format (has sync fields).
 */
function isEnhancedMeta(meta: EnhancedMeta | LegacyMeta | null): meta is EnhancedMeta {
  return meta !== null && "syncState" in meta && "localHash" in meta;
}

/**
 * Creates enhanced metadata from current state.
 */
export function createEnhancedMeta(params: {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  localContent: string;
  remoteContent: string;
}): EnhancedMeta {
  const normalizedLocal = normalizeMarkdown(params.localContent);
  const normalizedRemote = normalizeMarkdown(params.remoteContent);
  const localHash = hashContent(normalizedLocal);
  const remoteHash = hashContent(normalizedRemote);

  return {
    id: params.id,
    title: params.title,
    spaceKey: params.spaceKey,
    version: params.version,
    lastSyncedAt: new Date().toISOString(),
    localHash,
    remoteHash,
    baseHash: remoteHash, // Base is remote at sync time
    syncState: "synced",
  };
}

/**
 * Computes the current sync state based on local and remote hashes.
 */
export function computeSyncState(params: {
  localContent: string;
  meta: EnhancedMeta;
  remoteVersion?: number;
  remoteContent?: string;
}): SyncState {
  const { localContent, meta, remoteVersion, remoteContent } = params;

  const normalizedLocal = normalizeMarkdown(localContent);
  const currentLocalHash = hashContent(normalizedLocal);

  // Check if local has changed since last sync
  const localChanged = currentLocalHash !== meta.localHash;

  // Check if remote has changed (by version or content hash)
  let remoteChanged = false;
  if (remoteVersion !== undefined && remoteVersion > meta.version) {
    remoteChanged = true;
  } else if (remoteContent !== undefined) {
    const normalizedRemote = normalizeMarkdown(remoteContent);
    const currentRemoteHash = hashContent(normalizedRemote);
    remoteChanged = currentRemoteHash !== meta.remoteHash;
  }

  if (localChanged && remoteChanged) {
    return "conflict";
  }
  if (localChanged) {
    return "local-modified";
  }
  if (remoteChanged) {
    return "remote-modified";
  }
  return "synced";
}

async function collectMarkdownFiles(
  dir: string,
  options?: { ignore?: Ignore; rootDir?: string }
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  const { ignore: ig, rootDir = dir } = options ?? {};

  for (const entry of entries) {
    // Skip .atlcli directory and other hidden directories
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);

    // Check if path should be ignored
    if (ig) {
      const relativePath = relative(rootDir, fullPath);
      if (shouldIgnore(ig, relativePath)) {
        continue;
      }
    }

    if (entry.isDirectory()) {
      results.push(...(await collectMarkdownFiles(fullPath, { ignore: ig, rootDir })));
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      results.push(fullPath);
    }
  }

  return results;
}

async function createWatchers(dir: string, onChange: (filePath: string) => void): Promise<FSWatcher[]> {
  const watchers: FSWatcher[] = [];
  const dirs = await collectDirs(dir);

  for (const folder of dirs) {
    const watcher = watch(folder, { persistent: true });
    watcher.on("change", (_event, filename) => {
      if (!filename) return;
      const fullPath = join(folder, String(filename));
      onChange(fullPath);
    });
    watchers.push(watcher);
  }

  return watchers;
}

async function collectDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [dir];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(dir, entry.name);
    results.push(...(await collectDirs(fullPath)));
  }

  return results;
}

function parseVarFlags(flags: Record<string, string | boolean | string[]>): Record<string, unknown> {
  const vars: Record<string, unknown> = {};

  // Check for --var.name=value format
  for (const [key, value] of Object.entries(flags)) {
    if (key.startsWith("var.") && typeof value === "string") {
      vars[key.slice(4)] = value;
    }
  }

  // Handle --var key=value (supports multiple --var flags)
  const varFlag = flags["var"];
  const varValues = Array.isArray(varFlag) ? varFlag : typeof varFlag === "string" ? [varFlag] : [];
  for (const v of varValues) {
    const eqIdx = v.indexOf("=");
    if (eqIdx > 0) {
      vars[v.slice(0, eqIdx)] = v.slice(eqIdx + 1);
    }
  }

  return vars;
}

function titleFromFilename(path: string): string {
  const file = basename(path, extname(path));
  const cleaned = file.replace(/^[0-9]+__/, "");
  return cleaned.replace(/[-_]+/g, " ").trim() || "Untitled";
}

/**
 * Show sync status of all tracked files.
 */
async function handleStatus(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const dir = args[0] ?? getFlag(flags, "dir") ?? ".";

  // Check for .atlcli directory
  const atlcliDir = findAtlcliDir(dir);
  const state = atlcliDir ? await readState(atlcliDir) : null;

  // Load ignore patterns and collect files
  const ignoreResult = await loadIgnorePatterns(atlcliDir ?? dir);
  const files = await collectMarkdownFiles(dir, {
    ignore: ignoreResult.ignore,
    rootDir: atlcliDir ?? dir,
  });

  const stats = {
    synced: 0,
    localModified: 0,
    remoteModified: 0,
    conflict: 0,
    untracked: 0,
  };

  const conflicts: { file: string; id?: string }[] = [];
  const modified: { file: string; type: string }[] = [];
  const untracked: string[] = [];

  for (const filePath of files) {
    const relativePath = atlcliDir ? getRelativePath(atlcliDir, filePath) : filePath;

    // Check frontmatter first
    const content = await readTextFile(filePath);
    const { frontmatter, content: markdownContent } = parseFrontmatter(content);

    // Get page state from state.json or legacy meta
    let pageState: PageState | null = null;
    if (state && frontmatter?.id) {
      pageState = getPageById(state, frontmatter.id);
    }

    if (!frontmatter?.id && !pageState) {
      // Check legacy meta
      const legacyMeta = await readMeta(filePath);
      if (legacyMeta?.id) {
        // Legacy tracked file
        stats.synced++;
        continue;
      }
      stats.untracked++;
      untracked.push(relativePath);
      continue;
    }

    if (pageState) {
      // Compute current sync state by comparing hashes
      const normalizedMd = normalizeMarkdown(markdownContent);
      const currentLocalHash = hashContent(normalizedMd);

      let currentState: CoreSyncState;
      if (pageState.syncState === "conflict") {
        currentState = "conflict";
      } else if (currentLocalHash !== pageState.baseHash) {
        currentState = "local-modified";
      } else {
        currentState = pageState.syncState;
      }

      switch (currentState) {
        case "synced":
          stats.synced++;
          break;
        case "local-modified":
          stats.localModified++;
          modified.push({ file: relativePath, type: "local changes" });
          break;
        case "remote-modified":
          stats.remoteModified++;
          modified.push({ file: relativePath, type: "remote changes" });
          break;
        case "conflict":
          stats.conflict++;
          conflicts.push({ file: relativePath, id: frontmatter?.id });
          break;
      }
    } else if (frontmatter?.id) {
      // Has frontmatter but no state - assume synced
      stats.synced++;
    }
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      dir,
      stats,
      conflicts,
      modified,
      untracked,
      lastSync: state?.lastSync,
      ignorePatterns: {
        hasAtlcliIgnore: ignoreResult.hasAtlcliIgnore,
        hasGitIgnore: ignoreResult.hasGitIgnore,
      },
    }, opts);
  } else {
    output(`Sync status for ${dir}:\n`, opts);
    output(`  synced:          ${stats.synced} files`, opts);
    output(`  local-modified:  ${stats.localModified} files`, opts);
    output(`  remote-modified: ${stats.remoteModified} files`, opts);
    output(`  conflict:        ${stats.conflict} files`, opts);
    output(`  untracked:       ${stats.untracked} files`, opts);

    if (state?.lastSync) {
      output(`\nLast sync: ${state.lastSync}`, opts);
    }

    if (modified.length > 0) {
      output(`\nModified:`, opts);
      for (const m of modified) {
        output(`  ${m.file} (${m.type})`, opts);
      }
    }

    if (conflicts.length > 0) {
      output(`\nConflicts:`, opts);
      for (const c of conflicts) {
        output(`  ${c.file}`, opts);
      }
    }

    if (untracked.length > 0 && untracked.length <= 10) {
      output(`\nUntracked:`, opts);
      for (const u of untracked) {
        output(`  ${u}`, opts);
      }
    } else if (untracked.length > 10) {
      output(`\nUntracked: ${untracked.length} files (use --json for full list)`, opts);
    }
  }
}

/**
 * Resolve conflicts in a file.
 */
async function handleResolve(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "File path is required.");
  }

  const accept = getFlag(flags, "accept") as "local" | "remote" | "merged" | undefined;

  const content = await readTextFile(filePath);
  const meta = await readMeta(filePath);

  if (!meta) {
    fail(opts, 1, ERROR_CODES.USAGE, "File is not tracked (no metadata).");
  }

  // Check if file has conflict markers
  const hasMarkers = content.includes("<<<<<<< LOCAL") &&
                     content.includes("=======") &&
                     content.includes(">>>>>>> REMOTE");

  if (!hasMarkers) {
    if (isEnhancedMeta(meta) && meta.syncState === "conflict") {
      // No markers but marked as conflict - might have been manually edited
      output("File was marked as conflict but has no conflict markers.", opts);
    } else {
      output("File has no conflicts to resolve.", opts);
    }
    return;
  }

  if (!accept) {
    fail(opts, 1, ERROR_CODES.USAGE, "Specify --accept local|remote|merged");
  }

  if (accept === "merged") {
    // User should have manually resolved - just verify no markers remain
    fail(opts, 1, ERROR_CODES.USAGE, "For 'merged', edit the file to remove conflict markers first.");
  }

  // Resolve by choosing a side
  const resolved = resolveConflicts(content, accept);
  await writeTextFile(filePath, resolved);

  // Update metadata
  if (isEnhancedMeta(meta)) {
    const updatedMeta: EnhancedMeta = {
      ...meta,
      syncState: "local-modified",
      localHash: hashContent(normalizeMarkdown(resolved)),
    };
    await writeMeta(filePath, updatedMeta);
  }

  output(`Resolved conflicts in ${filePath} using ${accept} version.`, opts);
  output("Run 'atlcli wiki docs push' to push the resolved version.", opts);
}

async function handleDocsDiff(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "File path is required. Usage: atlcli wiki docs diff <file>");
  }

  // Check if file exists and read it
  let localContent: string;
  try {
    localContent = await readTextFile(filePath);
  } catch {
    fail(opts, 1, ERROR_CODES.USAGE, `File not found: ${filePath}`);
  }

  // Parse frontmatter to get page ID
  const { frontmatter, content: localMarkdown } = parseFrontmatter(localContent);

  if (!frontmatter?.id) {
    fail(opts, 1, ERROR_CODES.USAGE, "File has no page ID in frontmatter. Is it tracked?");
  }

  const pageId = frontmatter.id;
  const client = await getClient(flags, opts);

  // Fetch remote page
  const remotePage = await client.getPage(pageId);
  const remoteMarkdown = storageToMarkdown(remotePage.storage);

  // Generate diff
  const diff = generateDiff(remoteMarkdown, localMarkdown, {
    oldLabel: `Remote (v${remotePage.version})`,
    newLabel: "Local",
    context: 3,
  });

  if (opts.json) {
    output({
      schemaVersion: "1",
      file: filePath,
      pageId,
      title: remotePage.title,
      remoteVersion: remotePage.version,
      hasChanges: diff.hasChanges,
      additions: diff.additions,
      deletions: diff.deletions,
      unified: diff.unified,
    }, opts);
    return;
  }

  if (!diff.hasChanges) {
    output(`No changes between local file and remote page (v${remotePage.version}).`, opts);
    return;
  }

  // Output colored diff
  output(`\nDiff for "${remotePage.title}"`, opts);
  output(`Comparing Remote (v${remotePage.version}) ↔ Local`, opts);
  output(`${formatDiffSummary(diff)}\n`, opts);
  output(formatDiffWithColors(diff), opts);
}

async function handleCheck(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const targetPath = args[0] || ".";
  const strict = hasFlag(flags, "strict");

  // Resolve to absolute path
  const absPath = resolve(targetPath);

  // Find .atlcli directory if it exists
  const atlcliDir = findAtlcliDir(absPath);
  let state: AtlcliState | null = null;

  if (atlcliDir) {
    try {
      state = await readState(atlcliDir);
    } catch {
      // No state file, continue without it
    }
  }

  // Run validation
  const result = await validateDirectory(absPath, state, atlcliDir, {
    checkBrokenLinks: true,
    checkMacroSyntax: true,
    checkPageSize: true,
    maxPageSizeKb: 500,
  });

  // JSON output
  if (opts.json) {
    output({
      schemaVersion: "1",
      passed: result.passed,
      totalErrors: result.totalErrors,
      totalWarnings: result.totalWarnings,
      filesChecked: result.filesChecked,
      filesWithIssues: result.files.filter((f) => f.issues.length > 0).length,
      files: result.files.filter((f) => f.issues.length > 0).map((f) => ({
        path: f.path,
        issues: f.issues,
      })),
    }, opts);
  } else {
    // Human-readable output
    output(formatValidationReport(result), opts);
  }

  // Exit with error if validation failed
  if (!result.passed) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed");
  }

  // Exit with error in strict mode if there are warnings
  if (strict && result.totalWarnings > 0) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed (strict mode: warnings are errors)");
  }
}

function docsHelp(): string {
  return `atlcli wiki docs <command>

Commands:
  init <dir> [scope options]                        Initialize directory for sync
  pull [dir] [scope options] [--limit <n>] [--force] [--label <l>] [--comments]
  push [dir|file] [--page-id <id>] [--validate]     Push changes to Confluence
  add <file> [--title <t>] [--parent <id>]          Add file to Confluence
  watch <dir> [--space <key>] [--debounce <ms>]
  sync <dir> [scope options] [--poll-interval <ms>] [--label <label>]
  status [dir]                                       Show sync state
  resolve <file> --accept local|remote|merged        Resolve conflicts
  diff <file>                                        Compare local vs remote
  check [path] [--strict] [--json]                   Validate markdown files

Scope options (one required for init/pull/sync):
  --page-id <id>     Single page by ID
  --ancestor <id>    Page tree under parent ID
  --space <key>      Entire space

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output (watch/sync emit JSON lines)
  --force            Overwrite local modifications
  --label <label>    Only sync pages with this label
  --comments         Pull page comments to .comments.json files
  --no-attachments   Skip downloading attachments
  --validate         Run validation before push (fail on errors)
  --strict           Treat warnings as errors (for check and --validate)

Files use YAML frontmatter for page ID. Directory structure matches Confluence hierarchy.
State is stored in .atlcli/ directory.

Ignore patterns:
  Create .atlcliignore (gitignore syntax) to exclude files from push/status.
  Patterns from .gitignore are also respected (merged with .atlcliignore).

Validation checks:
  - Broken links (target file not found)
  - Links to untracked pages (warning)
  - Unclosed macros (:::info without :::)
  - Page size exceeding 500KB (warning)

Examples:
  atlcli wiki docs init ./docs --space TEAM              Initialize for entire space
  atlcli wiki docs init ./docs --ancestor 12345          Initialize for page tree
  atlcli wiki docs init ./docs --page-id 67890           Initialize for single page
  atlcli wiki docs pull ./docs                           Pull using saved scope
  atlcli wiki docs pull ./docs --ancestor 99999          Override scope for this pull
  atlcli wiki docs pull ./docs --label architecture      Pull only pages with label
  atlcli wiki docs pull ./docs --comments                Pull pages with comments
  atlcli wiki docs push ./docs                           Push all tracked files
  atlcli wiki docs push ./docs/page.md                   Push single file
  atlcli wiki docs push --page-id 12345                  Push by page ID
  atlcli wiki docs push --validate                       Validate before pushing
  atlcli wiki docs push --validate --strict              Fail on warnings too
  atlcli wiki docs diff ./docs/page.md                   Show local vs remote diff
  atlcli wiki docs check ./docs                          Check for broken links
  atlcli wiki docs check ./docs --strict                 Treat warnings as errors
  atlcli wiki docs check ./docs --json                   JSON output for CI/agents

For sync command options: atlcli wiki docs sync --help
`;
}
