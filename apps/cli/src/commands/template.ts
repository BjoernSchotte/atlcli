import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getFlag,
  hasFlag,
  output,
  loadConfig,
  getActiveProfile,
  isInteractive,
  readTextFile,
  // Template system from core
  GlobalTemplateStorage,
  ProfileTemplateStorage,
  SpaceTemplateStorage,
  TemplateResolver,
  TemplateEngine,
  parseTemplate,
  serializeTemplate,
  validateTemplate,
  getBuiltinVariables,
  // Import/export
  exportToDirectory,
  exportSingleTemplate,
  importFromDirectory,
  importFromGitUrl,
  importFromUrl,
  detectImportSourceType,
  getTrackedTemplates,
  type Template,
  type TemplateFilter,
  type TemplateSummary,
  type TemplateStorage,
  type TemplateVariable,
  type TemplateMetadata,
  type ImportOptions,
} from "@atlcli/core";
import { findAtlcliDir, ConfluenceClient, storageToMarkdown } from "@atlcli/confluence";

type Flags = Record<string, string | boolean | string[]>;

export async function handleTemplate(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list":
      await handleList(rest, flags, opts);
      return;
    case "show":
      await handleShow(rest, flags, opts);
      return;
    case "create":
      await handleCreate(rest, flags, opts);
      return;
    case "edit":
      await handleEdit(rest, flags, opts);
      return;
    case "delete":
      await handleDelete(rest, flags, opts);
      return;
    case "rename":
      await handleRename(rest, flags, opts);
      return;
    case "validate":
      await handleValidate(rest, flags, opts);
      return;
    case "render":
      await handleRender(rest, flags, opts);
      return;
    case "init":
      await handleInit(rest, flags, opts);
      return;
    case "copy":
      await handleCopy(rest, flags, opts);
      return;
    case "export":
      await handleExport(rest, flags, opts);
      return;
    case "import":
      await handleImport(rest, flags, opts);
      return;
    case "update":
      await handleUpdate(rest, flags, opts);
      return;
    default:
      output(templateHelp(), opts);
      return;
  }
}

// ============================================================================
// Context and Storage Helpers
// ============================================================================

interface TemplateContext {
  resolver: TemplateResolver;
  global: GlobalTemplateStorage;
  profile?: ProfileTemplateStorage;
  space?: SpaceTemplateStorage;
  profileName?: string;
  spaceKey?: string;
  docsDir?: string;
}

async function getTemplateContext(flags: Flags): Promise<TemplateContext> {
  const config = await loadConfig();
  const activeProfile = getActiveProfile(config);
  const profileName = getFlag(flags, "profile") ?? activeProfile?.name;
  const spaceKey = getFlag(flags, "space");

  // Detect docs folder for space context
  const docsDir = await findAtlcliDir(process.cwd());

  const global = new GlobalTemplateStorage();
  const profile = profileName ? new ProfileTemplateStorage(profileName) : undefined;
  const space = spaceKey
    ? new SpaceTemplateStorage(spaceKey, docsDir ?? undefined)
    : undefined;

  const resolver = new TemplateResolver(global, profile, space);

  return { resolver, global, profile, space, profileName, spaceKey, docsDir: docsDir ?? undefined };
}

function getTargetStorage(
  ctx: TemplateContext,
  flags: Flags
): { storage: TemplateStorage; level: string } {
  const level = getFlag(flags, "level");

  if (level === "global" || (!getFlag(flags, "profile") && !getFlag(flags, "space"))) {
    return { storage: ctx.global, level: "global" };
  }

  if (getFlag(flags, "profile")) {
    if (!ctx.profile) {
      throw new Error("Profile storage not available");
    }
    return { storage: ctx.profile, level: `profile:${ctx.profileName}` };
  }

  if (getFlag(flags, "space")) {
    if (!ctx.space) {
      throw new Error("Space storage not available");
    }
    return { storage: ctx.space, level: `space:${ctx.spaceKey}` };
  }

  return { storage: ctx.global, level: "global" };
}

// ============================================================================
// List Command
// ============================================================================

async function handleList(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const ctx = await getTemplateContext(flags);

  const filter: TemplateFilter = {};

  const level = getFlag(flags, "level");
  if (level === "global" || level === "profile" || level === "space") {
    filter.level = level;
  }

  if (getFlag(flags, "profile")) {
    filter.level = "profile";
    filter.profile = getFlag(flags, "profile");
  }

  if (getFlag(flags, "space")) {
    filter.level = "space";
    filter.space = getFlag(flags, "space");
  }

  const tag = getFlag(flags, "tag");
  if (tag) {
    filter.tags = [tag];
  }

  const search = getFlag(flags, "search");
  if (search) {
    filter.search = search;
  }

  if (hasFlag(flags, "all")) {
    filter.includeOverridden = true;
  }

  const templates = await ctx.resolver.listAll(filter);

  if (opts.json) {
    output({ templates }, opts);
    return;
  }

  if (templates.length === 0) {
    output("No templates found.", opts);
    return;
  }

  // Format as table
  for (const t of templates) {
    const levelStr = formatLevel(t);
    const overrideStr = t.overrides ? " (overridden)" : "";
    const desc = t.description ?? "";
    output(`${t.name.padEnd(24)} ${levelStr.padEnd(16)} ${desc}${overrideStr}`, opts);
  }
}

function formatLevel(t: TemplateSummary): string {
  if (t.level === "global") return "[global]";
  if (t.level === "profile") return `[profile:${t.profile}]`;
  if (t.level === "space") return `[space:${t.space}]`;
  return `[${t.level}]`;
}

// ============================================================================
// Show Command
// ============================================================================

async function handleShow(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  const ctx = await getTemplateContext(flags);
  const template = await resolveTemplate(ctx, name, flags, opts);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' not found.`);
  }

  if (opts.json) {
    output({ template }, opts);
    return;
  }

  // Display metadata
  output(`Name:        ${template.metadata.name}`, opts);
  output(`Level:       ${template.source.level}`, opts);
  if (template.source.profile) {
    output(`Profile:     ${template.source.profile}`, opts);
  }
  if (template.source.space) {
    output(`Space:       ${template.source.space}`, opts);
  }
  if (template.metadata.description) {
    output(`Description: ${template.metadata.description}`, opts);
  }
  if (template.metadata.author) {
    output(`Author:      ${template.metadata.author}`, opts);
  }
  if (template.metadata.version) {
    output(`Version:     ${template.metadata.version}`, opts);
  }
  if (template.metadata.tags?.length) {
    output(`Tags:        ${template.metadata.tags.join(", ")}`, opts);
  }

  if (template.metadata.variables?.length) {
    output("Variables:", opts);
    for (const v of template.metadata.variables) {
      const req = v.required ? ", required" : "";
      const def = v.default ? `, default: ${v.default}` : "";
      const opts_str = v.options ? `, options: ${v.options.join("|")}` : "";
      output(`  - ${v.name} (${v.type}${req}${def}${opts_str})`, opts);
      if (v.description) {
        output(`    ${v.description}`, opts);
      }
    }
  }

  output("", opts);
  output("--- Content ---", opts);
  output(template.content, opts);
}

async function resolveTemplate(
  ctx: TemplateContext,
  name: string,
  flags: Flags,
  opts: OutputOptions
): Promise<Template | null> {
  const level = getFlag(flags, "level");
  const profile = getFlag(flags, "profile");
  const space = getFlag(flags, "space");

  // If specific level requested, get from that storage
  if (level === "global") {
    return ctx.global.get(name);
  }
  if (profile && ctx.profile) {
    return ctx.profile.get(name);
  }
  if (space && ctx.space) {
    return ctx.space.get(name);
  }

  // Otherwise use resolver (precedence-based)
  const template = await ctx.resolver.resolve(name);

  // Check for ambiguity
  if (template && isInteractive()) {
    const locations = await ctx.resolver.getTemplateLocations(name);
    if (locations.length > 1) {
      output(`Template '${name}' exists at multiple levels:`, opts);
      for (const loc of locations) {
        output(`  - ${formatLevel(loc)}`, opts);
      }
      output("Use --level, --profile, or --space to specify.", opts);
    }
  }

  return template;
}

// ============================================================================
// Create Command
// ============================================================================

async function handleCreate(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  let name = args[0];
  const filePath = getFlag(flags, "file");
  const interactiveWizard = hasFlag(flags, "interactive");

  // Interactive wizard mode
  if (interactiveWizard) {
    if (!isInteractive()) {
      fail(opts, 1, ERROR_CODES.USAGE, "--interactive requires a terminal.");
    }
    const wizardResult = await runCreateWizard(name, opts);
    name = wizardResult.name;

    const ctx = await getTemplateContext(flags);
    const { storage, level } = getTargetStorage(ctx, flags);
    const force = hasFlag(flags, "force");

    if (!force && (await storage.exists(name))) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' already exists at ${level}. Use --force to overwrite.`);
    }

    await storage.save(wizardResult.template);

    if (opts.json) {
      output({ created: true, name, level }, opts);
    } else {
      output(`Created template '${name}' at ${level}.`, opts);
    }
    return;
  }

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  const ctx = await getTemplateContext(flags);
  const { storage, level } = getTargetStorage(ctx, flags);
  const force = hasFlag(flags, "force");

  // Check if exists
  if (!force && (await storage.exists(name))) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      `Template '${name}' already exists at ${level}. Use --force to overwrite.`
    );
  }

  let content: string;

  if (filePath) {
    // Read from file
    if (!existsSync(filePath)) {
      fail(opts, 1, ERROR_CODES.IO, `File not found: ${filePath}`);
    }
    content = await readFile(filePath, "utf8");
  } else if (isInteractive()) {
    // Open editor
    content = await openEditorForNew(name);
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "--file is required in non-interactive mode.");
  }

  // Parse and validate
  const { metadata, content: body } = parseTemplate(content);
  metadata.name = name; // Ensure name matches

  const template: Template = {
    metadata,
    content: body,
    source: {
      level: level.startsWith("profile:") ? "profile" : level.startsWith("space:") ? "space" : "global",
      profile: ctx.profileName,
      space: ctx.spaceKey,
      path: "",
    },
  };

  // Validate
  const engine = new TemplateEngine();
  const validation = engine.validate(template);
  if (!validation.valid) {
    output("Template has validation errors:", opts);
    for (const err of validation.errors) {
      output(`  - ${err.message}`, opts);
    }
    fail(opts, 1, ERROR_CODES.VALIDATION, "Template validation failed.");
  }

  await storage.save(template);

  if (opts.json) {
    output({ created: true, name, level }, opts);
  } else {
    output(`Created template '${name}' at ${level}.`, opts);
  }
}

async function openEditorForNew(name: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "atlcli-template-"));
  const tmpFile = join(tmpDir, `${name}.md`);

  // Create starter content
  const starter = `---
name: ${name}
description: ""
variables: []
---
# {{title}}

Your template content here.
`;

  await writeFile(tmpFile, starter, "utf8");

  try {
    await openInEditor(tmpFile);
    return await readFile(tmpFile, "utf8");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";

  return new Promise((resolve, reject) => {
    const child = spawn(editor, [filePath], {
      stdio: "inherit",
      shell: true,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Editor exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

/**
 * Interactive wizard for creating a new template.
 * Prompts for: name → description → tags → opens editor for content
 */
async function runCreateWizard(
  initialName: string | undefined,
  opts: OutputOptions
): Promise<{ name: string; template: Template }> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  output("\n--- Template Creation Wizard ---\n", opts);

  // Name
  let name = initialName;
  if (!name) {
    name = await question("Template name (slug-style, e.g., meeting-notes): ");
    if (!name.trim()) {
      rl.close();
      fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
    }
    name = name.trim().toLowerCase().replace(/\s+/g, "-");
  }

  // Description
  const description = await question("Description (optional): ");

  // Tags
  const tagsInput = await question("Tags (comma-separated, optional): ");
  const tags = tagsInput
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  rl.close();

  // Create starter content with collected metadata
  const metadata: TemplateMetadata = {
    name,
    description: description.trim() || undefined,
    tags: tags.length > 0 ? tags : undefined,
  };

  const starterContent = `# {{title}}

Your template content here.

{{#if items}}
## Items
{{#each items}}
- {{this}}
{{/each}}
{{/if}}
`;

  // Open editor
  const tmpDir = await mkdtemp(join(tmpdir(), "atlcli-template-"));
  const tmpFile = join(tmpDir, `${name}.md`);

  const fullContent = serializeTemplate(metadata, starterContent);
  await writeFile(tmpFile, fullContent, "utf8");

  output("\nOpening editor to write template content...\n", opts);

  try {
    await openInEditor(tmpFile);
    const editedContent = await readFile(tmpFile, "utf8");
    const parsed = parseTemplate(editedContent);

    const template: Template = {
      metadata: { ...parsed.metadata, name },
      content: parsed.content,
      source: { level: "global", path: "" },
    };

    // Validate
    const engine = new TemplateEngine();
    const validation = engine.validate(template);
    if (!validation.valid) {
      output("\nTemplate has validation errors:", opts);
      for (const err of validation.errors) {
        output(`  - ${err.message}`, opts);
      }
      fail(opts, 1, ERROR_CODES.VALIDATION, "Template validation failed.");
    }

    return { name, template };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Edit Command
// ============================================================================

async function handleEdit(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  if (!isInteractive()) {
    fail(opts, 1, ERROR_CODES.USAGE, "Edit requires an interactive terminal.");
  }

  const ctx = await getTemplateContext(flags);
  const template = await resolveTemplate(ctx, name, flags, opts);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' not found.`);
  }

  // Get the storage for this template's level
  const storage = ctx.resolver.getStorage(template.source.level);
  if (!storage) {
    fail(opts, 1, ERROR_CODES.USAGE, `Cannot edit template at level '${template.source.level}'.`);
  }

  // Create temp file with content
  const tmpDir = await mkdtemp(join(tmpdir(), "atlcli-template-"));
  const tmpFile = join(tmpDir, `${name}.md`);
  const content = serializeTemplate(template.metadata, template.content);
  await writeFile(tmpFile, content, "utf8");

  try {
    await openInEditor(tmpFile);
    const edited = await readFile(tmpFile, "utf8");

    // Parse and save
    const { metadata, content: body } = parseTemplate(edited);
    metadata.name = name; // Keep original name

    const updatedTemplate: Template = {
      metadata,
      content: body,
      source: template.source,
    };

    await storage.save(updatedTemplate);

    if (opts.json) {
      output({ edited: true, name }, opts);
    } else {
      output(`Template '${name}' updated.`, opts);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Delete Command
// ============================================================================

async function handleDelete(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  const ctx = await getTemplateContext(flags);
  const template = await resolveTemplate(ctx, name, flags, opts);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' not found.`);
  }

  const force = hasFlag(flags, "force");

  // Confirm deletion
  if (!force && isInteractive()) {
    const confirmed = await confirm(
      `Delete template '${name}' from ${formatLevel({
        name,
        level: template.source.level,
        profile: template.source.profile,
        space: template.source.space,
      })}?`
    );
    if (!confirmed) {
      output("Cancelled.", opts);
      return;
    }
  } else if (!force) {
    fail(opts, 1, ERROR_CODES.USAGE, "Use --force to delete in non-interactive mode.");
  }

  const storage = ctx.resolver.getStorage(template.source.level);
  if (!storage) {
    fail(opts, 1, ERROR_CODES.USAGE, `Cannot delete from level '${template.source.level}'.`);
  }

  await storage.delete(name);

  if (opts.json) {
    output({ deleted: true, name }, opts);
  } else {
    output(`Deleted template '${name}'.`, opts);
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

// ============================================================================
// Rename Command
// ============================================================================

async function handleRename(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const oldName = args[0];
  const newName = args[1];

  if (!oldName || !newName) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: wiki template rename <old-name> <new-name>");
  }

  const ctx = await getTemplateContext(flags);
  const template = await resolveTemplate(ctx, oldName, flags, opts);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${oldName}' not found.`);
  }

  const storage = ctx.resolver.getStorage(template.source.level);
  if (!storage) {
    fail(opts, 1, ERROR_CODES.USAGE, `Cannot rename at level '${template.source.level}'.`);
  }

  // Check if new name exists
  if (await storage.exists(newName)) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${newName}' already exists.`);
  }

  await storage.rename(oldName, newName);

  if (opts.json) {
    output({ renamed: true, oldName, newName }, opts);
  } else {
    output(`Renamed '${oldName}' to '${newName}'.`, opts);
  }
}

// ============================================================================
// Validate Command
// ============================================================================

async function handleValidate(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const engine = new TemplateEngine();

  // Validate from file
  const filePath = getFlag(flags, "file");
  if (filePath) {
    if (!existsSync(filePath)) {
      fail(opts, 1, ERROR_CODES.IO, `File not found: ${filePath}`);
    }
    const content = await readFile(filePath, "utf8");
    const { metadata, content: body } = parseTemplate(content);
    const template: Template = {
      metadata,
      content: body,
      source: { level: "global", path: filePath },
    };

    const result = engine.validate(template);
    outputValidation(filePath, result, opts);
    return;
  }

  // Validate all templates
  if (hasFlag(flags, "all")) {
    const ctx = await getTemplateContext(flags);
    const templates = await ctx.resolver.listAll();

    let hasErrors = false;
    for (const summary of templates) {
      const template = await ctx.resolver.resolve(summary.name);
      if (template) {
        const result = engine.validate(template);
        if (!result.valid || result.warnings.length > 0) {
          outputValidation(summary.name, result, opts);
          if (!result.valid) hasErrors = true;
        }
      }
    }

    if (!hasErrors && !opts.json) {
      output("All templates valid.", opts);
    }
    return;
  }

  // Validate specific template
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name required, or use --all or --file.");
  }

  const ctx = await getTemplateContext(flags);
  const template = await resolveTemplate(ctx, name, flags, opts);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' not found.`);
  }

  const result = engine.validate(template);
  outputValidation(name, result, opts);
}

// ============================================================================
// Render Command
// ============================================================================

async function handleRender(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  const ctx = await getTemplateContext(flags);
  const template = await resolveTemplate(ctx, name, flags, opts);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' not found.`);
  }

  // Parse --var flags
  const variables = parseVarFlags(flags);

  // Check for missing required variables
  const requiredVars = (template.metadata.variables ?? []).filter((v) => v.required);
  const missingRequired = requiredVars.filter(
    (v) => !(v.name in variables) && v.default === undefined
  );

  // Interactive mode: prompt for missing variables
  if (hasFlag(flags, "interactive") && missingRequired.length > 0) {
    if (!isInteractive()) {
      fail(opts, 1, ERROR_CODES.USAGE, "Interactive mode requires a terminal.");
    }
    await promptForVariables(missingRequired, variables, opts);
  }

  // Apply defaults for any remaining missing variables
  for (const v of template.metadata.variables ?? []) {
    if (!(v.name in variables) && v.default !== undefined) {
      variables[v.name] = v.default;
    }
  }

  // Build builtin context
  const builtins: Record<string, unknown> = {
    user: ctx.profileName,
    space: getFlag(flags, "space") ?? ctx.spaceKey,
    profile: ctx.profileName,
    title: getFlag(flags, "title"),
  };

  // Render
  const engine = new TemplateEngine();
  try {
    const result = engine.render(template, {
      variables,
      builtins,
    });

    if (opts.json) {
      output({
        schemaVersion: "1",
        content: result.content,
        usedVariables: result.usedVariables,
        missingVariables: result.missingVariables,
      }, opts);
    } else {
      // Output raw rendered content (for piping to files)
      process.stdout.write(result.content);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(opts, 1, ERROR_CODES.VALIDATION, `Render failed: ${message}`);
  }
}

// ============================================================================
// Init Command - Create template from existing content
// ============================================================================

async function handleInit(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  const fromSource = getFlag(flags, "from");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }
  if (!fromSource) {
    fail(opts, 1, ERROR_CODES.USAGE, "--from is required (page ID, title, or file path).");
  }

  // Determine source type
  const sourceType = detectSourceType(fromSource);
  let content: string;
  let sourceDescription: string;

  if (sourceType === "file") {
    // Read from local file
    if (!existsSync(fromSource)) {
      fail(opts, 1, ERROR_CODES.IO, `File not found: ${fromSource}`);
    }
    content = await readTextFile(fromSource);
    sourceDescription = `file: ${fromSource}`;
  } else {
    // Fetch from Confluence page
    const config = await loadConfig();
    const activeProfile = getActiveProfile(config);
    if (!activeProfile) {
      fail(opts, 1, ERROR_CODES.AUTH, "No active profile. Run 'atlcli config profile' to set one.");
    }

    const client = new ConfluenceClient(activeProfile);

    let page;
    if (sourceType === "id") {
      // Fetch by page ID
      page = await client.getPage(fromSource);
    } else {
      // Fetch by title - requires --from-space
      const fromSpace = getFlag(flags, "from-space");
      if (!fromSpace) {
        fail(opts, 1, ERROR_CODES.USAGE, "--from-space is required when using page title.");
      }
      const pages = await client.searchPages(`title="${fromSource}" AND space="${fromSpace}"`, 1);
      if (pages.length === 0) {
        fail(opts, 1, ERROR_CODES.USAGE, `Page "${fromSource}" not found in space ${fromSpace}.`);
      }
      page = await client.getPage(pages[0].id);
    }

    // Convert storage format to markdown
    content = storageToMarkdown(page.storage);
    sourceDescription = `page: ${page.title} (${page.id})`;
  }

  // Create template metadata
  const metadata: TemplateMetadata = {
    name,
    description: `Template created from ${sourceDescription}`,
  };

  // Create template object
  const template: Template = {
    metadata,
    content,
    source: { level: "global", path: "" },
  };

  // Determine target storage
  const toProfile = getFlag(flags, "to-profile");
  const toSpace = getFlag(flags, "to-space");

  let storage: TemplateStorage;
  let targetDesc: string;

  if (toSpace) {
    const docsDir = await findAtlcliDir(process.cwd());
    storage = new SpaceTemplateStorage(toSpace, docsDir ?? undefined);
    template.source.level = "space";
    template.source.space = toSpace;
    targetDesc = `space: ${toSpace}`;
  } else if (toProfile) {
    storage = new ProfileTemplateStorage(toProfile);
    template.source.level = "profile";
    template.source.profile = toProfile;
    targetDesc = `profile: ${toProfile}`;
  } else {
    storage = new GlobalTemplateStorage();
    targetDesc = "global";
  }

  // Check if template already exists
  const force = hasFlag(flags, "force");
  if (await storage.exists(name)) {
    if (!force) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' already exists at ${targetDesc}. Use --force to overwrite.`);
    }
  }

  // Save template
  await storage.save(template);

  if (opts.json) {
    output({
      schemaVersion: "1",
      created: true,
      name,
      level: template.source.level,
      profile: template.source.profile,
      space: template.source.space,
      source: sourceDescription,
    }, opts);
  } else {
    output(`Created template '${name}' at ${targetDesc} from ${sourceDescription}.`, opts);
    output(`\nNext steps:`, opts);
    output(`  1. Edit to add variables: atlcli wiki template edit ${name}`, opts);
    output(`  2. Validate: atlcli wiki template validate ${name}`, opts);
  }
}

/**
 * Detect source type from --from value.
 * - Numeric string → page ID
 * - Contains / or ends with .md → file path
 * - Otherwise → page title
 */
function detectSourceType(source: string): "id" | "file" | "title" {
  // Check if it's a numeric ID
  if (/^\d+$/.test(source)) {
    return "id";
  }
  // Check if it looks like a file path
  if (source.includes("/") || source.includes("\\") || source.endsWith(".md")) {
    return "file";
  }
  // Default to page title
  return "title";
}

// ============================================================================
// Copy Command - Copy template between levels
// ============================================================================

async function handleCopy(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const sourceName = args[0];
  const targetName = args[1] ?? sourceName; // Default to same name

  if (!sourceName) {
    fail(opts, 1, ERROR_CODES.USAGE, "Source template name is required.");
  }

  // Determine source storage
  const fromLevel = getFlag(flags, "from-level");
  const fromProfile = getFlag(flags, "from-profile");
  const fromSpace = getFlag(flags, "from-space");

  let sourceStorage: TemplateStorage;
  let sourceDesc: string;

  if (fromSpace) {
    const docsDir = await findAtlcliDir(process.cwd());
    sourceStorage = new SpaceTemplateStorage(fromSpace, docsDir ?? undefined);
    sourceDesc = `space: ${fromSpace}`;
  } else if (fromProfile) {
    sourceStorage = new ProfileTemplateStorage(fromProfile);
    sourceDesc = `profile: ${fromProfile}`;
  } else if (fromLevel === "global") {
    sourceStorage = new GlobalTemplateStorage();
    sourceDesc = "global";
  } else {
    // If no source specified, resolve by precedence
    const ctx = await getTemplateContext(flags);
    const template = await ctx.resolver.resolve(sourceName);
    if (!template) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template '${sourceName}' not found.`);
    }
    sourceStorage = ctx.resolver.getStorage(template.source.level)!;
    sourceDesc = template.source.level;
    if (template.source.profile) sourceDesc = `profile: ${template.source.profile}`;
    if (template.source.space) sourceDesc = `space: ${template.source.space}`;
  }

  // Get source template
  const sourceTemplate = await sourceStorage.get(sourceName);
  if (!sourceTemplate) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template '${sourceName}' not found at ${sourceDesc}.`);
  }

  // Determine target storage
  const toLevel = getFlag(flags, "to-level");
  const toProfile = getFlag(flags, "to-profile");
  const toSpace = getFlag(flags, "to-space");

  if (!toLevel && !toProfile && !toSpace) {
    fail(opts, 1, ERROR_CODES.USAGE, "Target is required: --to-level global, --to-profile <name>, or --to-space <key>.");
  }

  let targetStorage: TemplateStorage;
  let targetDesc: string;
  let targetLevel: "global" | "profile" | "space";

  if (toSpace) {
    const docsDir = await findAtlcliDir(process.cwd());
    targetStorage = new SpaceTemplateStorage(toSpace, docsDir ?? undefined);
    targetDesc = `space: ${toSpace}`;
    targetLevel = "space";
  } else if (toProfile) {
    targetStorage = new ProfileTemplateStorage(toProfile);
    targetDesc = `profile: ${toProfile}`;
    targetLevel = "profile";
  } else {
    targetStorage = new GlobalTemplateStorage();
    targetDesc = "global";
    targetLevel = "global";
  }

  // Check if target already exists
  const force = hasFlag(flags, "force");
  if (await targetStorage.exists(targetName)) {
    if (!force) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template '${targetName}' already exists at ${targetDesc}. Use --force to overwrite.`);
    }
  }

  // Create copy with updated name and source
  const copiedTemplate: Template = {
    metadata: {
      ...sourceTemplate.metadata,
      name: targetName,
    },
    content: sourceTemplate.content,
    source: {
      level: targetLevel,
      profile: toProfile,
      space: toSpace,
      path: "",
    },
  };

  // Save copy
  await targetStorage.save(copiedTemplate);

  if (opts.json) {
    output({
      schemaVersion: "1",
      copied: true,
      source: { name: sourceName, level: sourceDesc },
      target: { name: targetName, level: targetDesc },
    }, opts);
  } else {
    if (sourceName === targetName) {
      output(`Copied template '${sourceName}' from ${sourceDesc} to ${targetDesc}.`, opts);
    } else {
      output(`Copied template '${sourceName}' (${sourceDesc}) to '${targetName}' (${targetDesc}).`, opts);
    }
  }
}

/**
 * Parse --var key=value flags into a variables object.
 */
function parseVarFlags(flags: Flags): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  const varFlags = flags.var;

  if (!varFlags) return variables;

  const vars = Array.isArray(varFlags) ? varFlags : [varFlags];
  for (const v of vars) {
    if (typeof v !== "string") continue;
    const eqIndex = v.indexOf("=");
    if (eqIndex === -1) {
      variables[v] = true; // Boolean flag
    } else {
      const key = v.slice(0, eqIndex);
      const value = v.slice(eqIndex + 1);
      // Try to parse as JSON for complex types
      try {
        variables[key] = JSON.parse(value);
      } catch {
        variables[key] = value;
      }
    }
  }

  return variables;
}

/**
 * Prompt for missing required variables interactively.
 */
async function promptForVariables(
  variables: TemplateVariable[],
  values: Record<string, unknown>,
  opts: OutputOptions
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // Use stderr for prompts so stdout can be piped
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  for (const variable of variables) {
    const desc = variable.description ? ` (${variable.description})` : "";
    const typeHint = variable.type !== "string" ? ` [${variable.type}]` : "";

    let prompt = `${variable.name}${typeHint}${desc}: `;

    if (variable.type === "select" && variable.options) {
      output(`\n${variable.name}${desc}:`, { ...opts, json: false });
      variable.options.forEach((opt, i) => {
        output(`  ${i + 1}. ${opt}`, { ...opts, json: false });
      });
      prompt = "Select (1-" + variable.options.length + "): ";
    }

    const answer = await question(prompt);

    if (variable.type === "select" && variable.options) {
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < variable.options.length) {
        values[variable.name] = variable.options[idx];
      } else {
        values[variable.name] = answer;
      }
    } else if (variable.type === "number") {
      values[variable.name] = parseFloat(answer);
    } else if (variable.type === "boolean") {
      values[variable.name] = answer.toLowerCase() === "true" || answer === "1" || answer === "yes";
    } else {
      values[variable.name] = answer;
    }
  }

  rl.close();
}

function outputValidation(
  name: string,
  result: ReturnType<TemplateEngine["validate"]>,
  opts: OutputOptions
): void {
  if (opts.json) {
    output({ name, ...result }, opts);
    return;
  }

  if (result.valid && result.warnings.length === 0) {
    output(`Template '${name}' is valid.`, opts);
    return;
  }

  if (!result.valid) {
    output(`Template '${name}' has errors:`, opts);
    for (const err of result.errors) {
      const loc = err.line ? ` (line ${err.line})` : "";
      output(`  ERROR: ${err.message}${loc}`, opts);
    }
  }

  if (result.warnings.length > 0) {
    if (result.valid) {
      output(`Template '${name}' has warnings:`, opts);
    }
    for (const warn of result.warnings) {
      output(`  WARN: ${warn.message}`, opts);
    }
  }
}

// ============================================================================
// Export Command
// ============================================================================

async function handleExport(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const ctx = await getTemplateContext(flags);
  const outputPath = getFlag(flags, "output") ?? getFlag(flags, "o");

  // Single template export to stdout or file
  if (args.length === 1) {
    const name = args[0];
    const level = getFlag(flags, "level") as "global" | "profile" | "space" | undefined;
    const profile = getFlag(flags, "profile");
    const space = getFlag(flags, "space");

    const content = await exportSingleTemplate(
      ctx.resolver,
      name,
      level,
      profile,
      space
    );

    if (!content) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' not found.`);
    }

    if (outputPath && !outputPath.endsWith("/")) {
      // Output to file
      await writeFile(outputPath, content, "utf8");
      if (opts.json) {
        output({ exported: true, name, file: outputPath }, opts);
      } else {
        output(`Exported '${name}' to ${outputPath}`, opts);
      }
    } else {
      // Output to stdout
      process.stdout.write(content);
    }
    return;
  }

  // Multi-template export to directory
  const outputDir = outputPath ?? "./templates-export";

  // Build filter from flags
  const filter: TemplateFilter = {};
  const level = getFlag(flags, "level");
  if (level === "global" || level === "profile" || level === "space") {
    filter.level = level;
  }
  if (getFlag(flags, "profile")) {
    filter.level = "profile";
    filter.profile = getFlag(flags, "profile");
  }
  if (getFlag(flags, "space")) {
    filter.level = "space";
    filter.space = getFlag(flags, "space");
  }
  const tag = getFlag(flags, "tag");
  if (tag) {
    filter.tags = [tag];
  }

  const { exported, manifest } = await exportToDirectory(ctx.resolver, outputDir, filter);

  if (opts.json) {
    output({
      schemaVersion: "1",
      exported,
      directory: outputDir,
      manifest,
    }, opts);
  } else {
    output(`Exported ${exported.length} template(s) to ${outputDir}/`, opts);
    if (exported.length > 0) {
      output(`Templates: ${exported.join(", ")}`, opts);
    }
  }
}

// ============================================================================
// Import Command
// ============================================================================

async function handleImport(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const source = args[0];
  const templateNames = args.slice(1);

  if (!source) {
    fail(opts, 1, ERROR_CODES.USAGE, "Import source is required (directory, Git URL, or tar.gz URL).");
  }

  // Build import options
  const importOpts: ImportOptions = {
    replace: hasFlag(flags, "replace"),
    templateNames: templateNames.length > 0 ? templateNames : undefined,
  };

  // Handle flattening options
  if (hasFlag(flags, "to-level") && getFlag(flags, "to-level") === "global") {
    importOpts.toLevel = "global";
  }
  if (getFlag(flags, "to-profile")) {
    importOpts.toProfile = getFlag(flags, "to-profile");
  }
  if (getFlag(flags, "to-space")) {
    importOpts.toSpace = getFlag(flags, "to-space");
  }

  // Build storages object
  const config = await loadConfig();
  const activeProfile = getActiveProfile(config);
  const docsDir = await findAtlcliDir(process.cwd());

  const storages = {
    global: new GlobalTemplateStorage(),
    getProfile: (name: string) => new ProfileTemplateStorage(name),
    getSpace: (key: string) => new SpaceTemplateStorage(key, docsDir ?? undefined),
  };

  // Detect source type and import
  const sourceType = detectImportSourceType(source);

  let result;
  try {
    if (sourceType === "directory") {
      result = await importFromDirectory(source, storages, importOpts);
    } else if (sourceType === "git") {
      output("Cloning repository...", opts);
      result = await importFromGitUrl(source, storages, importOpts);
    } else {
      output("Downloading archive...", opts);
      result = await importFromUrl(source, storages, importOpts);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(opts, 1, ERROR_CODES.IO, `Import failed: ${message}`);
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      source,
      sourceType,
      ...result,
    }, opts);
  } else {
    output(`Imported ${result.imported.length} template(s) from ${source}`, opts);
    if (result.imported.length > 0) {
      output(`  Imported: ${result.imported.join(", ")}`, opts);
    }
    if (result.skipped.length > 0) {
      output(`  Skipped (already exist): ${result.skipped.join(", ")}`, opts);
    }
    if (result.errors.length > 0) {
      output(`  Errors:`, opts);
      for (const err of result.errors) {
        output(`    - ${err.name}: ${err.error}`, opts);
      }
    }
  }
}

// ============================================================================
// Update Command
// ============================================================================

async function handleUpdate(
  args: string[],
  flags: Flags,
  opts: OutputOptions
): Promise<void> {
  const templateNames = args;
  const sourceUrl = getFlag(flags, "source");
  const force = hasFlag(flags, "force");

  const ctx = await getTemplateContext(flags);

  // Get templates with tracked sources
  const tracked = await getTrackedTemplates(ctx.resolver, sourceUrl);

  if (tracked.length === 0) {
    if (sourceUrl) {
      fail(opts, 1, ERROR_CODES.USAGE, `No templates tracked from source: ${sourceUrl}`);
    } else {
      fail(opts, 1, ERROR_CODES.USAGE, "No templates with tracked sources found.");
    }
  }

  // Filter by template names if specified
  const toUpdate = templateNames.length > 0
    ? tracked.filter((t) => templateNames.includes(t.name))
    : tracked;

  if (toUpdate.length === 0) {
    fail(opts, 1, ERROR_CODES.USAGE, `No tracked templates found matching: ${templateNames.join(", ")}`);
  }

  // Group by source URL
  const bySource = new Map<string, typeof toUpdate>();
  for (const t of toUpdate) {
    const existing = bySource.get(t.source) ?? [];
    existing.push(t);
    bySource.set(t.source, existing);
  }

  // Build storages object
  const docsDir = await findAtlcliDir(process.cwd());
  const storages = {
    global: new GlobalTemplateStorage(),
    getProfile: (name: string) => new ProfileTemplateStorage(name),
    getSpace: (key: string) => new SpaceTemplateStorage(key, docsDir ?? undefined),
  };

  const allResults: { source: string; imported: string[]; skipped: string[]; errors: Array<{ name: string; error: string }> }[] = [];

  // Import from each source
  for (const [url, templates] of bySource) {
    output(`Updating from ${url}...`, opts);

    const sourceType = detectImportSourceType(url);
    const names = templates.map((t) => t.name);

    const importOpts: ImportOptions = {
      replace: true, // Always replace when updating
      templateNames: names,
      sourceUrl: url,
    };

    let result;
    try {
      if (sourceType === "directory") {
        result = await importFromDirectory(url, storages, importOpts);
      } else if (sourceType === "git") {
        result = await importFromGitUrl(url, storages, importOpts);
      } else {
        result = await importFromUrl(url, storages, importOpts);
      }
      allResults.push({ source: url, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output(`  Error updating from ${url}: ${message}`, opts);
      allResults.push({
        source: url,
        imported: [],
        skipped: [],
        errors: templates.map((t) => ({ name: t.name, error: message })),
      });
    }
  }

  // Output results
  if (opts.json) {
    const totalImported = allResults.flatMap((r) => r.imported);
    const totalSkipped = allResults.flatMap((r) => r.skipped);
    const totalErrors = allResults.flatMap((r) => r.errors);
    output({
      schemaVersion: "1",
      updated: totalImported,
      skipped: totalSkipped,
      errors: totalErrors,
      sources: allResults,
    }, opts);
  } else {
    let totalUpdated = 0;
    for (const result of allResults) {
      if (result.imported.length > 0) {
        output(`  Updated: ${result.imported.join(", ")}`, opts);
        totalUpdated += result.imported.length;
      }
    }
    output(`Updated ${totalUpdated} template(s).`, opts);
  }
}

// ============================================================================
// Help
// ============================================================================

function templateHelp(): string {
  return `atlcli wiki template <command>

Template management with hierarchical storage (global > profile > space).

Commands:
  list        List available templates
  show        Show template details and content
  create      Create a new template
  edit        Edit a template in $EDITOR
  delete      Delete a template
  rename      Rename a template
  validate    Validate template syntax
  render      Render a template with variables
  init        Create template from existing content
  copy        Copy template between levels
  export      Export templates to directory or file
  import      Import templates from directory/URL/Git
  update      Re-import templates from tracked sources

List options:
  --level <global|profile|space>  Filter by level
  --profile <name>                Filter by profile
  --space <key>                   Filter by space
  --tag <tag>                     Filter by tag
  --search <text>                 Search name/description
  --all                           Include overridden templates

Target options (for create/edit/delete/rename):
  --profile <name>    Target profile templates
  --space <key>       Target space templates
  --level global      Target global templates (default)

Create options:
  --file <path>       Read template from file
  --interactive       Run creation wizard (prompts for name, description, tags)
  --force             Overwrite existing template

Render options:
  --var <key=value>   Set variable value (repeatable)
  --interactive       Prompt for missing required variables
  --title <title>     Set @title built-in variable

Init options:
  --from <source>       Page ID, title, or file path (required)
  --from-space <key>    Space for resolving page titles
  --to-profile <name>   Save to profile level
  --to-space <key>      Save to space level
  --force               Overwrite existing template

Copy options:
  --from-level global   Copy from global level
  --from-profile <name> Copy from profile
  --from-space <key>    Copy from space
  --to-level global     Copy to global level
  --to-profile <name>   Copy to profile
  --to-space <key>      Copy to space
  --force               Overwrite existing template

Export options:
  -o, --output <path>   Output directory or file path
  --level <level>       Filter by level
  --profile <name>      Filter by profile
  --space <key>         Filter by space
  --tag <tag>           Filter by tag

Import options:
  --replace             Replace existing templates (default: skip)
  --to-level global     Import all to global level
  --to-profile <name>   Import all to profile
  --to-space <key>      Import all to space

Update options:
  --source <url>        Update only from this source
  --force               Re-track source for templates

Built-in @variables available in templates:
  @date, @datetime, @time, @year, @month, @day, @weekday
  @user, @space, @profile, @title, @parent, @uuid

Examples:
  atlcli wiki template list
  atlcli wiki template list --level global
  atlcli wiki template list --profile work

  atlcli wiki template show meeting-notes
  atlcli wiki template show standup --profile work

  atlcli wiki template create my-template --file template.md
  atlcli wiki template create standup --profile work

  atlcli wiki template edit meeting-notes
  atlcli wiki template rename old-name new-name
  atlcli wiki template delete old-template --force

  atlcli wiki template validate my-template
  atlcli wiki template validate --all
  atlcli wiki template validate --file ./template.md

  atlcli wiki template render meeting-notes --var title="Sprint Planning"
  atlcli wiki template render meeting-notes --interactive
  atlcli wiki template render meeting-notes --var title="Planning" > output.md

  atlcli wiki template init meeting-template --from 12345
  atlcli wiki template init meeting-template --from "Weekly Meeting" --from-space TEAM
  atlcli wiki template init retro --from ./docs/retro.md --to-profile work

  atlcli wiki template copy meeting-notes --from-level global --to-profile work
  atlcli wiki template copy meeting-notes team-meeting --from-level global --to-space TEAM

  atlcli wiki template export                           # All → ./templates-export/
  atlcli wiki template export -o ./my-pack              # All → ./my-pack/
  atlcli wiki template export meeting-notes             # Single → stdout
  atlcli wiki template export meeting-notes -o out.md   # Single → file
  atlcli wiki template export --profile work            # Filter by profile

  atlcli wiki template import ./templates-export        # Local directory
  atlcli wiki template import https://github.com/user/templates  # Git URL
  atlcli wiki template import ./templates --to-profile work      # Flatten to profile
  atlcli wiki template import ./templates --replace              # Replace existing

  atlcli wiki template update                           # Update all tracked
  atlcli wiki template update meeting-notes             # Update specific
  atlcli wiki template update --source https://github.com/user/templates
`;
}
