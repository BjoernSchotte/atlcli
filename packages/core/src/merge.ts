import { normalizeMarkdown } from "./markdown.js";

/** Result of a three-way merge */
export interface MergeResult {
  /** Whether the merge was successful (no conflicts) */
  success: boolean;
  /** The merged content (may contain conflict markers if !success) */
  content: string;
  /** Number of conflicts found */
  conflictCount: number;
  /** Details about each conflict region */
  conflicts: ConflictRegion[];
}

/** Information about a conflict region */
export interface ConflictRegion {
  startLine: number;
  endLine: number;
  localLines: string[];
  remoteLines: string[];
}

/** Conflict markers */
const CONFLICT_LOCAL = "<<<<<<< LOCAL";
const CONFLICT_SEPARATOR = "=======";
const CONFLICT_REMOTE = ">>>>>>> REMOTE";

/**
 * Performs a three-way merge of markdown content.
 *
 * @param base - The common ancestor (last synced version)
 * @param local - The local version
 * @param remote - The remote version
 * @returns MergeResult with merged content and conflict info
 */
export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  // Normalize all inputs for consistent comparison
  const baseNorm = normalizeMarkdown(base);
  const localNorm = normalizeMarkdown(local);
  const remoteNorm = normalizeMarkdown(remote);

  // If local and remote are identical, no merge needed
  if (localNorm === remoteNorm) {
    return {
      success: true,
      content: localNorm,
      conflictCount: 0,
      conflicts: [],
    };
  }

  // If local hasn't changed from base, use remote
  if (localNorm === baseNorm) {
    return {
      success: true,
      content: remoteNorm,
      conflictCount: 0,
      conflicts: [],
    };
  }

  // If remote hasn't changed from base, use local
  if (remoteNorm === baseNorm) {
    return {
      success: true,
      content: localNorm,
      conflictCount: 0,
      conflicts: [],
    };
  }

  // Both have changed - perform line-based merge
  const baseLines = baseNorm.split("\n");
  const localLines = localNorm.split("\n");
  const remoteLines = remoteNorm.split("\n");

  return mergeLines(baseLines, localLines, remoteLines);
}

/**
 * Line-based three-way merge implementation.
 */
function mergeLines(base: string[], local: string[], remote: string[]): MergeResult {
  const result: string[] = [];
  const conflicts: ConflictRegion[] = [];

  // Compute diffs
  const localDiff = computeDiff(base, local);
  const remoteDiff = computeDiff(base, remote);

  let baseIdx = 0;
  let localIdx = 0;
  let remoteIdx = 0;
  let resultLine = 0;

  while (baseIdx < base.length || localIdx < local.length || remoteIdx < remote.length) {
    const localOp = localDiff.get(baseIdx);
    const remoteOp = remoteDiff.get(baseIdx);

    // Both unchanged - take the line
    if (!localOp && !remoteOp && baseIdx < base.length) {
      result.push(base[baseIdx]);
      baseIdx++;
      localIdx++;
      remoteIdx++;
      resultLine++;
      continue;
    }

    // Only local changed
    if (localOp && !remoteOp) {
      if (localOp.type === "delete") {
        baseIdx++;
        remoteIdx++;
      } else if (localOp.type === "insert") {
        for (const line of localOp.lines) {
          result.push(line);
          resultLine++;
        }
        localIdx += localOp.lines.length;
      } else if (localOp.type === "replace") {
        for (const line of localOp.lines) {
          result.push(line);
          resultLine++;
        }
        baseIdx++;
        localIdx += localOp.lines.length;
        remoteIdx++;
      }
      continue;
    }

    // Only remote changed
    if (!localOp && remoteOp) {
      if (remoteOp.type === "delete") {
        baseIdx++;
        localIdx++;
      } else if (remoteOp.type === "insert") {
        for (const line of remoteOp.lines) {
          result.push(line);
          resultLine++;
        }
        remoteIdx += remoteOp.lines.length;
      } else if (remoteOp.type === "replace") {
        for (const line of remoteOp.lines) {
          result.push(line);
          resultLine++;
        }
        baseIdx++;
        localIdx++;
        remoteIdx += remoteOp.lines.length;
      }
      continue;
    }

    // Both changed - check if same change (no conflict)
    if (localOp && remoteOp) {
      const localNewLines = localOp.lines || [];
      const remoteNewLines = remoteOp.lines || [];

      if (
        localOp.type === remoteOp.type &&
        arraysEqual(localNewLines, remoteNewLines)
      ) {
        // Same change - no conflict
        if (localOp.type === "delete") {
          baseIdx++;
        } else {
          for (const line of localNewLines) {
            result.push(line);
            resultLine++;
          }
          baseIdx++;
        }
        localIdx = Math.min(localIdx + localNewLines.length, local.length);
        remoteIdx = Math.min(remoteIdx + remoteNewLines.length, remote.length);
        continue;
      }

      // Different changes - conflict
      const conflictStart = resultLine;

      result.push(CONFLICT_LOCAL);
      resultLine++;
      for (const line of localNewLines) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_SEPARATOR);
      resultLine++;
      for (const line of remoteNewLines) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_REMOTE);
      resultLine++;

      conflicts.push({
        startLine: conflictStart,
        endLine: resultLine - 1,
        localLines: localNewLines,
        remoteLines: remoteNewLines,
      });

      baseIdx++;
      localIdx = Math.min(localIdx + localNewLines.length, local.length);
      remoteIdx = Math.min(remoteIdx + remoteNewLines.length, remote.length);
      continue;
    }

    // Fallback: advance all indices
    if (baseIdx < base.length) baseIdx++;
    if (localIdx < local.length) {
      result.push(local[localIdx]);
      localIdx++;
      resultLine++;
    }
    if (remoteIdx < remote.length) remoteIdx++;
  }

  return {
    success: conflicts.length === 0,
    content: result.join("\n"),
    conflictCount: conflicts.length,
    conflicts,
  };
}

/** Operation type for diff */
type DiffOp = {
  type: "insert" | "delete" | "replace";
  lines: string[];
};

/**
 * Compute a simple line-based diff between base and modified.
 * Returns a map of base line index -> operation.
 */
function computeDiff(base: string[], modified: string[]): Map<number, DiffOp> {
  const ops = new Map<number, DiffOp>();

  // Use LCS-based diff for better results
  const lcs = longestCommonSubsequence(base, modified);
  let baseIdx = 0;
  let modIdx = 0;
  let lcsIdx = 0;

  while (baseIdx < base.length || modIdx < modified.length) {
    if (lcsIdx < lcs.length && baseIdx < base.length && base[baseIdx] === lcs[lcsIdx]) {
      if (modIdx < modified.length && modified[modIdx] === lcs[lcsIdx]) {
        // Match - no change
        baseIdx++;
        modIdx++;
        lcsIdx++;
      } else {
        // Insert before this base line
        const insertLines: string[] = [];
        while (modIdx < modified.length && (lcsIdx >= lcs.length || modified[modIdx] !== lcs[lcsIdx])) {
          insertLines.push(modified[modIdx]);
          modIdx++;
        }
        if (insertLines.length > 0) {
          ops.set(baseIdx, { type: "insert", lines: insertLines });
        }
      }
    } else if (baseIdx < base.length) {
      // Base line not in LCS - deleted or replaced
      const replaceLines: string[] = [];
      while (modIdx < modified.length && (lcsIdx >= lcs.length || modified[modIdx] !== lcs[lcsIdx])) {
        replaceLines.push(modified[modIdx]);
        modIdx++;
      }
      if (replaceLines.length > 0) {
        ops.set(baseIdx, { type: "replace", lines: replaceLines });
      } else {
        ops.set(baseIdx, { type: "delete", lines: [] });
      }
      baseIdx++;
    } else {
      // Only modified lines left - insert at end
      const insertLines: string[] = [];
      while (modIdx < modified.length) {
        insertLines.push(modified[modIdx]);
        modIdx++;
      }
      if (insertLines.length > 0) {
        ops.set(baseIdx, { type: "insert", lines: insertLines });
      }
    }
  }

  return ops;
}

/**
 * Compute the longest common subsequence of two arrays.
 */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // DP table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

/**
 * Check if two string arrays are equal.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check if content contains conflict markers.
 */
export function hasConflictMarkers(content: string): boolean {
  return (
    content.includes(CONFLICT_LOCAL) &&
    content.includes(CONFLICT_SEPARATOR) &&
    content.includes(CONFLICT_REMOTE)
  );
}

/**
 * Parse conflict regions from content with markers.
 */
export function parseConflictMarkers(content: string): ConflictRegion[] {
  const lines = content.split("\n");
  const conflicts: ConflictRegion[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i] === CONFLICT_LOCAL) {
      const startLine = i;
      const localLines: string[] = [];
      const remoteLines: string[] = [];

      i++;
      while (i < lines.length && lines[i] !== CONFLICT_SEPARATOR) {
        localLines.push(lines[i]);
        i++;
      }

      if (i < lines.length) i++; // Skip separator

      while (i < lines.length && lines[i] !== CONFLICT_REMOTE) {
        remoteLines.push(lines[i]);
        i++;
      }

      const endLine = i;
      conflicts.push({ startLine, endLine, localLines, remoteLines });
    }
    i++;
  }

  return conflicts;
}

/**
 * Resolve conflicts by choosing a side.
 */
export function resolveConflicts(
  content: string,
  choice: "local" | "remote"
): string {
  const lines = content.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i] === CONFLICT_LOCAL) {
      const localLines: string[] = [];
      const remoteLines: string[] = [];

      i++;
      while (i < lines.length && lines[i] !== CONFLICT_SEPARATOR) {
        localLines.push(lines[i]);
        i++;
      }

      if (i < lines.length) i++; // Skip separator

      while (i < lines.length && lines[i] !== CONFLICT_REMOTE) {
        remoteLines.push(lines[i]);
        i++;
      }

      // Add chosen side
      const chosen = choice === "local" ? localLines : remoteLines;
      result.push(...chosen);

      i++; // Skip CONFLICT_REMOTE marker
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}
