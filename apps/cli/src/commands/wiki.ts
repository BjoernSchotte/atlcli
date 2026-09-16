import { OutputOptions, output, hasFlag } from "@atlcli/core";
import { handlePage } from "./page.js";
import { handleSpace } from "./space.js";
import { handleDocs } from "./docs.js";
import { handleSearch, handleRecent, handleMy } from "./search.js";
import { handleTemplate } from "./template.js";
import { handleExport } from "./export.js";
import { handlePublish } from "./publish.js";
import { handleWikiImport } from "./wiki-import.js";
import { handleWikiMount } from "./wiki-mount.js";
import { handleWikiSh } from "./wiki-sh.js";
import { handleWikiVfs } from "./wiki-vfs.js";

export async function handleWiki(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;

  // Show help if --help/-h with no subcommand, or no subcommand at all
  if (!sub) {
    output(wikiHelp(), opts);
    return;
  }

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
    case "recent":
      await handleRecent(rest, flags, opts);
      return;
    case "my":
      await handleMy(rest, flags, opts);
      return;
    case "template":
      await handleTemplate(rest, flags, opts);
      return;
    case "export":
      await handleExport(rest, flags, opts);
      return;
    case "import":
      await handleWikiImport(rest, flags, opts);
      return;
    case "publish":
      await handlePublish(rest, flags, opts);
      return;
    case "sh":
      await handleWikiSh(rest, flags, opts);
      return;
    case "mount":
      await handleWikiMount(rest, flags, opts);
      return;
    case "unmount":
      await handleWikiMount(["unmount", ...rest], flags, opts);
      return;
    case "vfs":
      await handleWikiVfs(rest, flags, opts);
      return;
    default:
      output(wikiHelp(), opts);
      return;
  }
}

function wikiHelp(): string {
  return `atlcli wiki <command>

Confluence wiki operations.

Commands:
  page      Page operations (list, get, create, update, delete, move, copy)
  space     Space operations (list, get, create)
  docs      Local sync (init, pull, push, status, watch, sync)
  search    Search Confluence content with CQL
  my        My pages (created or contributed)
  recent    Recently modified pages
  template  Page template management
  export    Export page to DOCX or PDF
  import    Import DOCX or PDF as Confluence page(s) (review-first)
  publish   Build and verify a static Astro publication
  sh        Confluence as a filesystem, in an embedded shell
  mount     Mount Confluence as a real OS volume (WebDAV on loopback)
  vfs       Virtual filesystem maintenance (cache, conflicts)

Options:
  --profile <name>  Use a specific auth profile
  --json            JSON output

Examples:
  atlcli wiki page list --space TEAM
  atlcli wiki space get --key DOCS
  atlcli wiki docs pull ./docs --space TEAM
  atlcli wiki search "API docs" --space DEV
  atlcli wiki export 12345 --template corporate --output ./report.docx
  atlcli wiki publish run --project .atlcli/publish.json --confirm-public
  atlcli wiki sh --space DOCSY -c 'grep -rlw kubernetes . | head'
  atlcli wiki mount ~/confluence --space DOCSY
  atlcli wiki vfs cache stats
`;
}
