/**
 * Recipe catalog and `wiki import recipe …` subcommands
 * (specs/import-docx/007-import-recipes, plan 007 rule 2).
 *
 * Catalog roots are explicit — the repository catalog
 * `.atlcli/import-recipes/` under the working directory, then the user
 * catalog `~/.atlcli/import-recipes/`. No other lookup magic; symlinks may
 * not escape their root; duplicate ids inside one root are an error, and
 * the repository catalog shadows the user catalog (deterministically).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { ERROR_CODES, OutputOptions, fail, output } from "@atlcli/core";
import { parseRecipe, type ParsedRecipe } from "@atlcli/import-docx";

export interface CatalogEntry {
  file: string;
  source: "repo" | "user";
  parsed?: ParsedRecipe;
  errors?: string[];
}

function catalogRoots(): Array<{ dir: string; source: "repo" | "user" }> {
  return [
    { dir: resolve(".atlcli/import-recipes"), source: "repo" as const },
    { dir: join(homedir(), ".atlcli", "import-recipes"), source: "user" as const },
  ];
}

/** List every recipe in the catalogs, including invalid ones (with errors). */
export async function listCatalog(): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const { dir, source } of catalogRoots()) {
    if (!existsSync(dir)) continue;
    const rootReal = realpathSync(dir);
    const seenIds = new Map<string, string>();
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const file = join(dir, name);
      let real: string;
      try {
        real = realpathSync(file);
      } catch {
        continue;
      }
      if (!real.startsWith(rootReal)) {
        entries.push({ file, source, errors: [`Symlink escapes the catalog root ${dir}.`] });
        continue;
      }
      const { parsed, errors } = await parseRecipe(readFileSync(real, "utf8"));
      if (!parsed) {
        entries.push({ file, source, errors });
        continue;
      }
      const duplicate = seenIds.get(parsed.recipe.id);
      if (duplicate) {
        entries.push({
          file,
          source,
          errors: [`Duplicate recipe id "${parsed.recipe.id}" (already defined by ${duplicate}).`],
        });
        continue;
      }
      seenIds.set(parsed.recipe.id, name);
      entries.push({ file, source, parsed });
    }
  }
  return entries;
}

/** Resolve a recipe by id: repository catalog first, then user catalog. */
export async function loadRecipeById(id: string): Promise<{ entry?: CatalogEntry; errors: string[] }> {
  const entries = await listCatalog();
  const broken = entries.filter((e) => e.errors?.length);
  const match = entries.find((e) => e.parsed?.recipe.id === id);
  if (!match) {
    const known = entries.flatMap((e) => (e.parsed ? [e.parsed.recipe.id] : []));
    return {
      errors: [
        `No recipe with id "${id}" in the catalogs (known: ${known.join(", ") || "none"}).`,
        ...broken.map((b) => `Note: ${b.file} is invalid: ${b.errors![0]}`),
      ],
    };
  }
  return { entry: match, errors: [] };
}

export async function loadRecipeFile(path: string): Promise<{ entry?: CatalogEntry; errors: string[] }> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { errors: [`Cannot read recipe file: ${(err as Error).message}`] };
  }
  const { parsed, errors } = await parseRecipe(text);
  if (!parsed) return { errors };
  return { entry: { file: path, source: "repo", parsed }, errors: [] };
}

export async function handleRecipeCommand(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  const [sub, target] = args;
  switch (sub) {
    case "validate": {
      if (!target) fail(opts, 1, ERROR_CODES.VALIDATION, "Usage: wiki import recipe validate <file>", {});
      const { entry, errors } = await loadRecipeFile(target);
      if (!entry) {
        if (opts.json) output({ valid: false, errors }, opts);
        else output(`INVALID:\n  ${errors.join("\n  ")}`, opts);
        process.exit(1);
      }
      if (opts.json) {
        output({ valid: true, id: entry.parsed!.recipe.id, version: entry.parsed!.recipe.version, digest: entry.parsed!.digest }, opts);
      } else {
        output(`OK: ${entry.parsed!.recipe.id}@${entry.parsed!.recipe.version} (sha256:${entry.parsed!.digest.slice(0, 16)}…)`, opts);
      }
      return;
    }
    case "list": {
      const entries = await listCatalog();
      if (opts.json) {
        output(
          entries.map((e) => ({
            source: e.source,
            file: e.file,
            ...(e.parsed
              ? { id: e.parsed.recipe.id, version: e.parsed.recipe.version, title: e.parsed.recipe.title, digest: e.parsed.digest }
              : { errors: e.errors }),
          })),
          opts,
        );
      } else if (entries.length === 0) {
        output("No recipes found (.atlcli/import-recipes/ or ~/.atlcli/import-recipes/).", opts);
      } else {
        for (const e of entries) {
          if (e.parsed) {
            output(`  ${e.parsed.recipe.id}@${e.parsed.recipe.version} [${e.source}] — ${e.parsed.recipe.title}`, opts);
          } else {
            output(`  ✗ ${e.file} [${e.source}]: ${e.errors?.[0]}`, opts);
          }
        }
      }
      return;
    }
    case "show": {
      if (!target) fail(opts, 1, ERROR_CODES.VALIDATION, "Usage: wiki import recipe show <file|id>", {});
      const result = target.includes(".") || target.includes("/")
        ? await loadRecipeFile(target)
        : await loadRecipeById(target);
      if (!result.entry) {
        fail(opts, 1, ERROR_CODES.VALIDATION, result.errors.join("\n"), { errors: result.errors });
      }
      const parsed = result.entry.parsed!;
      if (opts.json) {
        output({ source: result.entry.source, digest: parsed.digest, recipe: parsed.recipe }, opts);
      } else {
        output(`${parsed.recipe.id}@${parsed.recipe.version} [${result.entry.source}]`, opts);
        output(`  Title:   ${parsed.recipe.title}`, opts);
        if (parsed.recipe.description) output(`  About:   ${parsed.recipe.description}`, opts);
        output(`  Targets: ${parsed.recipe.targets.join(", ")}`, opts);
        output(`  Digest:  sha256:${parsed.digest.slice(0, 16)}…`, opts);
        if (parsed.recipe.options) output(`  Options: ${JSON.stringify(parsed.recipe.options)}`, opts);
        for (const [style, mapped] of Object.entries(parsed.recipe.overrides?.styleMappings ?? {})) {
          output(`  Style:   "${style}" → ${mapped}`, opts);
        }
      }
      return;
    }
    default:
      output(
        `wiki import recipe <command>\n\nCommands:\n  validate <file>   Validate a recipe file\n  list              List catalog recipes (.atlcli/import-recipes/, ~/.atlcli/import-recipes/)\n  show <file|id>    Show one recipe with digest and mappings`,
        opts,
      );
  }
}
