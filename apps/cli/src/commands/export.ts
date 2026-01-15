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

  const pageRef = args[0];
  if (!pageRef) {
    fail(opts, 1, ERROR_CODES.USAGE, "Page reference is required. Use page ID, SPACE:Title, or URL.");
  }

  const templatePath = getFlag(flags, "template");
  const outputPath = getFlag(flags, "output") ?? getFlag(flags, "o");

  if (!templatePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--template is required.");
  }

  if (!outputPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--output is required.");
  }

  // Resolve template path
  const resolvedTemplatePath = await resolveTemplatePath(templatePath);
  if (!existsSync(resolvedTemplatePath)) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template not found: ${resolvedTemplatePath}`);
  }

  // Get Confluence client
  const { client, profile } = await getClient(flags, opts);

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

  // Build page data for Python subprocess
  const pageData = {
    title: page.title,
    markdown,
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
    children: [],
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

async function resolveTemplatePath(templateRef: string): Promise<string> {
  // If it's already an absolute path or relative path that exists
  if (existsSync(templateRef)) {
    return resolve(templateRef);
  }

  // Check if it has a Word extension
  const hasExtension = templateRef.endsWith(".docx") || templateRef.endsWith(".docm");

  // Extensions to try - if already has extension, use it; otherwise try both
  const extensions = hasExtension ? [""] : [".docx", ".docm"];

  // Check global templates directory
  for (const ext of extensions) {
    const globalPath = join(homedir(), ".atlcli", "templates", "confluence", `${templateRef}${ext}`);
    if (existsSync(globalPath)) {
      return globalPath;
    }
  }

  // Check project templates directory
  for (const ext of extensions) {
    const projectPath = join(process.cwd(), ".atlcli", "templates", "confluence", `${templateRef}${ext}`);
    if (existsSync(projectPath)) {
      return projectPath;
    }
  }

  // Return original path (will fail later with proper error message)
  return resolve(templateRef);
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
  --profile <name>    Use a specific auth profile

Page Reference Formats:
  12345678            Page ID
  SPACE:Page Title    Space key and page title
  https://...         Full Confluence URL

Template Resolution:
  Templates are resolved in order:
  1. Direct file path (if exists)
  2. Global: ~/.atlcli/templates/confluence/<name>.docx
  3. Project: .atlcli/templates/confluence/<name>.docx

Examples:
  atlcli wiki export 12345678 --template corporate --output ./report.docx
  atlcli wiki export "DOCS:Architecture" -t ./my-template.docx -o ./arch.docx
  atlcli wiki export https://example.atlassian.net/wiki/pages/123 -t basic -o out.docx
`;
}
