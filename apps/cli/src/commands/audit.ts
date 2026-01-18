import { ERROR_CODES, OutputOptions, fail, getFlagValue, output } from "@atlcli/core";
import { handleAuditWiki } from "./audit-wiki.js";

export async function handleAudit(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // Check feature flag
  const auditEnabled = await getFlagValue<boolean>("audit", false);
  if (!auditEnabled) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      "Audit feature is not enabled. Run: atlcli flag set audit true --global"
    );
  }

  const sub = args[0];

  if (!sub) {
    output(auditHelp(), opts);
    return;
  }

  switch (sub) {
    case "wiki":
      await handleAuditWiki(args.slice(1), flags, opts);
      return;
    // Future: case "jira":
    default:
      output(auditHelp(), opts);
      return;
  }
}

export function auditHelp(): string {
  return `Usage: atlcli audit <target> [options]

Targets:
  wiki                  Audit Confluence wiki content

Run 'atlcli audit wiki --help' for wiki-specific options.

Setup:
  1. Enable the feature:  atlcli flag set audit true --global
  2. Sync content first:  atlcli wiki docs pull
  3. Run audit:          atlcli audit wiki --all --stale-high 12

Examples:
  atlcli audit wiki --all --stale-high 12 --stale-medium 6
  atlcli audit wiki --orphans
  atlcli audit wiki --broken-links
  atlcli audit wiki --single-contributor
  atlcli audit wiki --external-links
  atlcli audit wiki --all --json > report.json
  atlcli audit wiki --all --markdown > AUDIT-REPORT.md`;
}
