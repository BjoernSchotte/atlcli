/**
 * Template storage and loading.
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { Template, TemplateMetadata } from "./types.js";

const TEMPLATE_EXTENSION = ".template.md";
const TEMPLATE_YAML_EXTENSION = ".template.yaml";

/**
 * Get the global templates directory.
 */
export function getGlobalTemplatesDir(): string {
  return join(homedir(), ".config", "atlcli", "templates");
}

/**
 * Get the local templates directory for a given atlcli directory.
 */
export function getLocalTemplatesDir(atlcliDir: string): string {
  return join(atlcliDir, ".atlcli", "templates");
}

/**
 * Parse template frontmatter from markdown content.
 */
function parseTemplateFrontmatter(content: string): {
  metadata: TemplateMetadata | null;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: null, body: content };
  }

  try {
    const yamlContent = match[1];
    const body = match[2];
    const parsed = parseYaml(yamlContent);

    if (parsed && typeof parsed === "object" && "template" in parsed) {
      return { metadata: parsed.template as TemplateMetadata, body };
    }

    return { metadata: null, body: content };
  } catch {
    return { metadata: null, body: content };
  }
}

/**
 * Load a template from a file.
 */
export function loadTemplate(filePath: string): Template | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, "utf-8");
  const { metadata, body } = parseTemplateFrontmatter(content);

  if (!metadata) {
    // Try to load separate YAML file
    const yamlPath = filePath.replace(TEMPLATE_EXTENSION, TEMPLATE_YAML_EXTENSION);
    if (existsSync(yamlPath)) {
      try {
        const yamlContent = readFileSync(yamlPath, "utf-8");
        const parsed = parseYaml(yamlContent);
        if (parsed && typeof parsed === "object" && "template" in parsed) {
          return {
            metadata: parsed.template as TemplateMetadata,
            content: content,
            location: filePath,
            isLocal: true,
          };
        }
      } catch {
        // Invalid YAML, skip
      }
    }

    // No metadata found, derive from filename
    const name = basename(filePath, TEMPLATE_EXTENSION);
    return {
      metadata: {
        name,
        description: `Template: ${name}`,
      },
      content: content,
      location: filePath,
      isLocal: true,
    };
  }

  return {
    metadata,
    content: body,
    location: filePath,
    isLocal: true,
  };
}

/**
 * Find all template files in a directory.
 */
function findTemplateFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files: string[] = [];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(TEMPLATE_EXTENSION)) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * List all available templates.
 */
export function listTemplates(options?: {
  atlcliDir?: string;
  source?: "local" | "global" | "all";
}): TemplateMetadata[] {
  const { atlcliDir, source = "all" } = options ?? {};
  const templates: TemplateMetadata[] = [];
  const seen = new Set<string>();

  // Local templates (project-specific)
  if ((source === "local" || source === "all") && atlcliDir) {
    const localDir = getLocalTemplatesDir(atlcliDir);
    const localFiles = findTemplateFiles(localDir);

    for (const file of localFiles) {
      const template = loadTemplate(file);
      if (template && !seen.has(template.metadata.name)) {
        seen.add(template.metadata.name);
        templates.push(template.metadata);
      }
    }
  }

  // Global templates
  if (source === "global" || source === "all") {
    const globalDir = getGlobalTemplatesDir();
    const globalFiles = findTemplateFiles(globalDir);

    for (const file of globalFiles) {
      const template = loadTemplate(file);
      if (template && !seen.has(template.metadata.name)) {
        seen.add(template.metadata.name);
        templates.push(template.metadata);
      }
    }
  }

  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get a template by name.
 */
export function getTemplate(name: string, atlcliDir?: string): Template | null {
  // Check local templates first
  if (atlcliDir) {
    const localDir = getLocalTemplatesDir(atlcliDir);
    const localPath = join(localDir, `${name}${TEMPLATE_EXTENSION}`);
    if (existsSync(localPath)) {
      return loadTemplate(localPath);
    }

    // Check subdirectories
    const localFiles = findTemplateFiles(localDir);
    for (const file of localFiles) {
      const template = loadTemplate(file);
      if (template && template.metadata.name === name) {
        return template;
      }
    }
  }

  // Check global templates
  const globalDir = getGlobalTemplatesDir();
  const globalPath = join(globalDir, `${name}${TEMPLATE_EXTENSION}`);
  if (existsSync(globalPath)) {
    return loadTemplate(globalPath);
  }

  // Check subdirectories
  const globalFiles = findTemplateFiles(globalDir);
  for (const file of globalFiles) {
    const template = loadTemplate(file);
    if (template && template.metadata.name === name) {
      return template;
    }
  }

  return null;
}

/**
 * Save a template to the local or global directory.
 */
export function saveTemplate(
  template: Template,
  options?: { atlcliDir?: string; global?: boolean }
): string {
  const { atlcliDir, global: isGlobal } = options ?? {};

  const targetDir = isGlobal
    ? getGlobalTemplatesDir()
    : atlcliDir
      ? getLocalTemplatesDir(atlcliDir)
      : getGlobalTemplatesDir();

  // Ensure directory exists
  mkdirSync(targetDir, { recursive: true });

  const filePath = join(targetDir, `${template.metadata.name}${TEMPLATE_EXTENSION}`);

  // Create content with frontmatter
  const frontmatter = `---\ntemplate:\n  name: "${template.metadata.name}"\n  description: "${template.metadata.description}"${
    template.metadata.version ? `\n  version: "${template.metadata.version}"` : ""
  }${template.metadata.variables?.length ? `\n  variables:\n${formatVariables(template.metadata.variables)}` : ""}${
    template.metadata.target ? `\n  target:\n${formatTarget(template.metadata.target)}` : ""
  }\n---\n\n`;

  const content = frontmatter + template.content;
  writeFileSync(filePath, content, "utf-8");

  return filePath;
}

/**
 * Delete a template.
 */
export function deleteTemplate(name: string, atlcliDir?: string): boolean {
  // Check local first
  if (atlcliDir) {
    const localDir = getLocalTemplatesDir(atlcliDir);
    const localPath = join(localDir, `${name}${TEMPLATE_EXTENSION}`);
    if (existsSync(localPath)) {
      unlinkSync(localPath);
      // Also delete YAML if exists
      const yamlPath = localPath.replace(TEMPLATE_EXTENSION, TEMPLATE_YAML_EXTENSION);
      if (existsSync(yamlPath)) {
        unlinkSync(yamlPath);
      }
      return true;
    }
  }

  // Check global
  const globalDir = getGlobalTemplatesDir();
  const globalPath = join(globalDir, `${name}${TEMPLATE_EXTENSION}`);
  if (existsSync(globalPath)) {
    unlinkSync(globalPath);
    const yamlPath = globalPath.replace(TEMPLATE_EXTENSION, TEMPLATE_YAML_EXTENSION);
    if (existsSync(yamlPath)) {
      unlinkSync(yamlPath);
    }
    return true;
  }

  return false;
}

/**
 * Check if a template exists.
 */
export function templateExists(name: string, atlcliDir?: string): boolean {
  return getTemplate(name, atlcliDir) !== null;
}

// Helper functions for YAML formatting
function formatVariables(variables: TemplateMetadata["variables"]): string {
  if (!variables) return "";
  return variables
    .map(
      (v) =>
        `    - name: "${v.name}"\n      prompt: "${v.prompt}"\n      type: "${v.type}"${
          v.required ? "\n      required: true" : ""
        }${v.default !== undefined ? `\n      default: "${v.default}"` : ""}`
    )
    .join("\n");
}

function formatTarget(target: TemplateMetadata["target"]): string {
  if (!target) return "";
  const lines: string[] = [];
  if (target.space) lines.push(`    space: "${target.space}"`);
  if (target.parent) lines.push(`    parent: "${target.parent}"`);
  if (target.labels?.length) lines.push(`    labels: [${target.labels.map((l) => `"${l}"`).join(", ")}]`);
  return lines.join("\n");
}
