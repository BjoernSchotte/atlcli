/**
 * Diff utility for generating unified diffs between text content.
 * Uses the 'diff' npm package for reliable diffing.
 */

import * as Diff from "diff";

/** A single hunk in a diff */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Result of a diff operation */
export interface DiffResult {
  /** Whether there are any changes */
  hasChanges: boolean;
  /** Unified diff format string */
  unified: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
  /** Structured hunks */
  hunks: DiffHunk[];
}

/** Options for diff generation */
export interface DiffOptions {
  /** Label for the old content (default: "old") */
  oldLabel?: string;
  /** Label for the new content (default: "new") */
  newLabel?: string;
  /** Number of context lines (default: 3) */
  context?: number;
}

/**
 * Generate a unified diff between two strings.
 *
 * @param oldContent - The original content
 * @param newContent - The new content
 * @param options - Diff options
 * @returns DiffResult with unified diff and statistics
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  options: DiffOptions = {}
): DiffResult {
  const { oldLabel = "old", newLabel = "new", context = 3 } = options;

  // Normalize line endings
  const oldNorm = oldContent.replace(/\r\n/g, "\n");
  const newNorm = newContent.replace(/\r\n/g, "\n");

  // Check if content is identical
  if (oldNorm === newNorm) {
    return {
      hasChanges: false,
      unified: "",
      additions: 0,
      deletions: 0,
      hunks: [],
    };
  }

  // Generate structured patch
  const patch = Diff.structuredPatch(oldLabel, newLabel, oldNorm, newNorm, "", "", {
    context,
  });

  // Count additions and deletions
  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunk[] = [];

  for (const hunk of patch.hunks) {
    const hunkLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions++;
      } else if (line.startsWith("-")) {
        deletions++;
      }
      hunkLines.push(line);
    }
    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunkLines,
    });
  }

  // Generate unified diff string
  const unified = Diff.createPatch(oldLabel, oldNorm, newNorm, "", "", { context });

  return {
    hasChanges: true,
    unified,
    additions,
    deletions,
    hunks,
  };
}

/**
 * Format a diff with ANSI colors for terminal output.
 *
 * @param diff - The diff result to format
 * @returns Colored diff string
 */
export function formatDiffWithColors(diff: DiffResult): string {
  if (!diff.hasChanges) {
    return "No changes";
  }

  const lines: string[] = [];
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const RESET = "\x1b[0m";

  // Parse the unified diff and colorize
  for (const line of diff.unified.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      // File headers in cyan
      lines.push(`${CYAN}${line}${RESET}`);
    } else if (line.startsWith("+")) {
      // Additions in green
      lines.push(`${GREEN}${line}${RESET}`);
    } else if (line.startsWith("-")) {
      // Deletions in red
      lines.push(`${RED}${line}${RESET}`);
    } else if (line.startsWith("@@")) {
      // Hunk headers in cyan
      lines.push(`${CYAN}${line}${RESET}`);
    } else {
      // Context lines unchanged
      lines.push(line);
    }
  }

  return lines.join("\n");
}

/** Options for the human-readable word-level diff presentation. */
export interface WordDiffFormatOptions {
  /** Add ANSI colors to changed fragments (default: false). */
  color?: boolean;
}

const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

function formatWordChange(oldLine: string, newLine: string, color: boolean): string {
  const parts = Diff.diffWordsWithSpace(oldLine, newLine);
  let rendered = "~ ";
  for (const part of parts) {
    if (part.removed) {
      const value = `[-${part.value}-]`;
      rendered += color ? `${ANSI_RED}${value}${ANSI_RESET}` : value;
    } else if (part.added) {
      const value = `{+${part.value}+}`;
      rendered += color ? `${ANSI_GREEN}${value}${ANSI_RESET}` : value;
    } else {
      rendered += part.value;
    }
  }
  return rendered;
}

function isDeletionLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

function isAdditionLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

/**
 * Format a unified diff as a human-readable word-level presentation.
 *
 * Adjacent removed/added lines are paired positionally and rendered with
 * `[-removed-]` and `{+added+}` fragments. Unpaired lines remain regular
 * unified additions/deletions. The result is intended for review, not for
 * applying as a patch.
 */
export function formatDiffWithWordChanges(
  diff: DiffResult,
  options: WordDiffFormatOptions = {},
): string {
  if (!diff.hasChanges) {
    return "No changes";
  }

  const color = options.color ?? false;
  const source = diff.unified.split("\n");
  const rendered: string[] = [];

  for (let index = 0; index < source.length;) {
    const line = source[index]!;
    if (isDeletionLine(line)) {
      const removed: string[] = [];
      while (index < source.length && isDeletionLine(source[index]!)) {
        removed.push(source[index]!.slice(1));
        index++;
      }

      const added: string[] = [];
      while (index < source.length && isAdditionLine(source[index]!)) {
        added.push(source[index]!.slice(1));
        index++;
      }

      const paired = Math.min(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < paired; pairIndex++) {
        rendered.push(formatWordChange(removed[pairIndex]!, added[pairIndex]!, color));
      }
      for (const value of removed.slice(paired)) {
        const deletion = `-${value}`;
        rendered.push(color ? `${ANSI_RED}${deletion}${ANSI_RESET}` : deletion);
      }
      for (const value of added.slice(paired)) {
        const addition = `+${value}`;
        rendered.push(color ? `${ANSI_GREEN}${addition}${ANSI_RESET}` : addition);
      }
      continue;
    }

    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      rendered.push(color ? `${ANSI_CYAN}${line}${ANSI_RESET}` : line);
    } else if (isAdditionLine(line)) {
      rendered.push(color ? `${ANSI_GREEN}${line}${ANSI_RESET}` : line);
    } else {
      rendered.push(line);
    }
    index++;
  }

  return rendered.join("\n");
}

/**
 * Generate a summary of changes.
 *
 * @param diff - The diff result
 * @returns Human-readable summary
 */
export function formatDiffSummary(diff: DiffResult): string {
  if (!diff.hasChanges) {
    return "No changes";
  }

  const parts: string[] = [];
  if (diff.additions > 0) {
    parts.push(`+${diff.additions}`);
  }
  if (diff.deletions > 0) {
    parts.push(`-${diff.deletions}`);
  }

  return `${parts.join(", ")} line(s) changed`;
}
