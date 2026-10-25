/**
 * `atlcli template vars`: which variables a template needs, before a copy or
 * apply. Read-only; works on Jira templates, issues, pages and local files.
 */
import { readFile } from "node:fs/promises";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  collectVariables,
  ERROR_CODES,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  parseTemplate,
  parseVarsFile,
  type BodyFormat,
  type OutputOptions,
  type Profile,
  type TemplateVariable,
  type VariableUse,
} from "@atlcli/core";
import { JiraClient } from "@atlcli/jira";
import { stringify } from "yaml";
import { assertCliAuthSupported } from "./session-guard.js";
import { unknownSubcommand } from "./unknown-subcommand.js";

type Flags = Record<string, string | boolean | string[]>;
type Unit = { unit: string; value: unknown; format?: BodyFormat };

export interface VariableRow {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description?: string;
  usedIn: string[];
}

/** One row per variable: used ones (undeclared → required string) plus declared ones. */
export function summarizeVariables(uses: VariableUse[], declarations: TemplateVariable[]): VariableRow[] {
  const rows = new Map<string, VariableRow>();
  for (const d of declarations) {
    rows.set(d.name, {
      name: d.name,
      type: d.type,
      required: d.required === true,
      ...(d.default !== undefined ? { default: d.default } : {}),
      ...(d.description ? { description: d.description } : {}),
      usedIn: [],
    });
  }
  for (const use of uses) {
    const row = rows.get(use.name) ?? { name: use.name, type: "string", required: true, usedIn: [] };
    if (!row.usedIn.includes(use.unit)) row.usedIn.push(use.unit);
    rows.set(use.name, row);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A `values:` vars file to fill in (defaults pre-filled). */
export function valuesSkeleton(rows: VariableRow[]): string {
  return stringify({ values: Object.fromEntries(rows.map((r) => [r.name, r.default ?? ""])) });
}

export async function handleTemplateCommand(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const [sub] = args;
  if (!sub || hasFlag(flags, "help")) {
    output(templateCommandHelp(), opts);
    return;
  }
  if (sub !== "vars") {
    unknownSubcommand(sub, templateCommandHelp(), opts);
    return;
  }
  const { units, declarations } = await collectSource(flags, opts);
  const extra = getFlag(flags, "vars-file");
  if (extra) {
    try {
      declarations.push(...parseVarsFile(await readFile(extra, "utf8")).variables);
    } catch (error) {
      fail(opts, 1, ERROR_CODES.USAGE, `--vars-file ${extra}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const rows = summarizeVariables(collectVariables(units), declarations);
  if (opts.json) {
    output({ schemaVersion: "1", variables: rows, skeleton: valuesSkeleton(rows) }, opts);
    return;
  }
  if (rows.length === 0) {
    output("No template variables found.", opts);
    return;
  }
  const lines = [["NAME", "TYPE", "REQUIRED", "DEFAULT", "USED IN"]];
  for (const r of rows) lines.push([r.name, r.type, r.required ? "yes" : "no", r.default ?? "", r.usedIn.join(", ") || "(not used)"]);
  const widths = lines[0]!.map((_, i) => Math.max(...lines.map((l) => l[i]!.length)));
  output(lines.map((l) => l.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n"), opts);
}

async function collectSource(flags: Flags, opts: OutputOptions): Promise<{ units: Unit[]; declarations: TemplateVariable[] }> {
  const sources = ["jira-template", "issue", "jql", "page", "file"].filter((s) => getFlag(flags, s));
  if (sources.length !== 1) {
    fail(opts, 1, ERROR_CODES.USAGE, "Pass exactly one source: --jira-template <name>, --issue <key>, --jql <query>, --page <id> [--tree] or --file <path>");
  }
  const file = getFlag(flags, "file");
  if (file) return fromFile(file, opts);

  const name = getFlag(flags, "jira-template");
  if (name) {
    const { getJiraTemplateContext } = await import("./jira.js");
    const template = await (await getJiraTemplateContext(flags)).resolver.resolve(name);
    if (!template) fail(opts, 1, ERROR_CODES.USAGE, `Template '${name}' not found.`);
    return { units: fieldUnits(template.fields, name), declarations: [...(template.variables ?? [])] };
  }

  const profile = await activeProfile(flags, opts);
  const key = getFlag(flags, "issue");
  const jql = getFlag(flags, "jql");
  if (key || jql) {
    const jira = new JiraClient(profile);
    const fields = ["summary", "description", "labels"];
    const issues = key ? [await jira.getIssue(key, { fields })] : (await jira.search(jql!, { fields, maxResults: 500 })).issues;
    return { units: issues.flatMap((i) => fieldUnits(i.fields as unknown as Record<string, unknown>, i.key)), declarations: [] };
  }

  const confluence = new ConfluenceClient(profile);
  const units: Unit[] = [];
  const visit = async (id: string) => {
    const page = await confluence.getPage(id);
    units.push({ unit: `page ${id} title`, value: page.title }, { unit: `page ${id} body`, value: page.storage ?? "", format: "storage" });
    if (hasFlag(flags, "tree")) for (const child of await confluence.getChildrenWithPosition(id)) await visit(child.id);
  };
  await visit(getFlag(flags, "page")!);
  return { units, declarations: [] };
}

async function fromFile(path: string, opts: OutputOptions): Promise<{ units: Unit[]; declarations: TemplateVariable[] }> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    fail(opts, 1, ERROR_CODES.IO, `--file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (path.endsWith(".json")) {
    const template = JSON.parse(raw) as { fields?: Record<string, unknown>; variables?: TemplateVariable[] };
    return { units: fieldUnits(template.fields ?? {}, path), declarations: [...(template.variables ?? [])] };
  }
  // A wiki template (Markdown with frontmatter) or any text.
  const parsed = parseTemplate(raw);
  return { units: [{ unit: path, value: parsed.content }], declarations: [...(parsed.metadata.variables ?? [])] };
}

/** Jira fields as units: description by its format, everything else by its string leaves. */
function fieldUnits(fields: Record<string, unknown>, owner: string): Unit[] {
  const leaves = (v: unknown): string[] =>
    typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];
  return Object.entries(fields).flatMap(([id, value]): Unit[] => {
    if (id === "description") return value ? [{ unit: `${owner} description`, value, format: typeof value === "string" ? "wikimarkup" : "adf" }] : [];
    return leaves(value).map((text) => ({ unit: `${owner} ${id}`, value: text }));
  });
}

async function activeProfile(flags: Flags, opts: OutputOptions): Promise<Profile> {
  const profile = getActiveProfile(await loadConfig(), getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
  assertCliAuthSupported(profile, opts);
  return profile;
}

export function templateCommandHelp(): string {
  return `atlcli template <command>

Commands:
  vars    List the variables a template needs (read-only)

Sources for vars (exactly one):
  --jira-template <name>   A saved Jira template (jira template save)
  --issue <key>            A template issue
  --jql <query>            Template issues (up to 500)
  --page <id> [--tree]     A template page, or the page and its descendants
  --file <path>            A local file: a Jira template (.json) or a wiki template (.md)

Options:
  --vars-file <file>       Merge declarations (types, defaults) from a vars file
  --profile <name>         Use a specific auth profile
  --json                   JSON, including a values: skeleton for --vars-file

Examples:
  atlcli template vars --jql "project = TPL"
  atlcli template vars --page 12345 --tree --json | jq -r .skeleton > vars.yml
`;
}
