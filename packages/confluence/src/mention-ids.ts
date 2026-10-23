/**
 * A Confluence user mention: `<ac:link><ri:user ri:account-id|ri:userkey …/></ac:link>`,
 * attributes in any order, optionally with a plain-text or rich link body.
 * Groups: 1 = `ri:user` attributes, 2 = plain-text body, 3 = rich body.
 */
export const STORAGE_MENTION_PATTERN =
  /<ac:link\b[^>]*>\s*<ri:user\b([^>]*?)\s*(?:\/>|>\s*<\/ri:user>)\s*(?:<ac:plain-text-link-body>([\s\S]*?)<\/ac:plain-text-link-body>|<ac:link-body>([\s\S]*?)<\/ac:link-body>)?\s*<\/ac:link>/gi;

/** Prefix of a Server/Data Center user key in a mention id; Cloud account ids have none. */
export const USERKEY_MENTION_PREFIX = "userkey:";

/**
 * The mention id of an `ri:user` attribute list: the account id, or
 * `userkey:<key>` for a Server/Data Center mention.
 */
export function mentionIdFromAttributes(attrs: string): string | undefined {
  const accountId = /\bri:account-id="([^"]+)"/.exec(attrs)?.[1];
  if (accountId) return accountId;
  const userKey = /\bri:userkey="([^"]+)"/.exec(attrs)?.[1];
  return userKey ? `${USERKEY_MENTION_PREFIX}${userKey}` : undefined;
}

/** The distinct mention ids in storage bodies, for a name lookup before conversion. */
export function storageMentionIds(storages: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const storage of storages) {
    for (const match of storage.matchAll(STORAGE_MENTION_PATTERN)) {
      const id = mentionIdFromAttributes(match[1] ?? "");
      if (id) ids.add(id);
    }
  }
  return [...ids];
}
