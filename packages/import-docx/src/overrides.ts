/**
 * Typed import policy: options and style overrides with layered precedence
 * and per-decision provenance (specs/import-docx/007-import-recipes, the
 * baseline override contract recipes wrap).
 *
 * Precedence (plan 007 rule 4):
 *   built-in defaults < recipe < explicit CLI flags < document override file
 * Every effective decision records which layer set it. A direct conflict
 * between the two EXPLICIT layers (CLI vs. override file) fails rather than
 * silently picking a winner.
 */

export type StyleMappingTarget =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "blockquote"
  | "code";

export const STYLE_MAPPING_TARGETS: readonly StyleMappingTarget[] = [
  "paragraph",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "heading-5",
  "heading-6",
  "blockquote",
  "code",
];

export interface DocxImportOptionsV1 {
  /** accept = tracked insertions kept, deletions dropped (Word "accept all"). */
  revisions?: "accept" | "reject";
  /** fail = any reported-outcome warning blocks a confirmed publication. */
  unsupported?: "report" | "fail";
  /**
   * Word-comment handling: auto = inline where the anchor resolves, footer
   * otherwise; inline/footer force one shape; skip drops them (reported).
   */
  comments?: "auto" | "inline" | "footer" | "skip";
}

export interface DocxImportOverridesV1 {
  schema: "atlcli.docx-import-overrides/1";
  /** Word paragraph style (styleId or display name, case-insensitive) → mapping. */
  styleMappings?: Record<string, StyleMappingTarget>;
  options?: DocxImportOptionsV1;
}

export type PolicySource = "default" | "recipe" | "cli" | "override-file";

export interface ResolvedImportPolicy {
  options: Required<DocxImportOptionsV1>;
  /** Lowercased style key → target. */
  styleMappings: Record<string, StyleMappingTarget>;
  /** Decision key (`options.revisions`, `style:<key>`) → winning layer. */
  provenance: Record<string, PolicySource>;
}

export interface PolicyLayerInput {
  options?: DocxImportOptionsV1;
  styleMappings?: Record<string, string>;
}

const DEFAULT_OPTIONS: Required<DocxImportOptionsV1> = {
  revisions: "accept",
  unsupported: "report",
  comments: "auto",
};

function validateLayer(
  layer: PolicyLayerInput | undefined,
  source: PolicySource,
  errors: string[],
): { options: DocxImportOptionsV1; styleMappings: Record<string, StyleMappingTarget> } {
  const options: DocxImportOptionsV1 = {};
  const styleMappings: Record<string, StyleMappingTarget> = {};
  if (!layer) return { options, styleMappings };

  if (layer.options?.revisions !== undefined) {
    if (layer.options.revisions !== "accept" && layer.options.revisions !== "reject") {
      errors.push(`${source}: options.revisions must be accept|reject (got "${layer.options.revisions}").`);
    } else options.revisions = layer.options.revisions;
  }
  if (layer.options?.unsupported !== undefined) {
    if (layer.options.unsupported !== "report" && layer.options.unsupported !== "fail") {
      errors.push(`${source}: options.unsupported must be report|fail (got "${layer.options.unsupported}").`);
    } else options.unsupported = layer.options.unsupported;
  }
  if (layer.options?.comments !== undefined) {
    if (!["auto", "inline", "footer", "skip"].includes(layer.options.comments)) {
      errors.push(`${source}: options.comments must be auto|inline|footer|skip (got "${layer.options.comments}").`);
    } else options.comments = layer.options.comments;
  }
  for (const [rawKey, rawTarget] of Object.entries(layer.styleMappings ?? {})) {
    const key = rawKey.trim().toLowerCase();
    if (!key) {
      errors.push(`${source}: empty style name in styleMappings.`);
      continue;
    }
    if (!STYLE_MAPPING_TARGETS.includes(rawTarget as StyleMappingTarget)) {
      errors.push(
        `${source}: style "${rawKey}" maps to unknown target "${rawTarget}" (allowed: ${STYLE_MAPPING_TARGETS.join(", ")}).`,
      );
      continue;
    }
    if (key in styleMappings) {
      errors.push(`${source}: duplicate style mapping for "${key}" (names are case-insensitive).`);
      continue;
    }
    styleMappings[key] = rawTarget as StyleMappingTarget;
  }
  return { options, styleMappings };
}

/**
 * Merge policy layers into one resolved policy with provenance. Returns all
 * violations at once; a non-empty `errors` means the policy must not publish.
 */
export function resolveImportPolicy(layers: {
  recipe?: PolicyLayerInput;
  cli?: PolicyLayerInput;
  overrideFile?: PolicyLayerInput;
}): { policy: ResolvedImportPolicy; errors: string[] } {
  const errors: string[] = [];
  const recipe = validateLayer(layers.recipe, "recipe", errors);
  const cli = validateLayer(layers.cli, "cli", errors);
  const overrideFile = validateLayer(layers.overrideFile, "override-file", errors);

  const policy: ResolvedImportPolicy = {
    options: { ...DEFAULT_OPTIONS },
    styleMappings: {},
    provenance: {
      "options.revisions": "default",
      "options.unsupported": "default",
      "options.comments": "default",
    },
  };

  const applyOption = (key: keyof Required<DocxImportOptionsV1>, source: PolicySource, value?: string) => {
    if (value === undefined) return;
    policy.options[key] = value as never;
    policy.provenance[`options.${key}`] = source;
  };
  const applyStyles = (mappings: Record<string, StyleMappingTarget>, source: PolicySource) => {
    for (const [key, target] of Object.entries(mappings)) {
      policy.styleMappings[key] = target;
      policy.provenance[`style:${key}`] = source;
    }
  };

  // Layer order = precedence order; later layers overwrite earlier ones.
  applyOption("revisions", "recipe", recipe.options.revisions);
  applyOption("unsupported", "recipe", recipe.options.unsupported);
  applyOption("comments", "recipe", recipe.options.comments);
  applyStyles(recipe.styleMappings, "recipe");
  applyOption("revisions", "cli", cli.options.revisions);
  applyOption("unsupported", "cli", cli.options.unsupported);
  applyOption("comments", "cli", cli.options.comments);
  applyStyles(cli.styleMappings, "cli");

  // The two explicit layers must not contradict each other (rule 4).
  for (const key of ["revisions", "unsupported", "comments"] as const) {
    const a = cli.options[key];
    const b = overrideFile.options[key];
    if (a !== undefined && b !== undefined && a !== b) {
      errors.push(
        `Conflicting explicit settings for options.${key}: CLI says "${a}", override file says "${b}". Remove one.`,
      );
    }
  }
  for (const [key, target] of Object.entries(overrideFile.styleMappings)) {
    const cliTarget = cli.styleMappings[key];
    if (cliTarget !== undefined && cliTarget !== target) {
      errors.push(
        `Conflicting explicit style mapping for "${key}": CLI says "${cliTarget}", override file says "${target}". Remove one.`,
      );
    }
  }
  applyOption("revisions", "override-file", overrideFile.options.revisions);
  applyOption("unsupported", "override-file", overrideFile.options.unsupported);
  applyOption("comments", "override-file", overrideFile.options.comments);
  applyStyles(overrideFile.styleMappings, "override-file");

  return { policy, errors };
}

/** Non-default decisions as human lines, e.g. for the preview. */
export function renderPolicySummary(policy: ResolvedImportPolicy): string[] {
  const lines: string[] = [];
  for (const key of ["revisions", "unsupported", "comments"] as const) {
    const source = policy.provenance[`options.${key}`];
    if (source !== "default") lines.push(`${key}: ${policy.options[key]} (${source})`);
  }
  for (const [key, target] of Object.entries(policy.styleMappings).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`style "${key}" → ${target} (${policy.provenance[`style:${key}`]})`);
  }
  return lines;
}
