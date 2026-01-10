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
 * Line-based three-way merge using diff3 algorithm.
 * Computes changes from base to local and base to remote,
 * then merges the changes.
 */
function mergeLines(base: string[], local: string[], remote: string[]): MergeResult {
  const result: string[] = [];
  const conflicts: ConflictRegion[] = [];

  // Get changes from base to local and remote
  const localChanges = computeChanges(base, local);
  const remoteChanges = computeChanges(base, remote);

  let baseIdx = 0;
  let resultLine = 0;

  // Helper to add insertions before current position
  const addInsertions = (localChange: Change | undefined, remoteChange: Change | undefined): boolean => {
    const localInserts = localChange?.type === "insert" ? localChange.newLines : [];
    const remoteInserts = remoteChange?.type === "insert" ? remoteChange.newLines : [];

    if (localInserts.length === 0 && remoteInserts.length === 0) {
      return false; // No insertions
    }

    if (arraysEqual(localInserts, remoteInserts)) {
      // Same insertions
      for (const line of localInserts) {
        result.push(line);
        resultLine++;
      }
    } else if (localInserts.length === 0) {
      for (const line of remoteInserts) {
        result.push(line);
        resultLine++;
      }
    } else if (remoteInserts.length === 0) {
      for (const line of localInserts) {
        result.push(line);
        resultLine++;
      }
    } else {
      // Different insertions - conflict
      const conflictStart = resultLine;
      result.push(CONFLICT_LOCAL);
      resultLine++;
      for (const line of localInserts) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_SEPARATOR);
      resultLine++;
      for (const line of remoteInserts) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_REMOTE);
      resultLine++;
      conflicts.push({
        startLine: conflictStart,
        endLine: resultLine - 1,
        localLines: localInserts,
        remoteLines: remoteInserts,
      });
    }
    return true;
  };

  while (baseIdx < base.length) {
    const localChange = localChanges.get(baseIdx);
    const remoteChange = remoteChanges.get(baseIdx);

    // Handle insertions before this line
    if (localChange?.type === "insert" || remoteChange?.type === "insert") {
      addInsertions(localChange, remoteChange);
      // If both are just insertions, keep the base line
      if (localChange?.type === "insert" && remoteChange?.type === "insert") {
        result.push(base[baseIdx]);
        resultLine++;
        baseIdx++;
        continue;
      }
      // If only one is insertion, the other might be modify/delete
      if (localChange?.type === "insert") {
        // Remote might have changed the base line
        if (remoteChange?.type === "modify") {
          for (const line of remoteChange.newLines) {
            result.push(line);
            resultLine++;
          }
        } else if (remoteChange?.type === "delete") {
          // Remote deleted
        } else {
          // Remote unchanged
          result.push(base[baseIdx]);
          resultLine++;
        }
        baseIdx++;
        continue;
      }
      if (remoteChange?.type === "insert") {
        // Local might have changed the base line
        if (localChange?.type === "modify") {
          for (const line of localChange.newLines) {
            result.push(line);
            resultLine++;
          }
        } else if (localChange?.type === "delete") {
          // Local deleted
        } else {
          // Local unchanged
          result.push(base[baseIdx]);
          resultLine++;
        }
        baseIdx++;
        continue;
      }
    }

    // Neither changed this line
    if (!localChange && !remoteChange) {
      result.push(base[baseIdx]);
      resultLine++;
      baseIdx++;
      continue;
    }

    // Only local changed (modify or delete)
    if (localChange && !remoteChange) {
      if (localChange.type === "delete") {
        // Local deleted - skip base line
      } else if (localChange.type === "modify") {
        for (const line of localChange.newLines) {
          result.push(line);
          resultLine++;
        }
      }
      baseIdx++;
      continue;
    }

    // Only remote changed (modify or delete)
    if (!localChange && remoteChange) {
      if (remoteChange.type === "delete") {
        // Remote deleted - skip base line
      } else if (remoteChange.type === "modify") {
        for (const line of remoteChange.newLines) {
          result.push(line);
          resultLine++;
        }
      }
      baseIdx++;
      continue;
    }

    // Both changed - check if same change
    if (localChange && remoteChange) {
      if (localChange.type === remoteChange.type &&
          arraysEqual(localChange.newLines, remoteChange.newLines)) {
        // Same change - no conflict
        if (localChange.type === "modify") {
          for (const line of localChange.newLines) {
            result.push(line);
            resultLine++;
          }
        }
        // If both delete, nothing to add
        baseIdx++;
        continue;
      }

      // Different changes - conflict
      const conflictStart = resultLine;
      const localLines = localChange.type === "delete" ? [] : localChange.newLines;
      const remoteLines = remoteChange.type === "delete" ? [] : remoteChange.newLines;

      result.push(CONFLICT_LOCAL);
      resultLine++;
      for (const line of localLines) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_SEPARATOR);
      resultLine++;
      for (const line of remoteLines) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_REMOTE);
      resultLine++;

      conflicts.push({
        startLine: conflictStart,
        endLine: resultLine - 1,
        localLines,
        remoteLines,
      });

      baseIdx++;
      continue;
    }

    baseIdx++;
  }

  // Handle trailing insertions (content added after base end)
  const localTrailing = localChanges.get(base.length);
  const remoteTrailing = remoteChanges.get(base.length);

  if (localTrailing || remoteTrailing) {
    const localLines = localTrailing?.newLines || [];
    const remoteLines = remoteTrailing?.newLines || [];

    if (arraysEqual(localLines, remoteLines)) {
      // Same additions
      for (const line of localLines) {
        result.push(line);
        resultLine++;
      }
    } else if (localLines.length === 0) {
      for (const line of remoteLines) {
        result.push(line);
        resultLine++;
      }
    } else if (remoteLines.length === 0) {
      for (const line of localLines) {
        result.push(line);
        resultLine++;
      }
    } else {
      // Different trailing additions - conflict
      const conflictStart = resultLine;
      result.push(CONFLICT_LOCAL);
      resultLine++;
      for (const line of localLines) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_SEPARATOR);
      resultLine++;
      for (const line of remoteLines) {
        result.push(line);
        resultLine++;
      }
      result.push(CONFLICT_REMOTE);
      resultLine++;
      conflicts.push({
        startLine: conflictStart,
        endLine: resultLine - 1,
        localLines,
        remoteLines,
      });
    }
  }

  return {
    success: conflicts.length === 0,
    content: result.join("\n"),
    conflictCount: conflicts.length,
    conflicts,
  };
}

/** Change record for a base line position */
interface Change {
  type: "modify" | "delete" | "insert";
  newLines: string[];
}

/**
 * Compute changes from base to modified using LCS.
 * Returns a map of base index -> change at that position.
 * Insertions are recorded at the base index BEFORE which they appear.
 */
function computeChanges(base: string[], modified: string[]): Map<number, Change> {
  const changes = new Map<number, Change>();
  const lcs = longestCommonSubsequence(base, modified);

  let baseIdx = 0;
  let modIdx = 0;
  let lcsIdx = 0;

  while (baseIdx < base.length || modIdx < modified.length) {
    // Check if current base line is in LCS
    const baseInLcs = lcsIdx < lcs.length && baseIdx < base.length && base[baseIdx] === lcs[lcsIdx];
    const modInLcs = lcsIdx < lcs.length && modIdx < modified.length && modified[modIdx] === lcs[lcsIdx];

    if (baseInLcs && modInLcs) {
      // Both match LCS - no change, advance all
      baseIdx++;
      modIdx++;
      lcsIdx++;
    } else if (baseInLcs && !modInLcs) {
      // Base matches LCS but modified has insertions before it
      const newLines: string[] = [];
      while (modIdx < modified.length && modified[modIdx] !== lcs[lcsIdx]) {
        newLines.push(modified[modIdx]);
        modIdx++;
      }
      if (newLines.length > 0) {
        // Record as insertion before this base position
        // Use a special key format: negative index or store separately
        const existingChange = changes.get(baseIdx);
        if (existingChange) {
          existingChange.newLines = [...newLines, ...existingChange.newLines];
        } else {
          changes.set(baseIdx, { type: "insert", newLines });
        }
      }
      // Don't advance base yet - process the match on next iteration
    } else if (!baseInLcs && baseIdx < base.length) {
      // Base line not in LCS - deleted or modified
      // Collect any modified lines until we hit the next LCS match
      const newLines: string[] = [];
      while (modIdx < modified.length && (lcsIdx >= lcs.length || modified[modIdx] !== lcs[lcsIdx])) {
        newLines.push(modified[modIdx]);
        modIdx++;
      }

      if (newLines.length > 0) {
        changes.set(baseIdx, { type: "modify", newLines });
      } else {
        changes.set(baseIdx, { type: "delete", newLines: [] });
      }
      baseIdx++;
    } else if (modIdx < modified.length) {
      // Modified has extra lines at the end
      const newLines: string[] = [];
      while (modIdx < modified.length) {
        newLines.push(modified[modIdx]);
        modIdx++;
      }
      if (newLines.length > 0) {
        changes.set(base.length, { type: "insert", newLines });
      }
    } else {
      break;
    }
  }

  return changes;
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
