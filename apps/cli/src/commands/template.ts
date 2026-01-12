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
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  validateTemplate,
  renderTemplate,
  createBuiltins,
  getRequiredVariables,
  findAtlcliDir,
} from "@atlcli/confluence";
import type { Template, TemplateVariable, TemplateContext } from "@atlcli/confluence";
import * as readline from "node:readline";

export async function handleTemplate(
  args: string[],
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "list":
      await handleList(flags, opts);
      return;
    case "get":
      await handleGet(flags, opts);
      return;
    case "create":
      await handleCreate(flags, opts);
      return;
    case "validate":
      await handleValidate(flags, opts);
      return;
    case "preview":
      await handlePreview(flags, opts);
      return;
    case "delete":
      await handleDelete(flags, opts);
      return;
    default:
      output(templateHelp(), opts);
      return;
  }
}

async function handleList(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const source = getFlag(flags, "source") as "local" | "global" | "all" | undefined;
  const atlcliDir = await findAtlcliDir(process.cwd());

  const templates = listTemplates({
    atlcliDir: atlcliDir ?? undefined,
    source: source ?? "all",
  });

  if (opts.json) {
    output({ schemaVersion: "1", templates }, opts);
  } else {
    if (templates.length === 0) {
      output("No templates found.", opts);
      return;
    }
    output("Available templates:", opts);
    for (const t of templates) {
      output(`  ${t.name.padEnd(24)} ${t.description}`, opts);
    }
  }
}

async function handleGet(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const name = getFlag(flags, "name");
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--name is required.");
  }

  const atlcliDir = await findAtlcliDir(process.cwd());
  const template = getTemplate(name, atlcliDir ?? undefined);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template "${name}" not found.`);
  }

  if (opts.json) {
    output({ schemaVersion: "1", template }, opts);
  } else {
    output(`Template: ${template.metadata.name}`, opts);
    output(`Description: ${template.metadata.description}`, opts);
    if (template.metadata.version) {
      output(`Version: ${template.metadata.version}`, opts);
    }
    output(`Location: ${template.location}`, opts);
    output("", opts);

    if (template.metadata.variables && template.metadata.variables.length > 0) {
      output("Variables:", opts);
      for (const v of template.metadata.variables) {
        const req = v.required ? " (required)" : "";
        const def = v.default !== undefined ? ` [default: ${v.default}]` : "";
        output(`  {{${v.name}}}${req}${def}`, opts);
        output(`    ${v.prompt}`, opts);
      }
      output("", opts);
    }

    output("Content:", opts);
    output("---", opts);
    output(template.content, opts);
  }
}

async function handleCreate(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const name = getFlag(flags, "name");
  const description = getFlag(flags, "description") ?? "";
  const fromFile = getFlag(flags, "from-file");
  const global = hasFlag(flags, "global");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--name is required.");
  }

  let content = "";
  if (fromFile) {
    content = await readTextFile(fromFile);
  }

  const atlcliDir = await findAtlcliDir(process.cwd());

  const template: Template = {
    metadata: {
      name,
      description: description || `Template: ${name}`,
    },
    content,
    location: "",
    isLocal: !global,
  };

  const path = saveTemplate(template, {
    atlcliDir: atlcliDir ?? undefined,
    global,
  });

  output({ schemaVersion: "1", created: true, path }, opts);
}

async function handleValidate(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const name = getFlag(flags, "name");
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--name is required.");
  }

  const atlcliDir = await findAtlcliDir(process.cwd());
  const template = getTemplate(name, atlcliDir ?? undefined);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template "${name}" not found.`);
  }

  const result = validateTemplate(template);

  if (opts.json) {
    output({ schemaVersion: "1", ...result }, opts);
  } else {
    if (result.valid) {
      output(`Template "${name}" is valid.`, opts);
    } else {
      output(`Template "${name}" has ${result.errors.length} error(s):`, opts);
      for (const err of result.errors) {
        const loc = err.line ? ` (line ${err.line})` : "";
        output(`  - ${err.message}${loc}`, opts);
      }
    }
  }
}

async function handlePreview(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const name = getFlag(flags, "name");
  const title = getFlag(flags, "title") ?? "Preview Page";
  const space = getFlag(flags, "space") ?? "PREVIEW";
  const varFlags = extractVarFlags(flags);

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--name is required.");
  }

  const atlcliDir = await findAtlcliDir(process.cwd());
  const template = getTemplate(name, atlcliDir ?? undefined);

  if (!template) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template "${name}" not found.`);
  }

  // Parse variables from --var flags and prompt for missing required ones
  const variables = await collectVariables(template, varFlags, opts);

  const builtins = createBuiltins({
    title,
    spaceKey: space,
  });

  const context: TemplateContext = {
    variables,
    builtins,
    spaceKey: space,
    title,
  };

  const rendered = renderTemplate(template, context);

  if (opts.json) {
    output({ schemaVersion: "1", rendered }, opts);
  } else {
    output(`Preview: ${rendered.title}`, opts);
    output(`Space: ${rendered.spaceKey}`, opts);
    if (rendered.labels && rendered.labels.length > 0) {
      output(`Labels: ${rendered.labels.join(", ")}`, opts);
    }
    output("", opts);
    output("---", opts);
    output(rendered.markdown, opts);
  }
}

async function handleDelete(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const name = getFlag(flags, "name");
  const confirm = hasFlag(flags, "confirm");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--name is required.");
  }

  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete templates.");
  }

  const atlcliDir = await findAtlcliDir(process.cwd());
  const deleted = deleteTemplate(name, atlcliDir ?? undefined);

  if (!deleted) {
    fail(opts, 1, ERROR_CODES.USAGE, `Template "${name}" not found.`);
  }

  output({ schemaVersion: "1", deleted: true, name }, opts);
}

function extractVarFlags(flags: Record<string, string | boolean>): Record<string, string> {
  const vars: Record<string, string> = {};

  // Handle --var key=value format
  const varFlag = flags["var"];
  if (typeof varFlag === "string") {
    const [key, ...valueParts] = varFlag.split("=");
    if (key && valueParts.length > 0) {
      vars[key] = valueParts.join("=");
    }
  }

  // Also check for multiple --var flags (would be in an array)
  // For now, we just support single --var, but the engine supports multiple

  return vars;
}

async function collectVariables(
  template: Template,
  provided: Record<string, string>,
  opts: OutputOptions
): Promise<Record<string, unknown>> {
  const variables: Record<string, unknown> = { ...provided };
  const required = getRequiredVariables(template);

  // Check for missing required variables
  const missing = required.filter((v) => !(v.name in variables));

  if (missing.length > 0 && !opts.json) {
    // Prompt for missing variables
    for (const v of missing) {
      const value = await promptForVariable(v);
      variables[v.name] = value;
    }
  }

  // Apply defaults for variables not provided
  for (const v of template.metadata.variables ?? []) {
    if (!(v.name in variables) && v.default !== undefined) {
      variables[v.name] = v.default;
    }
  }

  return variables;
}

async function promptForVariable(v: TemplateVariable): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const defaultStr = v.default !== undefined ? ` [${v.default}]` : "";
    rl.question(`${v.prompt}${defaultStr}: `, (answer) => {
      rl.close();
      resolve(answer || String(v.default ?? ""));
    });
  });
}

function templateHelp(): string {
  return `atlcli template <subcommand>

Template management commands.

Subcommands:
  list        List available templates
  get         Get template details
  create      Create a new template
  validate    Validate a template
  preview     Preview rendered template
  delete      Delete a template

Examples:
  atlcli template list
  atlcli template get --name meeting-notes
  atlcli template create --name my-template --from-file template.md
  atlcli template validate --name my-template
  atlcli template preview --name meeting-notes --var date=2025-01-12
  atlcli template delete --name old-template --confirm

Options:
  --source    Filter by source: local, global, all (default: all)
  --name      Template name
  --from-file Create template from file
  --global    Create as global template
  --var       Provide variable value (--var key=value)
  --confirm   Confirm deletion
  --json      JSON output
`;
}
