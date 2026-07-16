import { spawn } from "node:child_process";
import { assertCliAuthSupported } from "./session-guard.js";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ERROR_CODES,
  OutputOptions,
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
  storageToMarkdown,
  ConversionOptions,
} from "@atlcli/confluence";

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

  const pageRef = args[0];
  if (!pageRef) {
    fail(opts, 1, ERROR_CODES.USAGE, "Page reference is required. Use page ID, SPACE:Title, or URL.");
  }

  const templatePath = getFlag(flags, "template");
  const outputPath = getFlag(flags, "output") ?? getFlag(flags, "o");
  let embedImages = !hasFlag(flags, "no-images");
  if (hasFlag(flags, "embed-images")) {
    embedImages = true;
  }
  if (hasFlag(flags, "no-images")) {
    embedImages = false;
  }
  const includeChildren = hasFlag(flags, "include-children");
  const mergeChildren = !hasFlag(flags, "no-merge"); // merge is default
  const noTocPrompt = hasFlag(flags, "no-toc-prompt");

  // Engine selection (spec 006): "python" (default) renders markdown through
  // the packages/export docxtpl subprocess; "ts" drives the isomorphic
  // @atlcli/docx engine in-process — the exact code the Chrome extension
  // runs, wired to Node filesystem adapters. No Python required.
  const engine = getFlag(flags, "engine") ?? "python";
  if (engine !== "python" && engine !== "ts") {
    fail(opts, 1, ERROR_CODES.USAGE, `Unknown --engine "${engine}". Use "ts" or "python".`);
  }

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

  // Resolve page ID from reference
  const pageId = await resolvePageId(client, pageRef, opts);

  const baseUrl = getConfluenceBaseUrl(profile);

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
      includeChildren,
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
  opts: OutputOptions
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
    const results = await client.searchPages(cql, 1);
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
  includeChildren: boolean;
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
    includeChildren,
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
  if (includeChildren) {
    cliNotes.push("--include-children is not supported by the ts engine yet; exported the single page.");
  }

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
  --include-children  Include child pages in export
  --no-merge          Keep children as separate array (for loops in templates)
  --no-toc-prompt     Disable TOC dirty flag (Word won't prompt to update fields)
  --engine <name>     Rendering engine: "python" (default, docxtpl) or "ts"
                      (isomorphic @atlcli/docx engine — same as the browser
                      extension; $scroll.* placeholders + image embedding +
                      mermaid diagram rendering, no Python needed; children
                      not yet supported)
  --profile <name>    Use a specific auth profile

Page Reference Formats:
  12345678            Page ID
  SPACE:Page Title    Space key and page title
  https://...         Full Confluence URL

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
  atlcli wiki export 12345678 --template corporate --output ./report.docx
  atlcli wiki export "DOCS:Architecture" -t ./my-template.docx -o ./arch.docx
  atlcli wiki export 12345 -t basic -o out.docx --no-images
  atlcli wiki export 12345 -t book -o book.docx --include-children
  atlcli wiki export 12345 -t scroll-corporate.docx -o out.docx --engine ts
  atlcli wiki export template save corporate --file ./template.docx --level global
  atlcli wiki export template list
`;
}
