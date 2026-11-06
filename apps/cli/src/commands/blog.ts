import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  readTextFile,
  resolveDefaults,
} from "@atlcli/core";
import { ConfluenceClient, markdownToStorage } from "@atlcli/confluence/internal";
import { assertCliAuthSupported } from "./session-guard.js";
import { unknownSubcommand } from "./unknown-subcommand.js";
import { handlePage } from "./page.js";
import { applyRestriction } from "./wiki-import-destination.js";

type Flags = Record<string, string | boolean | string[]>;

export async function handleBlog(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(blogHelp(), opts);
    return;
  }
  const sub = args[0];
  switch (sub) {
    case "get":
    case "update":
      // `page get/update` read and preserve the content type, so they serve blog posts as-is.
      await handlePage([sub], flags, opts);
      return;
    case "list":
      await handleList(flags, opts);
      return;
    case "create":
      await handleCreate(flags, opts);
      return;
    case "delete":
      await handleDelete(flags, opts);
      return;
    default:
      unknownSubcommand(sub, blogHelp(), opts);
      return;
  }
}

async function setup(flags: Flags, opts: OutputOptions) {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  assertCliAuthSupported(profile, opts);
  return { client: new ConfluenceClient(profile), profile, defaults: resolveDefaults(config, profile) };
}

/** CQL for `blog list`. */
export function blogListCql(space: string | undefined): string {
  return space ? `space = "${space.replace(/["\\]/g, "\\$&")}" AND type = blogpost` : "type = blogpost";
}

async function handleList(flags: Flags, opts: OutputOptions): Promise<void> {
  const { client, defaults } = await setup(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const max = Number.isNaN(limit) ? 25 : limit;
  const blogposts = await client.searchPages(blogListCql(getFlag(flags, "space") ?? defaults.space), max, { maxResults: max });
  output({ schemaVersion: "1", blogposts }, opts);
}

async function handleCreate(flags: Flags, opts: OutputOptions): Promise<void> {
  const restriction = getFlag(flags, "restriction") ?? "inherit";
  if (restriction !== "inherit" && restriction !== "private") {
    fail(opts, 1, ERROR_CODES.USAGE, "--restriction must be inherit or private.");
  }
  const { client, profile, defaults } = await setup(flags, opts);
  const spaceKey = getFlag(flags, "space") ?? defaults.space;
  const title = getFlag(flags, "title");
  const bodyPath = getFlag(flags, "body");
  if (!spaceKey || !title || !bodyPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--space, --title, and --body are required.");
  }
  const storage = markdownToStorage(await readTextFile(bodyPath), {
    baseUrl: profile.baseUrl,
    emitWarnings: true,
    onWarning: (msg) => console.warn(msg),
  });

  if (restriction === "inherit") {
    const blogpost = await client.createPage({ type: "blogpost", spaceKey, title, storage });
    output({ schemaVersion: "1", blogpost }, opts);
    return;
  }

  // Private: an unpublished draft is visible only to its author. Restrict it,
  // prove the restriction, and only then publish with the body, so neither the
  // content nor a "new blog post" notification reaches anyone else.
  const me = await client.getCurrentUser();
  if (!me.accountId) fail(opts, 1, ERROR_CODES.API, "Could not resolve the current user's account id.");
  const draft = await client.createPage({ type: "blogpost", status: "draft", spaceKey, title, storage: "" });
  try {
    await applyRestriction(client, draft.id, { restriction: { mode: "private" } }, me.accountId);
  } catch (err) {
    fail(opts, 1, ERROR_CODES.API,
      `Restriction failed; blog post left as an unpublished draft (${draft.id}), visible only to you: ${err instanceof Error ? err.message : String(err)}`);
  }
  const blogpost = await client.publishDraft({ id: draft.id, type: "blogpost", spaceKey, title, storage });
  output({ schemaVersion: "1", blogpost, restriction: "private" }, opts);
}

async function handleDelete(flags: Flags, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  if (!hasFlag(flags, "confirm")) fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required for delete.");
  const { client } = await setup(flags, opts);
  const current = await client.getPage(id);
  // Guard: `blog delete` must never remove a page by a mistyped id.
  if (current.type !== "blogpost") {
    fail(opts, 1, ERROR_CODES.USAGE, `Content ${id} is a ${current.type ?? "unknown type"}, not a blog post. Use \`atlcli wiki page delete\`.`);
  }
  await client.deletePage(id);
  output(opts.json ? { schemaVersion: "1", deleted: [{ id, title: current.title }] } : `Deleted blog post "${current.title}" (${id})`, opts);
}

function blogHelp(): string {
  return `atlcli wiki blog <command>

Confluence blog post operations.

Commands:
  list [--space <key>] [--limit <n>]                 List blog posts
  get --id <id>                                      Get a blog post (with storage body)
  create --space <key> --title <title> --body <file> [--restriction inherit|private]
                                                     Publish a blog post from Markdown
  update --id <id> [--body <file>] [--title <title>] Update body and/or title
  delete --id <id> --confirm                         Delete (trash) a blog post

Options:
  --restriction private  Visible and editable only by you. Created as a draft,
                         restricted and verified, then published, so no one
                         else sees it or gets notified. Default: inherit (space).
  --profile <name>       Use a specific auth profile
  --json                 JSON output

Note: publishing a blog post is visible to the whole space and may notify
space watchers. Use --restriction private or your personal space (~key) to try things out.

Examples:
  atlcli wiki blog create --space ~jdoe --title "Draft notes" --body notes.md
  atlcli wiki blog create --space TEAM --title "Release 1.2" --body post.md --restriction private
  atlcli wiki blog update --id 12345 --body post.md --title "Release 1.2 (final)"
  atlcli wiki blog delete --id 12345 --confirm
`;
}
