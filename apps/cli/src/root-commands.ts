/**
 * The built-in root commands, in help order. The root help and shell
 * completion both read this list, so a new command cannot show up in one and
 * be missing from the other (#279).
 */
export const ROOT_COMMANDS: ReadonlyArray<readonly [name: string, description: string]> = [
  ["auth", "Authenticate and manage profiles"],
  ["completion", "Generate shell completion scripts"],
  ["config", "Manage CLI configuration"],
  ["doctor", "Diagnose common issues"],
  ["flag", "Manage feature flags"],
  ["wiki", "Confluence operations (page, space, docs, search)"],
  ["jira", "Jira operations (issue, board, sprint, epic)"],
  ["digest", "What changed since your last look, across Jira and Confluence"],
  ["audit", "Check Jira hygiene and Confluence docs against rules"],
  ["research", "Run bounded read-only Jira + Confluence research"],
  ["chat", "Ask a read-only Jira or Confluence question"],
  ["pdf-template", "Create reviewed PDF template packs from Word documents"],
  ["log", "Query and manage logs"],
  ["models", "Optional local models (table structure for PDF import)"],
  ["plugin", "Manage plugins"],
  ["update", "Check for and install updates"],
  ["version", "Show version"],
  ["release-info", "Show versioned build provenance"],
];
