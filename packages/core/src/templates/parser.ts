import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TemplateMetadata } from "./types.js";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface ParsedTemplate {
  metadata: TemplateMetadata;
  content: string;
}

/**
 * Parse a template file with YAML frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * name: template-name
 * description: Template description
 * variables:
 *   - name: title
 *     type: string
 * ---
 * Template content here...
 * ```
 */
export function parseTemplate(raw: string): ParsedTemplate {
  const match = raw.match(FRONTMATTER_REGEX);

  if (!match) {
    // No frontmatter - treat entire content as template body
    // Require at least a name in metadata
    return {
      metadata: { name: "" },
      content: raw.trim(),
    };
  }

  const frontmatterYaml = match[1];
  const content = raw.slice(match[0].length).trim();

  let metadata: TemplateMetadata;
  try {
    metadata = parseYaml(frontmatterYaml) as TemplateMetadata;
  } catch {
    throw new Error("Invalid YAML in template frontmatter");
  }

  // Ensure name exists
  if (!metadata.name) {
    metadata.name = "";
  }

  return { metadata, content };
}

/**
 * Serialize a template back to string with YAML frontmatter.
 */
export function serializeTemplate(
  metadata: TemplateMetadata,
  content: string
): string {
  const frontmatter = stringifyYaml(metadata, {
    lineWidth: 0, // Don't wrap lines
    singleQuote: false,
  }).trim();

  return `---\n${frontmatter}\n---\n${content}`;
}

/**
 * Check if a string looks like a template with frontmatter.
 */
export function hasFrontmatter(raw: string): boolean {
  return FRONTMATTER_REGEX.test(raw);
}
