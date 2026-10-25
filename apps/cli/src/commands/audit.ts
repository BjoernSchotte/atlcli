import { ERROR_CODES, OutputOptions, fail, getFlagValue, output } from "@atlcli/core";
import { handleAuditJira } from "./audit-jira.js";
import { handleAuditWiki } from "./audit-wiki.js";
import { unknownSubcommand } from "./unknown-subcommand.js";

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
    case "jira":
      await handleAuditJira(args.slice(1), flags, opts);
      return;
    case "init": {
      const { handleAuditInit } = await import("./audit-scripts.js");
      await handleAuditInit(flags, opts);
      return;
    }
    default:
      unknownSubcommand(sub, auditHelp(), opts);
      return;
  }
}

export function auditHelp(): string {
  return `Usage: atlcli audit <target> [options]

Targets:
  wiki                  Audit Confluence wiki content (reads the sync database)
  jira                  Audit Jira issues: stuck or unassigned work, stale issues, hygiene gaps
  init                  Write a rule script skeleton and its types to ./.atlcli/audit/
                        (--product jira|confluence, --force)

Rules are TypeScript scripts run read-only in the script sandbox. Built-ins can be
printed (--print-rule <id>) and replaced by a script with the same id.

Run 'atlcli audit wiki --help' or 'atlcli audit jira --help' for target options.

Setup:
  1. Enable the feature:  atlcli flag set audit true --global
  2. Sync content first:  atlcli wiki docs pull
  3. Run audit:          atlcli audit wiki

Examples:
  atlcli audit wiki
  atlcli audit wiki --stale-high 12 --stale-medium 6 --orphans
  atlcli audit wiki --checks links --fail-on warning
  atlcli audit wiki --all --json > report.json
  atlcli audit wiki --all --markdown > AUDIT-REPORT.md
  atlcli audit wiki --stale-high 12 --fix
  atlcli audit jira --project ATLCLI
  atlcli audit jira --board 123 --checks stuck-wip --json
  atlcli audit init --product jira`;
}
