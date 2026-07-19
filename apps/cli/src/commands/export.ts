import { spawn } from "node:child_process";
import { assertCliAuthSupported } from "./session-guard.js";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  output,
} from "@atlcli/core";
import {
  AttachmentInfo,
  ConfluenceClient,
  ConfluencePageDetails,
  SpaceHomepageError,
  composeChapters,
  confluenceTreeSource,
  fetchExportTree,
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
  parseExportRequest,
  type ParsedExportRequest,
} from "./export-request.js";
import { mapTreeExportError } from "./export-errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function handleExport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
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

  if (!templatePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--template is required.");
  }

  if (!outputPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--output is required.");
  }

  // Get Confluence client (needed for profile name in template resolution)
  const { client, profile } = await getClient(flags, opts);

  // Resolve template path (with profile for hierarchical lookup)
  const resolvedTemplatePath = await resolveTemplatePath(templatePath, profile.name);
  if (!existsSync(resolvedTemplatePath)) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template not found: ${resolvedTemplatePath}`);
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
    await exportWithTsEngine({
      client,
      pagePromise,
      pageId,
      baseUrl,
      resolvedTemplatePath,
      outputPath,
      embedImages,
      opts,
    });
    return;
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

async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<{ client: ConfluenceClient; profile: any }> {
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
  pagePromise: Promise<ConfluencePageDetails>;
  pageId: string;
  baseUrl: string;
  resolvedTemplatePath: string;
  outputPath: string;
  embedImages: boolean;
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
async function exportWithTsEngine(args: TsEngineArgs): Promise<void> {
  const {
    client,
    pagePromise,
    pageId,
    baseUrl,
    resolvedTemplatePath,
    outputPath,
    embedImages,
    opts,
  } = args;
  // Everything local (engine import + template bytes) loads WHILE the page
  // round-trip is in flight. The much larger rasterizer wasm/fonts are gated
  // on the page storage below.
  const { readFile, stat } = await import("node:fs/promises");
  const [
    { runExport, fileOutputSink },
    { createAssetByteCache, mightContainMermaid, prestartPageDependentDeps, tokenAssetFetcher },
    templateBytesRaw,
    templateStat,
  ] = await Promise.all([
    import("@atlcli/docx"),
    import("./export-internals.js"),
    readFile(resolvedTemplatePath),
    stat(resolvedTemplatePath),
  ]);
  const templateBytes = new Uint8Array(templateBytesRaw);
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
    const { classifyPlaceholder } = await import("@atlcli/docx");
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

  // Mermaid diagrams render via resvg-wasm (spec 005a). A missing rasterizer
  // is not an error: the engine degrades those blocks to readable source
  // code and reports each one — the note here names the reason once.
  const rasterizerPromise = pagePromise.then(async (details) => {
    if (!mightContainMermaid(details.storage ?? "")) {
      return { needed: false as const, rasterizer: null };
    }
    try {
      const { buildDiagramRasterizer } = await import("./export-rasterizer.js");
      return { needed: true as const, rasterizer: await buildDiagramRasterizer() };
    } catch {
      return { needed: true as const, rasterizer: null };
    }
  });
  rasterizerPromise.catch(() => {});
  const [page, rasterizerState] = await Promise.all([pagePromise, rasterizerPromise]);
  const rasterizer = rasterizerState.rasterizer;
  if (rasterizerState.needed && !rasterizer) {
    cliNotes.push("diagram rasterizer unavailable; mermaid diagrams export as code blocks.");
  }

  const resolvedOutputPath = resolve(outputPath);
  const report = await runExport(
    {
      details: page,
      template: {
        name: basename(resolvedTemplatePath),
        modificationDate: templateStat.mtime,
      },
      embedImages,
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
      },
    },
    {
      templates: { getBytes: async () => templateBytes },
      assets: tokenAssetFetcher(client, assetCache),
      rasterizer: rasterizer ?? undefined,
      output: fileOutputSink(resolvedOutputPath),
    }
  );

  output(
    {
      success: true,
      engine: "ts",
      output: resolvedOutputPath,
      page: { id: page.id, title: page.title, space: page.spaceKey ?? "UNKNOWN" },
      report: {
        resolvedCount: report.resolvedCount,
        unsupportedNames: report.unsupportedNames,
        embeddedImages: report.embeddedImages,
        renderedDiagrams: report.renderedDiagrams,
        skippedImages: report.skippedImages,
        durationMs: report.durationMs,
        notes: [...cliNotes, ...report.notes.map((n) => `${n.level}: ${n.message}`)],
      },
    },
    opts
  );
}

interface TreeEngineArgs {
  client: ConfluenceClient;
  profile: any;
  request: ParsedExportRequest;
  baseUrl: string;
  resolvedTemplatePath: string;
  outputPath: string;
  embedImages: boolean;
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

/** True when any composed block is a mermaid code block (needs a rasterizer). */
function blocksNeedRasterizer(blocks: readonly ExportBlock[]): boolean {
  for (const block of blocks) {
    switch (block.type) {
      case "codeBlock":
        if ((block.language ?? "").toLowerCase() === "mermaid") return true;
        break;
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
 * Map any fetch/compose/serialize error to a structured CLI failure via the
 * pure {@link mapTreeExportError}. TOTAL — never rethrows — so under `--json`
 * stdout always carries exactly one JSON document, no matter which error class
 * (typed, abort, or entirely unexpected) surfaced.
 */
function failTreeExport(opts: OutputOptions, error: unknown): never {
  const mapped = mapTreeExportError(error);
  fail(opts, mapped.exitCode, mapped.errCode, mapped.message, mapped.details);
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
  const { client, profile, request, baseUrl, resolvedTemplatePath, outputPath, embedImages, opts } =
    args;

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

    const pageNodeCount = treeResult.nodes.filter((n) => n.kind === "page").length;

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

    // Load engine + template + optional rasterizer.
    const { readFile, stat } = await import("node:fs/promises");
    const [{ runExport, fileOutputSink }, { createAssetByteCache, tokenAssetFetcher }, templateBytesRaw, templateStat] =
      await Promise.all([
        import("@atlcli/docx"),
        import("./export-internals.js"),
        readFile(resolvedTemplatePath),
        stat(resolvedTemplatePath),
      ]);
    const templateBytes = new Uint8Array(templateBytesRaw);
    const assetCache = createAssetByteCache(baseUrl);

    let rasterizer: import("@atlcli/docx").SvgRasterizer | undefined;
    const cliNotes: string[] = [];
    if (embedImages && blocksNeedRasterizer(composed.blocks)) {
      try {
        const { buildDiagramRasterizer } = await import("./export-rasterizer.js");
        rasterizer = (await buildDiagramRasterizer()) ?? undefined;
      } catch {
        rasterizer = undefined;
      }
      if (!rasterizer) {
        cliNotes.push("diagram rasterizer unavailable; mermaid diagrams export as code blocks.");
      }
    }

    const resolvedOutputPath = resolve(outputPath);
    const docxReport = await runExport(
      {
        details: rootDetails,
        blocks: composed.blocks,
        sourceNotes,
        complete: treeResult.complete,
        signal: controller.signal,
        onProgress,
        template: {
          name: basename(resolvedTemplatePath),
          modificationDate: templateStat.mtime,
        },
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
        assets: tokenAssetFetcher(client, assetCache),
        ...(rasterizer ? { rasterizer } : {}),
        output: fileOutputSink(resolvedOutputPath),
      }
    );

    clearProgress();

    // Structured, versioned report (spec 002 A5). Requested scope + resolved
    // scope + completeness + counts + per-code note counts + timings.
    const notesByCode: Record<string, number> = {};
    for (const note of docxReport.notes) {
      notesByCode[note.code] = (notesByCode[note.code] ?? 0) + 1;
    }

    output(
      {
        schema: "atlcli.export-report/v1",
        engine: "ts",
        output: resolvedOutputPath,
        requestedScope: {
          kind: request.scopeKind,
          ...(request.pageRef ? { pageRef: request.pageRef } : {}),
          ...(request.spaceKey ? { spaceKey: request.spaceKey } : {}),
          ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
          ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
          ...(request.maxFolders !== undefined ? { maxFolders: request.maxFolders } : {}),
          ...(request.labels ? { labels: request.labels } : {}),
          completeness: request.completenessMode,
        },
        resolvedScope: scope,
        complete: docxReport.complete,
        counts: {
          pages: pageNodeCount,
          embeddedImages: docxReport.embeddedImages,
          skippedImages: docxReport.skippedImages,
          renderedDiagrams: docxReport.renderedDiagrams,
          resolvedPlaceholders: docxReport.resolvedCount,
        },
        notes: docxReport.notes,
        notesByCode,
        timings: { durationMs: docxReport.durationMs, ...docxReport.timings },
        page: {
          id: rootDetails.id,
          title: rootDetails.title,
          space: rootDetails.spaceKey ?? "UNKNOWN",
        },
        ...(cliNotes.length > 0 ? { cliNotes } : {}),
      },
      opts
    );
  } catch (error) {
    clearProgress();
    failTreeExport(opts, error);
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
  return `atlcli wiki export <page> --template <name> --output <path>

Export a Confluence page to DOCX using a Word template.

Arguments:
  <page>              Page reference (ID, SPACE:Title, or URL)

Options:
  --template, -t      Template name or path (required)
  --output, -o        Output file path (required)
  --no-images         Do not embed images from page attachments (default embeds)
  --no-merge          Keep children as separate array (for loops in templates)
  --no-toc-prompt     Disable TOC dirty flag (Word won't prompt to update fields)
  --engine <name>     Rendering engine: "python" (default, docxtpl) or "ts"
                      (isomorphic @atlcli/docx engine — same as the browser
                      extension; $scroll.* placeholders + image embedding +
                      mermaid diagram rendering, no Python needed; required for
                      tree/space/label export)
  --profile <name>    Use a specific auth profile

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

Exit Codes:
  0    Success
  1    Usage / validation / API error (see the error JSON with --json)
  130  Cancelled (Ctrl-C / SIGINT)

JSON Output (--json):
  stdout carries EXACTLY one report document (schema "atlcli.export-report/v1"):
  requested + resolved scope, complete, page/asset counts, structured notes with
  per-code counts, and timings. Progress events go to stderr as JSONL.

Template Resolution:
  Templates are resolved in order (first match wins):
  1. Direct file path (if exists)
  2. Project: .atlcli/templates/confluence/<name>.docx
  3. Profile: ~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx
  4. Global: ~/.atlcli/templates/confluence/<name>.docx

Template Management:
  atlcli wiki export template list                    List available templates
  atlcli wiki export template save <name> --file <path> [--level global|profile|project]
  atlcli wiki export template delete <name> --confirm

Examples:
  # Minimal: one page tree to a single DOCX
  atlcli wiki export 12345 --template corporate --output handbook.docx --engine ts --scope tree

  # Advanced: whole space, drop internal pages, machine-readable report for CI
  atlcli wiki export --template corporate --output space.docx --engine ts --scope space \\
    --space DOCSY --label-exclude internal --completeness partial --json

  atlcli wiki export 12345678 --template corporate --output ./report.docx
  atlcli wiki export "DOCS:Architecture" -t ./my-template.docx -o ./arch.docx
  atlcli wiki export 12345 -t basic -o out.docx --no-images
  atlcli wiki export 12345 -t scroll-corporate.docx -o out.docx --engine ts
  atlcli wiki export template save corporate --file ./template.docx --level global
  atlcli wiki export template list
`;
}
