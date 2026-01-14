import { OutputOptions, output } from "@atlcli/core";
import { handlePage } from "./page.js";
import { handleSpace } from "./space.js";
import { handleDocs } from "./docs.js";
import { handleSearch } from "./search.js";
import { handleTemplate } from "./template.js";

export async function handleWiki(
  args: string[],
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "page":
      await handlePage(rest, flags, opts);
      return;
    case "space":
      await handleSpace(rest, flags, opts);
      return;
    case "docs":
      await handleDocs(rest, flags, opts);
      return;
    case "search":
      await handleSearch(rest, flags, opts);
      return;
    case "template":
      await handleTemplate(rest, flags, opts);
      return;
    default:
      output(wikiHelp(), opts);
      return;
  }
}

function wikiHelp(): string {
  return `atlcli wiki <command>

Commands:
  page        Page operations (list, get, create, update, delete, move, copy)
  space       Space operations (list, get, create)
  docs        Docs sync (init, pull, push, status, watch)
  search      Search Confluence content
  template    Page template management

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  atlcli wiki page list --space TEAM
  atlcli wiki space get --key DOCS
  atlcli wiki docs pull ./docs
  atlcli wiki search "query" --space TEAM
`;
}
