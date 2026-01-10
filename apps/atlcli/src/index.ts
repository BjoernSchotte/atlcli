import { hasFlag, output, parseArgs } from "@atlcli/core";
import { handleAuth } from "./commands/auth.js";
import { handlePage } from "./commands/page.js";
import { handleSpace } from "./commands/space.js";
import { handleDocs } from "./commands/docs.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, ...rest] = parsed._;
  const json = hasFlag(parsed.flags, "json");
  const opts = { json };

  if (!command) {
    output(rootHelp(), opts);
    return;
  }

  switch (command) {
    case "auth":
      await handleAuth(rest, parsed.flags, opts);
      return;
    case "page":
      await handlePage(rest, parsed.flags, opts);
      return;
    case "space":
      await handleSpace(rest, parsed.flags, opts);
      return;
    case "docs":
      await handleDocs(rest, parsed.flags, opts);
      return;
    case "version":
      output({ version: "0.1.0" }, opts);
      return;
    default:
      output(rootHelp(), opts);
  }
}

function rootHelp(): string {
  return `atlcli <command>

Commands:
  auth        Authenticate and manage profiles
  space       Confluence space operations
  page        Confluence page operations
  docs        Confluence docs sync (pull/push)
  version     Show version

Global options:
  --json      JSON output
  --help      Show help
`;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
