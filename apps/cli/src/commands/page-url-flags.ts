import { ERROR_CODES, fail, getActiveProfile, getConfluenceBaseUrl, getFlag, loadConfig, parseConfluencePageRef, type ConfluencePageRef, type OutputOptions } from "@atlcli/core";

type Flags = Record<string, string | boolean | string[]>;

export const isPageUrl = (value: string | undefined): value is string => !!value && /^https?:\/\//i.test(value.trim());

/**
 * Flags that take a page id take a page URL of the profile's site as well:
 * each of `names` holding a URL becomes its page id here, once, before the
 * subcommand reads it. A URL of another site, or one without a page id, is a
 * usage error. Returns what the URLs resolved to, by flag name (a
 * `?focusedCommentId=` is in there for the commands that show comments).
 */
export async function resolvePageUrlFlags(flags: Flags, names: string[], opts: OutputOptions): Promise<Record<string, ConfluencePageRef>> {
  const urls = names.filter((name) => isPageUrl(getFlag(flags, name)));
  if (urls.length === 0) return {};
  const resolve = await pageUrlResolver(flags, opts);
  const refs: Record<string, ConfluencePageRef> = {};
  for (const name of urls) {
    refs[name] = resolve(getFlag(flags, name)!);
    flags[name] = refs[name]!.pageId;
  }
  return refs;
}

/** Turns page URLs of the active profile's site into page references; fails the command on any other URL. */
export async function pageUrlResolver(flags: Flags, opts: OutputOptions): Promise<(url: string) => ConfluencePageRef> {
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(await loadConfig(), profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  return (url) => {
    const ref = parseConfluencePageRef(getConfluenceBaseUrl(profile), url);
    if ("error" in ref) fail(opts, 1, ERROR_CODES.USAGE, ref.error);
    return ref;
  };
}
