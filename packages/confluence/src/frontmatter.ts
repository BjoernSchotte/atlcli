/**
 * Frontmatter parsing and serialization for atlcli.
 *
 * Handles YAML frontmatter in markdown files:
 * ---
 * atlcli:
 *   id: "623869955"
 *   title: "Optional Title Override"
 * ---
 */

/** Content type for frontmatter */
export type FrontmatterContentType = "page" | "folder";

/** Frontmatter data structure */
export interface AtlcliFrontmatter {
  id: string;
  title?: string;
  /** Content type: "page" (default) or "folder" */
  type?: FrontmatterContentType;
}

/** Result of parsing a markdown file with frontmatter */
export interface ParsedMarkdown {
  frontmatter: AtlcliFrontmatter | null;
  content: string;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse frontmatter from markdown content.
 * Returns the frontmatter data and the content without frontmatter.
 */
export function parseFrontmatter(markdown: string): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: null, content: markdown };
  }

  const yamlContent = match[1];
  const content = markdown.slice(match[0].length);

  try {
    const frontmatter = parseYaml(yamlContent);
    return { frontmatter, content };
  } catch {
    // Invalid YAML, treat as no frontmatter
    return { frontmatter: null, content: markdown };
  }
}

/**
 * Add or update frontmatter in markdown content.
 */
export function addFrontmatter(content: string, frontmatter: AtlcliFrontmatter): string {
  // Remove existing frontmatter if present
  const stripped = stripFrontmatter(content);

  // Build new frontmatter
  const yaml = serializeYaml(frontmatter);

  return `---\n${yaml}---\n\n${stripped.trim()}\n`;
}

/**
 * Strip frontmatter from markdown content.
 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_REGEX, "");
}

/**
 * Check if markdown has atlcli frontmatter with an ID.
 */
export function hasFrontmatterId(markdown: string): boolean {
  const { frontmatter } = parseFrontmatter(markdown);
  return frontmatter?.id != null;
}

/**
 * Extract the first H1 heading from markdown as a title.
 */
export function extractTitleFromMarkdown(markdown: string): string | null {
  // Strip frontmatter first
  const content = stripFrontmatter(markdown);

  // Match first # heading (not ##, ###, etc.)
  const match = content.match(/^#\s+(.+)$/m);

  if (match) {
    return match[1].trim();
  }

  return null;
}

/**
 * Simple YAML parser for atlcli frontmatter.
 * Only supports the specific structure we need.
 */
function parseYaml(yaml: string): AtlcliFrontmatter | null {
  const lines = yaml.split("\n");
  let inAtlcli = false;
  let id: string | undefined;
  let title: string | undefined;
  let type: FrontmatterContentType | undefined;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "atlcli:") {
      inAtlcli = true;
      continue;
    }

    if (inAtlcli && trimmed.startsWith("id:")) {
      id = parseYamlValue(trimmed.slice(3));
    }

    if (inAtlcli && trimmed.startsWith("title:")) {
      title = parseYamlValue(trimmed.slice(6));
    }

    if (inAtlcli && trimmed.startsWith("type:")) {
      const typeValue = parseYamlValue(trimmed.slice(5));
      if (typeValue === "page" || typeValue === "folder") {
        type = typeValue;
      }
    }

    // Exit atlcli block if we hit a non-indented line
    if (inAtlcli && !line.startsWith(" ") && !line.startsWith("\t") && trimmed !== "") {
      inAtlcli = false;
    }
  }

  if (!id) {
    return null;
  }

  return { id, title, type };
}

/**
 * Parse a YAML value, handling quoted strings.
 */
function parseYamlValue(value: string): string {
  const trimmed = value.trim();

  // Remove quotes if present
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

/**
 * Serialize frontmatter to YAML format.
 */
function serializeYaml(frontmatter: AtlcliFrontmatter): string {
  let yaml = "atlcli:\n";
  yaml += `  id: "${frontmatter.id}"\n`;

  if (frontmatter.title) {
    // Escape quotes in title
    const escapedTitle = frontmatter.title.replace(/"/g, '\\"');
    yaml += `  title: "${escapedTitle}"\n`;
  }

  if (frontmatter.type) {
    yaml += `  type: "${frontmatter.type}"\n`;
  }

  return yaml;
}
