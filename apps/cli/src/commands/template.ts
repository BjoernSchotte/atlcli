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
  type Template,
  type TemplateFilter,
  type TemplateSummary,
  type TemplateStorage,
  type TemplateVariable,
} from "@atlcli/core";
import { findAtlcliDir } from "@atlcli/confluence";

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
  const name = args[0];
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
  const filePath = getFlag(flags, "file");

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

Render options:
  --var <key=value>   Set variable value (repeatable)
  --interactive       Prompt for missing required variables
  --title <title>     Set @title built-in variable

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
`;
}
