import {
  Config,
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveDefaults,
} from "@atlcli/core";
import {
  ConfluenceClient,
  ConfluenceSearchResult,
} from "@atlcli/confluence";

type ClientWithDefaults = {
  client: ConfluenceClient;
  defaults: { project?: string; space?: string; board?: number };
};

async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<ConfluenceClient>;
async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  withDefaults: true
): Promise<ClientWithDefaults>;
async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  withDefaults?: boolean
): Promise<ConfluenceClient | ClientWithDefaults> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  const client = new ConfluenceClient(profile);
  if (withDefaults) {
    return { client, defaults: resolveDefaults(config, profile) };
  }
  return client;
}

export async function handleSearch(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // Show help if requested or no query provided
  if (hasFlag(flags, "help")) {
    output(searchHelp(), opts);
    return;
  }

  // Load config to get defaults
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  const defaults = resolveDefaults(config, profile);
  const defaultSpace = defaults.space;

  // Check for raw CQL mode
  const rawCql = getFlag(flags, "cql");
  if (rawCql) {
    await executeSearch(rawCql, flags, opts, config);
    return;
  }

  // Build CQL from query and filters
  const query = args.join(" ").trim();
  if (!query && !hasFilters(flags, defaultSpace)) {
    output(searchHelp(), opts);
    return;
  }

  const cql = buildCql(query, flags, defaultSpace);
  await executeSearch(cql, flags, opts, config);
}

function hasFilters(flags: Record<string, string | boolean | string[]>, defaultSpace?: string): boolean {
  return !!(
    getFlag(flags, "space") ||
    defaultSpace ||
    getFlag(flags, "type") ||
    getFlag(flags, "label") ||
    getFlag(flags, "title") ||
    getFlag(flags, "creator") ||
    getFlag(flags, "modified-since") ||
    getFlag(flags, "created-since") ||
    getFlag(flags, "ancestor")
  );
}

/**
 * Build CQL query from text search and flags.
 */
function buildCql(query: string, flags: Record<string, string | boolean | string[]>, defaultSpace?: string): string {
  const conditions: string[] = [];

  // Text search (full-text)
  if (query) {
    conditions.push(`text ~ "${escapeQuotes(query)}"`);
  }

  // Filter: space (use default if not specified)
  const space = getFlag(flags, "space") ?? defaultSpace;
  if (space) {
    // Support comma-separated spaces
    const spaces = space.split(",").map((s) => s.trim());
    if (spaces.length === 1) {
      conditions.push(`space = "${spaces[0]}"`);
    } else {
      conditions.push(`space IN (${spaces.map((s) => `"${s}"`).join(", ")})`);
    }
  }

  // Filter: type (default to page)
  const type = getFlag(flags, "type") || "page";
  if (type !== "all") {
    conditions.push(`type = ${type}`);
  }

  // Filter: label
  const label = getFlag(flags, "label");
  if (label) {
    // Support comma-separated labels
    const labels = label.split(",").map((l) => l.trim());
    if (labels.length === 1) {
      conditions.push(`label = "${labels[0]}"`);
    } else {
      // Multiple labels: use AND (all required)
      for (const l of labels) {
        conditions.push(`label = "${l}"`);
      }
    }
  }

  // Filter: title (contains)
  const title = getFlag(flags, "title");
  if (title) {
    conditions.push(`title ~ "${escapeQuotes(title)}"`);
  }

  // Filter: creator
  const creator = getFlag(flags, "creator");
  if (creator) {
    if (creator === "me" || creator === "currentUser") {
      conditions.push(`creator = currentUser()`);
    } else {
      conditions.push(`creator = "${escapeQuotes(creator)}"`);
    }
  }

  // Filter: modified-since (e.g., "7d", "30d", "2024-01-01")
  const modifiedSince = getFlag(flags, "modified-since");
  if (modifiedSince) {
    const dateExpr = parseDateExpression(modifiedSince);
    conditions.push(`lastModified >= ${dateExpr}`);
  }

  // Filter: created-since
  const createdSince = getFlag(flags, "created-since");
  if (createdSince) {
    const dateExpr = parseDateExpression(createdSince);
    conditions.push(`created >= ${dateExpr}`);
  }

  // Filter: ancestor (pages under a specific parent)
  const ancestor = getFlag(flags, "ancestor");
  if (ancestor) {
    conditions.push(`ancestor = ${ancestor}`);
  }

  return conditions.join(" AND ");
}

/**
 * Parse date expression to CQL format.
 * Supports:
 * - Relative: "7d", "30d", "1w", "2m"
 * - Date: "2024-01-15"
 * - Keywords: "today", "yesterday", "thisWeek", "thisMonth"
 */
function parseDateExpression(expr: string): string {
  const trimmed = expr.trim().toLowerCase();

  // Keywords
  if (trimmed === "today") {
    return "startOfDay()";
  }
  if (trimmed === "yesterday") {
    return "startOfDay(\"-1d\")";
  }
  if (trimmed === "thisweek" || trimmed === "this-week") {
    return "startOfWeek()";
  }
  if (trimmed === "thismonth" || trimmed === "this-month") {
    return "startOfMonth()";
  }

  // Relative time (e.g., "7d", "2w", "1m")
  const relMatch = expr.match(/^(\d+)([dwm])$/i);
  if (relMatch) {
    const [, num, unit] = relMatch;
    const cqlUnit = unit.toLowerCase() === "w" ? "w" : unit.toLowerCase();
    return `now("-${num}${cqlUnit}")`;
  }

  // ISO date (YYYY-MM-DD)
  const dateMatch = expr.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return `"${expr}"`;
  }

  // Fallback: pass through as-is (user may provide CQL function directly)
  return expr;
}

/**
 * Escape quotes in strings for CQL.
 */
function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}

/**
 * Execute search and format output.
 */
async function executeSearch(
  cql: string,
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  config?: Config
): Promise<void> {
  const cfg = config ?? await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(cfg, profileName);

  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {
      profile: profileName,
    });
  }

  const client = new ConfluenceClient(profile);

  const limit = Number(getFlag(flags, "limit") ?? 25);
  const start = Number(getFlag(flags, "start") ?? 0);
  const format = getFlag(flags, "format") || "table";

  // Determine detail level based on format (optimization)
  // - compact: minimal (just id/title/space)
  // - table: standard (adds version/dates/labels)
  // - json: full (all fields + excerpt)
  const detail = format === "compact" ? "minimal" : opts.json ? "full" : "standard";

  // Execute search
  const result = await client.search(cql, {
    limit: Number.isNaN(limit) ? 25 : limit,
    start: Number.isNaN(start) ? 0 : start,
    detail,
    excerpt: format === "table", // Only fetch excerpt for table format
  });

  // JSON output
  if (opts.json) {
    output(
      {
        schemaVersion: "1",
        cql,
        ...result,
      },
      opts
    );
    return;
  }

  // No results
  if (result.results.length === 0) {
    output("No results found.", opts);
    if (hasFlag(flags, "verbose")) {
      output(`\nCQL: ${cql}`, opts);
    }
    return;
  }

  // Format output based on format flag
  switch (format) {
    case "compact":
      formatCompact(result.results, opts);
      break;
    case "table":
    default:
      formatTable(result.results, opts);
      break;
  }

  // Summary
  const totalInfo = result.totalSize ? ` of ${result.totalSize}` : "";
  output(`\n${result.results.length}${totalInfo} results`, opts);

  if (result.hasMore) {
    output(`More results available. Use --start ${result.start + result.limit} to see next page.`, opts);
  }

  // Verbose: show CQL
  if (hasFlag(flags, "verbose")) {
    output(`\nCQL: ${cql}`, opts);
  }
}

/**
 * Format results as table.
 */
function formatTable(results: ConfluenceSearchResult[], opts: OutputOptions): void {
  // Header
  output(
    `${"Title".padEnd(40)} ${"Space".padEnd(10)} ${"Modified".padEnd(12)} ${"Labels"}`,
    opts
  );
  output("─".repeat(80), opts);

  for (const item of results) {
    const title = truncate(item.title, 38);
    const space = (item.spaceKey ?? "").padEnd(10);
    const modified = item.lastModified
      ? new Date(item.lastModified).toLocaleDateString()
      : "".padEnd(12);
    const labels = (item.labels ?? []).slice(0, 3).join(", ");

    output(`${title.padEnd(40)} ${space} ${modified.padEnd(12)} ${labels}`, opts);

    // Show excerpt if available
    if (item.excerpt) {
      const excerpt = truncate(cleanExcerpt(item.excerpt), 75);
      output(`  ${excerpt}`, opts);
    }
  }
}

/**
 * Format results in compact single-line format.
 */
function formatCompact(results: ConfluenceSearchResult[], opts: OutputOptions): void {
  for (const item of results) {
    const space = item.spaceKey ? `[${item.spaceKey}]` : "";
    output(`${item.id}  ${space} ${item.title}`, opts);
  }
}

/**
 * Clean excerpt HTML/formatting.
 */
function cleanExcerpt(excerpt: string): string {
  return excerpt
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/\n+/g, " ") // Replace newlines with spaces
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

/**
 * Truncate string to max length.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function searchHelp(): string {
  return `atlcli wiki search <query> [options]

Search Confluence content using text search or CQL.

Usage:
  atlcli wiki search "API documentation"
  atlcli wiki search --space DEV --label architecture
  atlcli wiki search --cql "type=page AND label=draft"

Text Search:
  atlcli wiki search <query>        Search for text in page content

Filters:
  --space <key>                Filter by space (comma-separated for multiple)
  --type <type>                Content type: page, blogpost, comment, all (default: page)
  --label <name>               Filter by label (comma-separated for multiple)
  --title <text>               Title contains text
  --creator <user>             Filter by creator (use "me" for current user)
  --ancestor <pageId>          Pages under a specific parent
  --modified-since <date>      Modified after date (7d, 30d, 2024-01-01, today, thisWeek)
  --created-since <date>       Created after date (same format as modified-since)

Output Options:
  --limit <n>                  Max results (default: 25)
  --start <n>                  Offset for pagination (default: 0)
  --format <type>              Output format: table, compact (default: table)
  --verbose                    Show the CQL query used
  --json                       JSON output

Raw CQL:
  --cql <query>                Use raw CQL query (ignores other filters)

Examples:
  atlcli wiki search "getting started"
  atlcli wiki search --space DEV,DOCS --modified-since 7d
  atlcli wiki search --label api --label documentation
  atlcli wiki search --creator me --created-since thisMonth
  atlcli wiki search --cql "type=page AND space=DEV AND lastModified >= startOfWeek()"

Date Expressions:
  7d, 30d          Days ago
  1w, 2w           Weeks ago
  1m               Months ago
  today            Start of today
  yesterday        Start of yesterday
  thisWeek         Start of current week
  thisMonth        Start of current month
  2024-01-15       Specific date

CQL Reference:
  Fields: text, title, space, type, label, creator, created, lastModified, ancestor
  Operators: =, !=, ~, !~, >, <, >=, <=, IN, NOT IN
  Functions: currentUser(), now(), startOfDay(), startOfWeek(), startOfMonth()
`;
}

/**
 * Handle `wiki recent` command - show recently modified pages.
 */
export async function handleRecent(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);

  const parts: string[] = ["type = page"];

  // Optional filters (use defaults)
  const space = getFlag(flags, "space") ?? defaults.space;
  const label = getFlag(flags, "label");
  const days = getFlag(flags, "days") ?? "7";

  if (space) {
    const spaces = space.split(",").map((s) => s.trim());
    if (spaces.length === 1) {
      parts.push(`space = "${spaces[0]}"`);
    } else {
      parts.push(`space IN (${spaces.map((s) => `"${s}"`).join(", ")})`);
    }
  }

  if (label) {
    parts.push(`label = "${label}"`);
  }

  // Add lastModified filter
  parts.push(`lastModified >= now("-${days}d")`);

  const cql = parts.join(" AND ") + " ORDER BY lastModified DESC";
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const result = await client.search(cql, { limit: Number.isNaN(limit) ? 25 : limit });

  if (opts.json) {
    output({ schemaVersion: "1", cql, results: result.results, total: result.totalSize }, opts);
  } else {
    if (result.results.length === 0) {
      output("No recently modified pages found.", opts);
      return;
    }
    formatTable(result.results, opts);
    output(`\n${result.results.length} pages`, opts);
  }
}

/**
 * Handle `wiki my` command - show pages created or contributed to by current user.
 */
export async function handleMy(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);

  const parts: string[] = ["type = page"];

  // Creator vs contributor
  if (hasFlag(flags, "contributed")) {
    parts.push("contributor = currentUser()");
  } else {
    parts.push("creator = currentUser()");
  }

  // Optional filters (use defaults)
  const space = getFlag(flags, "space") ?? defaults.space;
  const label = getFlag(flags, "label");

  if (space) {
    const spaces = space.split(",").map((s) => s.trim());
    if (spaces.length === 1) {
      parts.push(`space = "${spaces[0]}"`);
    } else {
      parts.push(`space IN (${spaces.map((s) => `"${s}"`).join(", ")})`);
    }
  }

  if (label) {
    parts.push(`label = "${label}"`);
  }

  const cql = parts.join(" AND ") + " ORDER BY lastModified DESC";
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const result = await client.search(cql, { limit: Number.isNaN(limit) ? 25 : limit });

  if (opts.json) {
    output({ schemaVersion: "1", cql, results: result.results, total: result.totalSize }, opts);
  } else {
    if (result.results.length === 0) {
      const mode = hasFlag(flags, "contributed") ? "contributed to" : "created";
      output(`No pages ${mode} by you found.`, opts);
      return;
    }
    formatTable(result.results, opts);
    output(`\n${result.results.length} pages`, opts);
  }
}
