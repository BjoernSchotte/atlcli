import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  readTextFile,
} from "@atlcli/core";
import {
  ConfluenceClient,
  markdownToStorage,
  storageToMarkdown,
  generateDiff,
  formatDiffWithColors,
  formatDiffSummary,
  commentBodyToText,
  FooterComment,
  InlineComment,
  getTemplate,
  renderTemplate,
  createBuiltins,
  findAtlcliDir,
} from "@atlcli/confluence";
import type { TemplateContext } from "@atlcli/confluence";

export async function handlePage(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "get":
      await handleGet(flags, opts);
      return;
    case "list":
      await handleList(flags, opts);
      return;
    case "create":
      await handleCreate(flags, opts);
      return;
    case "update":
      await handleUpdate(flags, opts);
      return;
    case "label":
      await handleLabel(args.slice(1), flags, opts);
      return;
    case "history":
      await handleHistory(flags, opts);
      return;
    case "diff":
      await handleDiff(flags, opts);
      return;
    case "restore":
      await handleRestore(flags, opts);
      return;
    case "comments":
      await handleComments(args.slice(1), flags, opts);
      return;
    case "move":
      await handleMove(flags, opts);
      return;
    case "copy":
      await handleCopy(flags, opts);
      return;
    case "children":
      await handleChildren(flags, opts);
      return;
    case "delete":
      await handleDelete(flags, opts);
      return;
    case "archive":
      await handleArchive(flags, opts);
      return;
    default:
      output(pageHelp(), opts);
      return;
  }
}

async function getClient(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<ConfluenceClient> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`." , { profile: profileName });
  }
  return new ConfluenceClient(profile);
}

async function handleGet(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  const client = await getClient(flags, opts);
  const page = await client.getPage(id);
  output({ schemaVersion: "1", page }, opts);
}

async function handleList(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const label = getFlag(flags, "label");
  const space = getFlag(flags, "space");
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const client = await getClient(flags, opts);

  // If --label is provided, use getPagesByLabel
  if (label) {
    const pages = await client.getPagesByLabel(label, {
      spaceKey: space,
      limit: Number.isNaN(limit) ? 25 : limit,
    });
    output({
      schemaVersion: "1",
      label,
      space: space ?? null,
      pages: pages.map((p) => ({
        id: p.id,
        title: p.title,
        spaceKey: p.spaceKey,
      })),
    }, opts);
    return;
  }

  // Otherwise use CQL search
  const cql = getFlag(flags, "cql") ?? "type=page";
  const pages = await client.searchPages(cql, Number.isNaN(limit) ? 25 : limit);
  output({ schemaVersion: "1", pages }, opts);
}

async function handleCreate(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const space = getFlag(flags, "space");
  const title = getFlag(flags, "title");
  const bodyPath = getFlag(flags, "body");
  const templateName = getFlag(flags, "template");
  const dryRun = hasFlag(flags, "dry-run");
  const parentId = getFlag(flags, "parent");

  // Template mode
  if (templateName) {
    if (!title) {
      fail(opts, 1, ERROR_CODES.USAGE, "--title is required when using --template.");
    }

    const atlcliDir = await findAtlcliDir(process.cwd());
    const template = getTemplate(templateName, atlcliDir ?? undefined);

    if (!template) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template "${templateName}" not found.`);
    }

    const spaceKey = space ?? template.metadata.target?.space;
    if (!spaceKey) {
      fail(opts, 1, ERROR_CODES.USAGE, "--space is required (or set in template target).");
    }

    // Parse --var flags
    const variables = parseVarFlags(flags);

    // Apply defaults
    for (const v of template.metadata.variables ?? []) {
      if (!(v.name in variables) && v.default !== undefined) {
        variables[v.name] = v.default;
      }
    }

    const builtins = createBuiltins({
      title,
      spaceKey,
      parentId: parentId ?? template.metadata.target?.parent,
    });

    const context: TemplateContext = {
      variables,
      builtins,
      spaceKey,
      parentId: parentId ?? template.metadata.target?.parent,
      title,
    };

    const rendered = renderTemplate(template, context);

    if (dryRun) {
      output({
        schemaVersion: "1",
        dryRun: true,
        rendered,
      }, opts);
      return;
    }

    const client = await getClient(flags, opts);
    const storage = markdownToStorage(rendered.markdown);
    const page = await client.createPage({
      spaceKey: rendered.spaceKey,
      title: rendered.title,
      storage,
      parentId: rendered.parentId,
    });

    // Add labels if specified
    if (rendered.labels && rendered.labels.length > 0) {
      await client.addLabels(page.id, rendered.labels);
    }

    output({ schemaVersion: "1", page }, opts);
    return;
  }

  // Body mode (original behavior)
  if (!space || !title || !bodyPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--space, --title, and --body are required.");
  }
  const client = await getClient(flags, opts);
  const markdown = await readTextFile(bodyPath);
  const storage = markdownToStorage(markdown);
  const page = await client.createPage({ spaceKey: space, title, storage, parentId });
  output({ schemaVersion: "1", page }, opts);
}

function parseVarFlags(flags: Record<string, string | boolean>): Record<string, unknown> {
  const vars: Record<string, unknown> = {};

  // Check for --var key=value format
  for (const [key, value] of Object.entries(flags)) {
    if (key.startsWith("var.") && typeof value === "string") {
      vars[key.slice(4)] = value;
    }
  }

  // Also handle --var key=value as a single flag
  const varFlag = flags["var"];
  if (typeof varFlag === "string") {
    const eqIdx = varFlag.indexOf("=");
    if (eqIdx > 0) {
      vars[varFlag.slice(0, eqIdx)] = varFlag.slice(eqIdx + 1);
    }
  }

  return vars;
}

async function handleUpdate(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const bodyPath = getFlag(flags, "body");
  if (!id || !bodyPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id and --body are required.");
  }
  const client = await getClient(flags, opts);
  const current = await client.getPage(id);
  const title = getFlag(flags, "title") ?? current.title;
  const markdown = await readTextFile(bodyPath);
  const storage = markdownToStorage(markdown);
  const version = (current.version ?? 1) + 1;
  const page = await client.updatePage({ id, title, storage, version });
  output({ schemaVersion: "1", page }, opts);
}

// ============ Label Operations ============

async function handleLabel(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const action = args[0];
  switch (action) {
    case "add":
      await handleLabelAdd(args.slice(1), flags, opts);
      return;
    case "remove":
      await handleLabelRemove(args.slice(1), flags, opts);
      return;
    case "list":
      await handleLabelList(flags, opts);
      return;
    default:
      output(labelHelp(), opts);
      return;
  }
}

async function handleLabelAdd(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const cql = getFlag(flags, "cql");
  const confirm = hasFlag(flags, "confirm");
  const dryRun = hasFlag(flags, "dry-run");

  if (!id && !cql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id or --cql is required.");
  }

  // Labels can be passed as positional args or comma-separated
  const labels = args.length > 0
    ? args.flatMap((arg) => arg.split(",").map((l) => l.trim()).filter(Boolean))
    : [];

  if (labels.length === 0) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one label is required. Usage: atlcli page label add <label> [<label>...] --id <id>");
  }

  const client = await getClient(flags, opts);

  // Single page add (existing behavior)
  if (id) {
    const result = await client.addLabels(id, labels);
    output({
      schemaVersion: "1",
      pageId: id,
      added: labels,
      labels: result.map((l) => l.name),
    }, opts);
    return;
  }

  // Bulk add via CQL
  if (!confirm && !dryRun) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm or --dry-run required for bulk operations.");
  }

  const results = await client.search(cql!, { limit: 1000, detail: "minimal" });

  if (results.results.length === 0) {
    output("No pages match the CQL query.", opts);
    return;
  }

  if (dryRun) {
    if (opts.json) {
      output({
        schemaVersion: "1",
        dryRun: true,
        labels,
        count: results.results.length,
        pages: results.results.map((p) => ({ id: p.id, title: p.title })),
      }, opts);
      return;
    }

    output(`Would add labels [${labels.join(", ")}] to ${results.results.length} pages:`, opts);
    for (const page of results.results.slice(0, 10)) {
      output(`  - ${page.title} (${page.id})`, opts);
    }
    if (results.results.length > 10) {
      output(`  ... and ${results.results.length - 10} more`, opts);
    }
    return;
  }

  // Execute bulk label add
  const pageIds = results.results.map((p) => p.id);
  const result = await client.bulkOperation(pageIds, (pageId) => client.addLabels(pageId, labels), {
    onProgress: (done, total) => {
      if (!opts.json) {
        process.stderr.write(`\rAdding labels... ${done}/${total}`);
      }
    },
  });

  if (!opts.json) {
    process.stderr.write("\r" + " ".repeat(40) + "\r"); // Clear progress line
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      labels,
      total: result.total,
      successful: result.successful,
      failed: result.failed,
      errors: result.errors,
    }, opts);
    return;
  }

  output(`Added labels [${labels.join(", ")}]: ${result.successful}/${result.total}`, opts);
  if (result.failed > 0) {
    output(`Failed: ${result.failed}`, opts);
    for (const err of result.errors.slice(0, 5)) {
      output(`  - ${err.pageId}: ${err.error}`, opts);
    }
  }
}

async function handleLabelRemove(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const cql = getFlag(flags, "cql");
  const confirm = hasFlag(flags, "confirm");
  const dryRun = hasFlag(flags, "dry-run");
  const label = args[0];

  if (!id && !cql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id or --cql is required.");
  }
  if (!label) {
    fail(opts, 1, ERROR_CODES.USAGE, "Label name is required. Usage: atlcli page label remove <label> --id <id>");
  }

  const client = await getClient(flags, opts);

  // Single page remove (existing behavior)
  if (id) {
    await client.removeLabel(id, label);

    // Fetch remaining labels
    const remaining = await client.getLabels(id);
    output({
      schemaVersion: "1",
      pageId: id,
      removed: label,
      labels: remaining.map((l) => l.name),
    }, opts);
    return;
  }

  // Bulk remove via CQL
  if (!confirm && !dryRun) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm or --dry-run required for bulk operations.");
  }

  const results = await client.search(cql!, { limit: 1000, detail: "minimal" });

  if (results.results.length === 0) {
    output("No pages match the CQL query.", opts);
    return;
  }

  if (dryRun) {
    if (opts.json) {
      output({
        schemaVersion: "1",
        dryRun: true,
        label,
        count: results.results.length,
        pages: results.results.map((p) => ({ id: p.id, title: p.title })),
      }, opts);
      return;
    }

    output(`Would remove label "${label}" from ${results.results.length} pages:`, opts);
    for (const page of results.results.slice(0, 10)) {
      output(`  - ${page.title} (${page.id})`, opts);
    }
    if (results.results.length > 10) {
      output(`  ... and ${results.results.length - 10} more`, opts);
    }
    return;
  }

  // Execute bulk label remove
  const pageIds = results.results.map((p) => p.id);
  const result = await client.bulkOperation(pageIds, (pageId) => client.removeLabel(pageId, label), {
    onProgress: (done, total) => {
      if (!opts.json) {
        process.stderr.write(`\rRemoving label... ${done}/${total}`);
      }
    },
  });

  if (!opts.json) {
    process.stderr.write("\r" + " ".repeat(40) + "\r"); // Clear progress line
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      label,
      total: result.total,
      successful: result.successful,
      failed: result.failed,
      errors: result.errors,
    }, opts);
    return;
  }

  output(`Removed label "${label}": ${result.successful}/${result.total}`, opts);
  if (result.failed > 0) {
    output(`Failed: ${result.failed}`, opts);
    for (const err of result.errors.slice(0, 5)) {
      output(`  - ${err.pageId}: ${err.error}`, opts);
    }
  }
}

async function handleLabelList(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const labels = await client.getLabels(id);
  output({
    schemaVersion: "1",
    pageId: id,
    labels: labels.map((l) => l.name),
  }, opts);
}

// ============ History Operations ============

async function handleHistory(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const limit = Number(getFlag(flags, "limit") ?? 10);
  const client = await getClient(flags, opts);
  const history = await client.getPageHistory(id, { limit: Number.isNaN(limit) ? 10 : limit });

  if (opts.json) {
    output({ schemaVersion: "1", ...history }, opts);
    return;
  }

  // Format table output
  const page = await client.getPage(id);
  output(`\nVersion history for "${page.title}" (${history.versions.length} versions):\n`, opts);

  // Header
  output(
    `${"Version".padEnd(8)} ${"Date".padEnd(20)} ${"Author".padEnd(20)} Message`,
    opts
  );
  output("─".repeat(70), opts);

  for (const v of history.versions) {
    const date = new Date(v.when).toLocaleString();
    const author = v.by.displayName.slice(0, 18);
    const message = v.message?.slice(0, 25) || "";
    output(
      `${String(v.number).padEnd(8)} ${date.padEnd(20)} ${author.padEnd(20)} ${message}`,
      opts
    );
  }
}

async function handleDiff(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const versionStr = getFlag(flags, "version");
  const client = await getClient(flags, opts);

  // Get current page
  const current = await client.getPage(id);
  const currentMarkdown = storageToMarkdown(current.storage);

  // Determine which version to compare against
  let compareVersion: number;
  if (versionStr) {
    compareVersion = Number(versionStr);
    if (Number.isNaN(compareVersion) || compareVersion < 1) {
      fail(opts, 1, ERROR_CODES.USAGE, "--version must be a positive number.");
    }
  } else {
    // Default to previous version
    compareVersion = (current.version ?? 2) - 1;
    if (compareVersion < 1) {
      output("No previous version to compare against.", opts);
      return;
    }
  }

  // Get the comparison version
  const oldPage = await client.getPageAtVersion(id, compareVersion);
  const oldMarkdown = storageToMarkdown(oldPage.storage);

  // Generate diff
  const diff = generateDiff(oldMarkdown, currentMarkdown, {
    oldLabel: `Version ${compareVersion}`,
    newLabel: `Version ${current.version} (current)`,
    context: 3,
  });

  if (opts.json) {
    output({
      schemaVersion: "1",
      pageId: id,
      title: current.title,
      oldVersion: compareVersion,
      newVersion: current.version,
      hasChanges: diff.hasChanges,
      additions: diff.additions,
      deletions: diff.deletions,
      unified: diff.unified,
    }, opts);
    return;
  }

  if (!diff.hasChanges) {
    output(`No changes between version ${compareVersion} and version ${current.version}.`, opts);
    return;
  }

  // Output colored diff
  output(`\nDiff for "${current.title}"`, opts);
  output(`Comparing version ${compareVersion} → ${current.version}`, opts);
  output(`${formatDiffSummary(diff)}\n`, opts);
  output(formatDiffWithColors(diff), opts);
}

async function handleRestore(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const versionStr = getFlag(flags, "version");
  const confirm = hasFlag(flags, "confirm");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  if (!versionStr) {
    fail(opts, 1, ERROR_CODES.USAGE, "--version is required.");
  }

  const version = Number(versionStr);
  if (Number.isNaN(version) || version < 1) {
    fail(opts, 1, ERROR_CODES.USAGE, "--version must be a positive number.");
  }

  if (!confirm) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      "Restore requires --confirm flag. This will create a new version with the content from the specified version."
    );
  }

  const client = await getClient(flags, opts);

  // Get page info for output
  const current = await client.getPage(id);

  // Restore
  const result = await client.restorePageVersion(id, version);

  if (opts.json) {
    output({
      schemaVersion: "1",
      pageId: id,
      title: current.title,
      restoredFrom: version,
      newVersion: result.version,
    }, opts);
    return;
  }

  output(`Restored page "${current.title}" to version ${version}.`, opts);
  output(`New version: ${result.version}`, opts);
}

// ============ Comments Operations ============

async function handleComments(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "add":
      await handleCommentsAdd(args.slice(1), flags, opts);
      return;
    case "reply":
      await handleCommentsReply(args.slice(1), flags, opts);
      return;
    case "add-inline":
      await handleCommentsAddInline(args.slice(1), flags, opts);
      return;
    case "resolve":
      await handleCommentsResolve(flags, opts);
      return;
    case "delete":
      await handleCommentsDelete(flags, opts);
      return;
    case "list":
    default:
      // Default to list if no subcommand or "list"
      await handleCommentsList(flags, opts);
      return;
  }
}

async function handleCommentsList(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const comments = await client.getAllComments(id);

  if (opts.json) {
    output({ schemaVersion: "1", ...comments }, opts);
    return;
  }

  // Get page title for display
  const page = await client.getPage(id);
  const footerCount = comments.footerComments.length;
  const inlineCount = comments.inlineComments.length;

  if (footerCount === 0 && inlineCount === 0) {
    output(`No comments on "${page.title}"`, opts);
    output(commentsHelp(), opts);
    return;
  }

  output(`\nComments on "${page.title}"`, opts);
  output("─".repeat(60), opts);

  // Footer comments
  if (footerCount > 0) {
    output(`\nPage Comments (${footerCount}):`, opts);
    for (const comment of comments.footerComments) {
      formatCommentForDisplay(comment, opts, 0);
    }
  }

  // Inline comments
  if (inlineCount > 0) {
    output(`\nInline Comments (${inlineCount}):`, opts);
    for (const comment of comments.inlineComments) {
      formatInlineCommentForDisplay(comment, opts, 0);
    }
  }
}

async function handleCommentsAdd(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  // Get comment text from args or --file
  const filePath = getFlag(flags, "file");
  let commentText: string;

  if (filePath) {
    commentText = await readTextFile(filePath);
  } else if (args.length > 0) {
    commentText = args.join(" ");
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "Comment text is required. Usage: atlcli page comments add --id <id> <text>");
  }

  if (!commentText.trim()) {
    fail(opts, 1, ERROR_CODES.USAGE, "Comment text cannot be empty.");
  }

  // Convert markdown to storage format
  const storageBody = markdownToStorage(commentText);

  const client = await getClient(flags, opts);
  const comment = await client.createFooterComment({
    pageId: id,
    body: storageBody,
  });

  if (opts.json) {
    output({ schemaVersion: "1", comment }, opts);
    return;
  }

  output(`Created comment ${comment.id}`, opts);
}

async function handleCommentsReply(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const parentId = getFlag(flags, "parent");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  if (!parentId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--parent <commentId> is required.");
  }

  // Get reply text from args or --file
  const filePath = getFlag(flags, "file");
  let replyText: string;

  if (filePath) {
    replyText = await readTextFile(filePath);
  } else if (args.length > 0) {
    replyText = args.join(" ");
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "Reply text is required. Usage: atlcli page comments reply --id <id> --parent <commentId> <text>");
  }

  if (!replyText.trim()) {
    fail(opts, 1, ERROR_CODES.USAGE, "Reply text cannot be empty.");
  }

  // Convert markdown to storage format
  const storageBody = markdownToStorage(replyText);

  const client = await getClient(flags, opts);
  const comment = await client.createFooterComment({
    pageId: id,
    body: storageBody,
    parentCommentId: parentId,
  });

  if (opts.json) {
    output({ schemaVersion: "1", comment }, opts);
    return;
  }

  output(`Created reply ${comment.id} to comment ${parentId}`, opts);
}

async function handleCommentsAddInline(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const selection = getFlag(flags, "selection");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  if (!selection) {
    fail(opts, 1, ERROR_CODES.USAGE, "--selection <text> is required.");
  }

  // Get comment text from args or --file
  const filePath = getFlag(flags, "file");
  let commentText: string;

  if (filePath) {
    commentText = await readTextFile(filePath);
  } else if (args.length > 0) {
    commentText = args.join(" ");
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "Comment text is required. Usage: atlcli page comments add-inline --id <id> --selection <text> <comment>");
  }

  if (!commentText.trim()) {
    fail(opts, 1, ERROR_CODES.USAGE, "Comment text cannot be empty.");
  }

  // Parse match index if provided
  const matchIndexStr = getFlag(flags, "match-index");
  const matchIndex = matchIndexStr ? parseInt(matchIndexStr, 10) : 0;

  // Convert markdown to storage format
  const storageBody = markdownToStorage(commentText);

  const client = await getClient(flags, opts);
  const comment = await client.createInlineComment({
    pageId: id,
    body: storageBody,
    textSelection: selection,
    textSelectionMatchIndex: matchIndex,
  });

  if (opts.json) {
    output({ schemaVersion: "1", comment }, opts);
    return;
  }

  output(`Created inline comment ${comment.id} on "${selection}"`, opts);
}

async function handleCommentsResolve(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const commentId = getFlag(flags, "comment");
  const type = (getFlag(flags, "type") || "footer") as "footer" | "inline";

  if (!commentId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--comment <id> is required.");
  }

  const client = await getClient(flags, opts);
  await client.resolveComment(commentId, type);

  if (opts.json) {
    output({ schemaVersion: "1", resolved: commentId, type }, opts);
    return;
  }

  output(`Resolved ${type} comment ${commentId}`, opts);
}

async function handleCommentsDelete(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const commentId = getFlag(flags, "comment");
  const type = (getFlag(flags, "type") || "footer") as "footer" | "inline";
  const confirm = hasFlag(flags, "confirm");

  if (!commentId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--comment <id> is required.");
  }

  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a comment.");
  }

  const client = await getClient(flags, opts);
  await client.deleteComment(commentId, type);

  if (opts.json) {
    output({ schemaVersion: "1", deleted: commentId, type }, opts);
    return;
  }

  output(`Deleted ${type} comment ${commentId}`, opts);
}

function formatCommentForDisplay(
  comment: FooterComment,
  opts: OutputOptions,
  indent: number
): void {
  const prefix = "  ".repeat(indent);
  const author = comment.author.displayName;
  const date = new Date(comment.created).toLocaleDateString();
  const status = comment.status === "resolved" ? " [resolved]" : "";
  const body = commentBodyToText(comment.body);

  output(`${prefix}• ${author} (${date})${status}`, opts);
  output(`${prefix}  ${body}`, opts);

  for (const reply of comment.replies) {
    formatCommentForDisplay(reply, opts, indent + 1);
  }
}

function formatInlineCommentForDisplay(
  comment: InlineComment,
  opts: OutputOptions,
  indent: number
): void {
  const prefix = "  ".repeat(indent);
  const author = comment.author.displayName;
  const date = new Date(comment.created).toLocaleDateString();
  const status = comment.status === "resolved" ? " [resolved]" : "";
  const body = commentBodyToText(comment.body);
  const selection = comment.textSelection ? `"${comment.textSelection}"` : "(no selection)";

  if (indent === 0) {
    output(`${prefix}• On: ${selection}`, opts);
  }
  output(`${prefix}  ${author} (${date})${status}: ${body}`, opts);

  for (const reply of comment.replies) {
    formatInlineCommentForDisplay(reply, opts, indent + 1);
  }
}

// ============ Page Tree Operations ============

async function handleMove(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const parentId = getFlag(flags, "parent");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  if (!parentId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--parent is required.");
  }

  const client = await getClient(flags, opts);
  const page = await client.movePage(id, parentId);

  if (opts.json) {
    output({ schemaVersion: "1", moved: true, page }, opts);
    return;
  }

  output(`Moved "${page.title}" to new parent ${parentId}`, opts);
}

async function handleCopy(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const space = getFlag(flags, "space");
  const title = getFlag(flags, "title");
  const parentId = getFlag(flags, "parent");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const page = await client.copyPage({
    sourceId: id,
    targetSpaceKey: space,
    newTitle: title,
    parentId,
  });

  if (opts.json) {
    output({ schemaVersion: "1", copied: true, page }, opts);
    return;
  }

  output(`Created copy "${page.title}" (id: ${page.id})`, opts);
}

async function handleChildren(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const limit = Number(getFlag(flags, "limit") ?? 100);

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const children = await client.getChildren(id, { limit: Number.isNaN(limit) ? 100 : limit });

  if (opts.json) {
    output({ schemaVersion: "1", parentId: id, children }, opts);
    return;
  }

  if (children.length === 0) {
    output("No child pages found.", opts);
    return;
  }

  output(`Child pages (${children.length}):`, opts);
  for (const child of children) {
    output(`  ${child.id}  ${child.title}`, opts);
  }
}

// ============ Bulk Operations ============

async function handleDelete(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const cql = getFlag(flags, "cql");
  const confirm = hasFlag(flags, "confirm");
  const dryRun = hasFlag(flags, "dry-run");

  if (!id && !cql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id or --cql is required.");
  }

  if (!confirm && !dryRun) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm or --dry-run is required for delete.");
  }

  const client = await getClient(flags, opts);

  // Single page delete
  if (id) {
    const page = await client.getPage(id);

    if (dryRun) {
      output(`Would delete: "${page.title}" (${id})`, opts);
      if (opts.json) {
        output({ schemaVersion: "1", dryRun: true, pages: [{ id, title: page.title }] }, opts);
      }
      return;
    }

    await client.deletePage(id);

    if (opts.json) {
      output({ schemaVersion: "1", deleted: [{ id, title: page.title }] }, opts);
      return;
    }

    output(`Deleted page "${page.title}" (${id})`, opts);
    return;
  }

  // Bulk delete via CQL
  const results = await client.search(cql!, { limit: 1000, detail: "minimal" });

  if (results.results.length === 0) {
    output("No pages match the CQL query.", opts);
    return;
  }

  if (dryRun) {
    if (opts.json) {
      output({
        schemaVersion: "1",
        dryRun: true,
        count: results.results.length,
        pages: results.results.map((p) => ({ id: p.id, title: p.title })),
      }, opts);
      return;
    }

    output(`Would delete ${results.results.length} pages:`, opts);
    for (const page of results.results.slice(0, 10)) {
      output(`  - ${page.title} (${page.id})`, opts);
    }
    if (results.results.length > 10) {
      output(`  ... and ${results.results.length - 10} more`, opts);
    }
    return;
  }

  // Execute bulk delete
  const pageIds = results.results.map((p) => p.id);
  const result = await client.bulkOperation(pageIds, (pageId) => client.deletePage(pageId), {
    onProgress: (done, total) => {
      if (!opts.json) {
        process.stderr.write(`\rDeleting... ${done}/${total}`);
      }
    },
  });

  if (!opts.json) {
    process.stderr.write("\r" + " ".repeat(30) + "\r"); // Clear progress line
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      total: result.total,
      successful: result.successful,
      failed: result.failed,
      errors: result.errors,
    }, opts);
    return;
  }

  output(`Deleted: ${result.successful}/${result.total}`, opts);
  if (result.failed > 0) {
    output(`Failed: ${result.failed}`, opts);
    for (const err of result.errors.slice(0, 5)) {
      output(`  - ${err.pageId}: ${err.error}`, opts);
    }
  }
}

async function handleArchive(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const cql = getFlag(flags, "cql");
  const confirm = hasFlag(flags, "confirm");
  const dryRun = hasFlag(flags, "dry-run");

  if (!id && !cql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id or --cql is required.");
  }

  if (!confirm && !dryRun) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm or --dry-run is required for archive.");
  }

  const client = await getClient(flags, opts);

  // Single page archive
  if (id) {
    const page = await client.getPage(id);

    if (dryRun) {
      output(`Would archive: "${page.title}" (${id})`, opts);
      if (opts.json) {
        output({ schemaVersion: "1", dryRun: true, pages: [{ id, title: page.title }] }, opts);
      }
      return;
    }

    const archived = await client.archivePage(id);

    if (opts.json) {
      output({ schemaVersion: "1", archived: [{ id, title: archived.title }] }, opts);
      return;
    }

    output(`Archived page "${archived.title}" (${id})`, opts);
    return;
  }

  // Bulk archive via CQL
  const results = await client.search(cql!, { limit: 1000, detail: "minimal" });

  if (results.results.length === 0) {
    output("No pages match the CQL query.", opts);
    return;
  }

  if (dryRun) {
    if (opts.json) {
      output({
        schemaVersion: "1",
        dryRun: true,
        count: results.results.length,
        pages: results.results.map((p) => ({ id: p.id, title: p.title })),
      }, opts);
      return;
    }

    output(`Would archive ${results.results.length} pages:`, opts);
    for (const page of results.results.slice(0, 10)) {
      output(`  - ${page.title} (${page.id})`, opts);
    }
    if (results.results.length > 10) {
      output(`  ... and ${results.results.length - 10} more`, opts);
    }
    return;
  }

  // Execute bulk archive
  const pageIds = results.results.map((p) => p.id);
  const result = await client.bulkOperation(pageIds, (pageId) => client.archivePage(pageId), {
    onProgress: (done, total) => {
      if (!opts.json) {
        process.stderr.write(`\rArchiving... ${done}/${total}`);
      }
    },
  });

  if (!opts.json) {
    process.stderr.write("\r" + " ".repeat(30) + "\r"); // Clear progress line
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      total: result.total,
      successful: result.successful,
      failed: result.failed,
      errors: result.errors,
    }, opts);
    return;
  }

  output(`Archived: ${result.successful}/${result.total}`, opts);
  if (result.failed > 0) {
    output(`Failed: ${result.failed}`, opts);
    for (const err of result.errors.slice(0, 5)) {
      output(`  - ${err.pageId}: ${err.error}`, opts);
    }
  }
}

function commentsHelp(): string {
  return `
atlcli page comments <command>

Commands:
  list --id <id>                         List all comments (default)
  add --id <id> <text>                   Add a footer comment
  reply --id <id> --parent <cid> <text>  Reply to a comment
  add-inline --id <id> --selection <s>   Add inline comment on text
  resolve --comment <id> [--type <t>]    Mark comment as resolved
  delete --comment <id> --confirm        Delete a comment

Options:
  --file <path>        Read comment text from file (supports markdown)
  --type <t>           Comment type: footer or inline (default: footer)
  --match-index <n>    For inline: which occurrence of selection (default: 0)

Examples:
  atlcli page comments --id 12345
  atlcli page comments add --id 12345 "Looks good!"
  atlcli page comments add --id 12345 --file comment.md
  atlcli page comments reply --id 12345 --parent 67890 "Thanks!"
  atlcli page comments add-inline --id 12345 --selection "important text" "Please clarify this"
  atlcli page comments resolve --comment 67890
  atlcli page comments delete --comment 67890 --confirm
`;
}

function labelHelp(): string {
  return `atlcli page label <command>

Commands:
  add <label> [<label>...] --id <id>   Add labels to a page
  add <label> --cql <query> --confirm  Add label to pages matching CQL
  remove <label> --id <id>             Remove a label from a page
  remove <label> --cql <query> --confirm  Remove label from pages matching CQL
  list --id <id>                       List labels on a page

Options:
  --dry-run    Preview what would be affected without making changes

Examples:
  atlcli page label add architecture api-docs --id 12345
  atlcli page label add archived --cql "space=OLD" --dry-run
  atlcli page label add archived --cql "space=OLD" --confirm
  atlcli page label remove draft --id 12345
  atlcli page label remove draft --cql "label=draft AND space=DEV" --confirm
  atlcli page label list --id 12345
`;
}

function pageHelp(): string {
  return `atlcli page <command>

Commands:
  get --id <id>
  list [--cql <query>] [--limit <n>] [--label <label>] [--space <key>]
  create --space <key> --title <title> --body <file>
  update --id <id> --body <file> [--title <title>]
  move --id <id> --parent <parent-id>  Move page to new parent
  copy --id <id> [--space <key>] [--title <t>] [--parent <p>]  Copy page
  children --id <id> [--limit <n>]     List child pages
  delete --id <id> --confirm           Delete a page
  delete --cql <query> --confirm       Delete pages matching CQL (bulk)
  archive --id <id> --confirm          Archive a page
  archive --cql <query> --confirm      Archive pages matching CQL (bulk)
  label <add|remove|list> ...          Manage page labels
  history --id <id> [--limit <n>]      Show version history
  diff --id <id> [--version <n>]       Compare versions
  restore --id <id> --version <n> --confirm  Restore to version
  comments <list|add|reply|...>        Manage page comments

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
  --dry-run          Preview bulk operations without executing

Examples:
  atlcli page list --label architecture
  atlcli page move --id 12345 --parent 67890
  atlcli page copy --id 12345 --title "Copy of Page"
  atlcli page children --id 12345
  atlcli page delete --id 12345 --confirm
  atlcli page delete --cql "label=to-delete" --dry-run
  atlcli page delete --cql "label=to-delete" --confirm
  atlcli page archive --cql "lastModified < now('-1y')" --dry-run
  atlcli page archive --cql "lastModified < now('-1y')" --confirm
  atlcli page history --id 12345 --limit 5
  atlcli page diff --id 12345 --version 3
  atlcli page restore --id 12345 --version 3 --confirm
  atlcli page comments --id 12345
  atlcli page comments add --id 12345 "Great work!"

Run 'atlcli page label' or 'atlcli page comments' for subcommand help.
`;
}
