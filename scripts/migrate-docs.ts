#!/usr/bin/env bun
/**
 * Documentation Migration Script
 * Migrates MkDocs markdown to Astro Starlight format
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, basename } from 'path';

const DOCS_DIR = './docs';
const OUTPUT_DIR = './src/content/docs';

// Admonition type mappings (MkDocs → Starlight)
const ADMONITION_MAP: Record<string, string> = {
  note: 'note',
  tip: 'tip',
  hint: 'tip',
  info: 'note',
  warning: 'caution',
  caution: 'caution',
  danger: 'danger',
  error: 'danger',
  bug: 'danger',
  example: 'tip',
  quote: 'note',
  abstract: 'note',
  summary: 'note',
  tldr: 'note',
  success: 'tip',
  check: 'tip',
  done: 'tip',
  question: 'note',
  help: 'note',
  faq: 'note',
  attention: 'caution',
  failure: 'danger',
  fail: 'danger',
  missing: 'danger',
};

interface MigrationResult {
  file: string;
  success: boolean;
  warnings: string[];
  changes: string[];
}

/**
 * Transform MkDocs admonition syntax to Starlight asides
 * !!! note "Title"     → :::note[Title]
 *     Content              Content
 *                          :::
 */
function transformAdmonitions(content: string): { content: string; changes: string[] } {
  const changes: string[] = [];
  const lines = content.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Match admonition start: !!! type "optional title"
    const admonitionMatch = line.match(/^(!!!)[ \t]+([\w-]+)(?:[ \t]+"([^"]*)")?[ \t]*$/);

    if (admonitionMatch) {
      const [, , type, title] = admonitionMatch;
      const starlightType = ADMONITION_MAP[type.toLowerCase()] || 'note';

      changes.push(`Converted admonition: ${type} → ${starlightType}`);

      // Start the aside
      if (title) {
        result.push(`:::${starlightType}[${title}]`);
      } else {
        result.push(`:::${starlightType}`);
      }

      i++;

      // Collect content lines (indented by 4 spaces or tab)
      while (i < lines.length) {
        const contentLine = lines[i];

        // Check if line is indented (part of admonition content)
        if (contentLine.match(/^[ \t]{4}/) || contentLine.trim() === '') {
          // Remove the 4-space indent
          const unindented = contentLine.replace(/^[ \t]{4}/, '');
          result.push(unindented);
          i++;
        } else {
          // End of admonition content
          break;
        }
      }

      // Close the aside
      result.push(':::');
      result.push('');
    } else {
      result.push(line);
      i++;
    }
  }

  return { content: result.join('\n'), changes };
}

/**
 * Remove ::: toc markers (Starlight auto-generates TOC)
 */
function removeTocMarkers(content: string): { content: string; changes: string[] } {
  const changes: string[] = [];

  if (content.includes('::: toc')) {
    changes.push('Removed ::: toc marker');
  }

  // Remove ::: toc line and any empty lines immediately after
  const result = content.replace(/^::: toc\n+/gm, '');

  return { content: result, changes };
}

/**
 * Add description to frontmatter if missing
 */
function ensureFrontmatter(content: string, filename: string): { content: string; changes: string[] } {
  const changes: string[] = [];

  // Check if frontmatter exists
  if (!content.startsWith('---')) {
    // Extract title from first heading or filename
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : basename(filename, '.md');

    changes.push('Added frontmatter');

    const frontmatter = `---
title: "${title}"
description: "${title} - atlcli documentation"
---

`;
    return { content: frontmatter + content, changes };
  }

  // Check if description exists
  const frontmatterEnd = content.indexOf('---', 3);
  if (frontmatterEnd !== -1) {
    const frontmatter = content.slice(0, frontmatterEnd);

    if (!frontmatter.includes('description:')) {
      const titleMatch = frontmatter.match(/title:\s*['"]*([^'"\n]+)/);
      const title = titleMatch ? titleMatch[1].trim() : basename(filename, '.md');

      changes.push('Added description to frontmatter');

      const newFrontmatter = frontmatter.trim() + `\ndescription: "${title} - atlcli documentation"\n`;
      return {
        content: content.replace(frontmatter, newFrontmatter),
        changes
      };
    }
  }

  return { content, changes };
}

/**
 * Process a single markdown file
 */
async function migrateFile(inputPath: string, outputPath: string): Promise<MigrationResult> {
  const result: MigrationResult = {
    file: inputPath,
    success: false,
    warnings: [],
    changes: [],
  };

  try {
    let content = await readFile(inputPath, 'utf-8');

    // Apply transformations
    const tocResult = removeTocMarkers(content);
    content = tocResult.content;
    result.changes.push(...tocResult.changes);

    const admonitionResult = transformAdmonitions(content);
    content = admonitionResult.content;
    result.changes.push(...admonitionResult.changes);

    const frontmatterResult = ensureFrontmatter(content, inputPath);
    content = frontmatterResult.content;
    result.changes.push(...frontmatterResult.changes);

    // Check for tabs syntax (needs manual MDX conversion)
    if (content.includes('=== "')) {
      result.warnings.push('Contains tab syntax - needs manual MDX conversion');
    }

    // Check for grid cards
    if (content.includes('class="grid"') || content.includes('<div class="grid')) {
      result.warnings.push('Contains grid cards - needs manual conversion to CardGrid');
    }

    // Ensure output directory exists
    await mkdir(dirname(outputPath), { recursive: true });

    // Write the migrated file
    await writeFile(outputPath, content, 'utf-8');

    result.success = true;
  } catch (error) {
    result.warnings.push(`Error: ${error}`);
  }

  return result;
}

/**
 * Get all markdown files recursively
 */
async function getMarkdownFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip stylesheets and javascripts directories
      if (entry.name !== 'stylesheets' && entry.name !== 'javascripts') {
        await getMarkdownFiles(fullPath, files);
      }
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('📚 Starting documentation migration...\n');

  const files = await getMarkdownFiles(DOCS_DIR);
  console.log(`Found ${files.length} markdown files\n`);

  const results: MigrationResult[] = [];

  for (const file of files) {
    // Calculate output path
    const relativePath = file.replace(DOCS_DIR + '/', '');
    const outputPath = join(OUTPUT_DIR, relativePath);

    console.log(`Migrating: ${relativePath}`);
    const result = await migrateFile(file, outputPath);
    results.push(result);

    if (result.changes.length > 0) {
      for (const change of result.changes) {
        console.log(`  ✓ ${change}`);
      }
    }

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.log(`  ⚠ ${warning}`);
      }
    }
  }

  // Summary
  console.log('\n📊 Migration Summary');
  console.log('─'.repeat(40));
  console.log(`Total files: ${results.length}`);
  console.log(`Successful: ${results.filter(r => r.success).length}`);
  console.log(`With warnings: ${results.filter(r => r.warnings.length > 0).length}`);

  const filesWithWarnings = results.filter(r => r.warnings.length > 0);
  if (filesWithWarnings.length > 0) {
    console.log('\n⚠ Files needing manual attention:');
    for (const result of filesWithWarnings) {
      console.log(`  - ${result.file}`);
      for (const warning of result.warnings) {
        console.log(`    ${warning}`);
      }
    }
  }

  console.log('\n✅ Migration complete!');
}

migrate().catch(console.error);
