/**
 * Scope utilities for partial sync.
 *
 * Handles parsing and validation of sync scopes from command flags.
 */

import type { SyncScope } from "./client.js";

/** Result of parsing scope from flags */
export interface ParsedScope {
  scope: SyncScope;
  /** Space key (required for all scopes, may be auto-detected) */
  spaceKey?: string;
}

/** Error thrown when scope is invalid */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Parse scope from command flags.
 *
 * Priority: --page-id > --ancestor > --space
 *
 * @param flags - Command flags
 * @returns Parsed scope, or null if no scope specified
 */
export function parseScope(flags: Record<string, string | boolean | string[]>): ParsedScope | null {
  const pageId = getStringFlag(flags, "page-id");
  const ancestorId = getStringFlag(flags, "ancestor");
  const spaceKey = getStringFlag(flags, "space");

  // Check for conflicting flags
  const scopeCount = [pageId, ancestorId, spaceKey].filter(Boolean).length;
  if (scopeCount > 1 && pageId) {
    // --page-id takes precedence, ignore others
  }

  if (pageId) {
    return {
      scope: { type: "page", pageId },
      spaceKey, // May be undefined, will be auto-detected
    };
  }

  if (ancestorId) {
    return {
      scope: { type: "tree", ancestorId },
      spaceKey, // May be undefined, will be auto-detected
    };
  }

  if (spaceKey) {
    return {
      scope: { type: "space", spaceKey },
      spaceKey,
    };
  }

  return null;
}

/**
 * Build CQL query for a scope.
 *
 * @param scope - Sync scope
 * @returns CQL query string, or null for single page (use direct fetch)
 */
export function buildCqlFromScope(scope: SyncScope): string | null {
  switch (scope.type) {
    case "page":
      // Single page: use direct fetch, not CQL
      return null;
    case "tree":
      return `ancestor=${scope.ancestorId} AND type=page`;
    case "space":
      return `space=${scope.spaceKey} AND type=page`;
  }
}

/**
 * Get display string for a scope.
 */
export function scopeToString(scope: SyncScope): string {
  switch (scope.type) {
    case "page":
      return `page ${scope.pageId}`;
    case "tree":
      return `tree under ${scope.ancestorId}`;
    case "space":
      return `space ${scope.spaceKey}`;
  }
}

/**
 * Check if two scopes are equal.
 */
export function scopesEqual(a: SyncScope, b: SyncScope): boolean {
  if (a.type !== b.type) return false;

  switch (a.type) {
    case "page":
      return (b as typeof a).pageId === a.pageId;
    case "tree":
      return (b as typeof a).ancestorId === a.ancestorId;
    case "space":
      return (b as typeof a).spaceKey === a.spaceKey;
  }
}

/**
 * Helper to get string flag value.
 */
function getStringFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string
): string | undefined {
  const value = flags[name];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}
