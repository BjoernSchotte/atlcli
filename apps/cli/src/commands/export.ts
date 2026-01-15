import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
} from "@atlcli/core";
import {
  ConfluenceClient,
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
  const embedImages = hasFlag(flags, "embed-images");
  const includeChildren = hasFlag(flags, "include-children");
  const mergeChildren = !hasFlag(flags, "no-merge"); // merge is default

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

  // Fetch page data
  const page = await client.getPage(pageId);
  const spaceKey = page.spaceKey ?? "UNKNOWN";

  // Convert storage to markdown
  const conversionOpts: ConversionOptions = {
    baseUrl: profile.baseUrl,
    emitWarnings: false,
  };
  const markdown = storageToMarkdown(page.storage, conversionOpts);

  // Get space info (if we have the space key)
  let spaceName = spaceKey;
  try {
    const space = await client.getSpace(spaceKey);
    spaceName = space.name;
  } catch {
    // Ignore - use spaceKey as name
  }

  // Fetch and embed images if requested
  const images: Record<string, { data: string; mimeType: string }> = {};
  if (embedImages) {
    const attachments = await client.listAttachments(pageId);
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

  // Fetch children if requested
  let finalMarkdown = markdown;
  const childrenData: Array<{
    title: string;
    markdown: string;
    pageId: string;
    pageUrl: string;
  }> = [];

  if (includeChildren) {
    const children = await client.getChildren(pageId);

    for (const child of children) {
      const childPage = await client.getPage(child.id);
      const childMarkdown = storageToMarkdown(childPage.storage, conversionOpts);

      // Fetch child images if embedding
      if (embedImages) {
        const childAttachments = await client.listAttachments(child.id);
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
          pageId: child.id,
          pageUrl: `${profile.baseUrl}/wiki/spaces/${spaceKey}/pages/${child.id}`,
        });
      }
    }
  }

  // Build page data for Python subprocess
  const pageData = {
    title: page.title,
    markdown: finalMarkdown,
    author: {
      displayName: "Unknown",
      email: "",
    },
    modifier: {
      displayName: "Unknown",
      email: "",
    },
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    pageId: page.id,
    pageUrl: `${profile.baseUrl}/wiki/spaces/${spaceKey}/pages/${page.id}`,
    tinyUrl: `${profile.baseUrl}/wiki/x/${page.id}`,
    labels: [] as string[],
    spaceKey,
    spaceName,
    spaceUrl: `${profile.baseUrl}/wiki/spaces/${spaceKey}`,
    exportedBy: profile.email ?? "atlcli",
    templateName: templatePath,
    attachments: [],
    children: childrenData,
    images,  // Embedded images keyed by filename
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

  output({
    success: true,
    output: result,
    page: {
      id: page.id,
      title: page.title,
      space: spaceKey,
    },
  }, opts);
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

async function callExportSubprocess(
  pageData: object,
  templatePath: string,
  outputPath: string,
  opts: OutputOptions
): Promise<string> {
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
          resolve(response.output);
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
  --embed-images      Download and embed images from page attachments
  --include-children  Include child pages in export
  --no-merge          Keep children as separate array (for loops in templates)
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
  atlcli wiki export 12345 -t basic -o out.docx --embed-images
  atlcli wiki export 12345 -t book -o book.docx --include-children
  atlcli wiki export template save corporate --file ./template.docx --level global
  atlcli wiki export template list
`;
}
