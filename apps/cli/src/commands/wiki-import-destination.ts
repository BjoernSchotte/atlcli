import { ConfluenceClient } from "@atlcli/confluence";
import type { DestinationGovernance } from "@atlcli/import-docx";

export class TitlePreflightConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(`These titles already exist in the target space: ${conflicts.join(", ")}.`);
    this.name = "TitlePreflightConflictError";
  }
}

export async function findFreeTitle(
  client: ConfluenceClient,
  spaceKey: string,
  baseTitle: string,
  reserved: ReadonlySet<string> = new Set(),
): Promise<string> {
  for (let n = 2; n <= 50; n++) {
    const candidate = `${baseTitle} (${n})`;
    if (reserved.has(candidate.normalize("NFC").toLocaleLowerCase("en-US"))) continue;
    const matches = await client.findPagesByTitle(candidate, { spaceKey });
    if (matches.length === 0) return candidate;
  }
  throw new Error(`No free title variant found within 50 attempts.`);
}

export async function preflightImportTitles(
  client: ConfluenceClient,
  spaceKey: string,
  candidates: readonly { id: string; title: string }[],
  mode: "fail" | "rename",
): Promise<Map<string, string>> {
  const renames = new Map<string, string>();
  const conflicts: string[] = [];
  const reserved = new Set(candidates.map((item) => item.title.normalize("NFC").toLocaleLowerCase("en-US")));
  const claimed = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.title.normalize("NFC").toLocaleLowerCase("en-US");
    const matches = await client.findPagesByTitle(candidate.title, { spaceKey });
    const collides = matches.length > 0 || claimed.has(normalized);
    if (!collides) {
      claimed.add(normalized);
      continue;
    }
    if (mode === "fail") {
      conflicts.push(candidate.title);
      continue;
    }
    const free = await findFreeTitle(client, spaceKey, candidate.title, new Set([...reserved, ...claimed]));
    renames.set(candidate.id, free);
    const normalizedFree = free.normalize("NFC").toLocaleLowerCase("en-US");
    reserved.add(normalizedFree);
    claimed.add(normalizedFree);
  }
  if (conflicts.length > 0) throw new TitlePreflightConflictError(conflicts);
  return renames;
}

/** Apply and prove Cloud restrictions before sensitive bytes are written. */
export async function applyRestriction(
  client: ConfluenceClient,
  pageId: string,
  governance: DestinationGovernance,
  importerAccountId: string,
): Promise<void> {
  const restriction = governance.restriction;
  if (restriction.mode === "inherit") return;
  const withImporter = (ids: string[]) => ids.includes(importerAccountId) ? ids : [...ids, importerAccountId];
  const readAccounts = restriction.mode === "private"
    ? [importerAccountId]
    : withImporter(restriction.viewers.filter((principal) => principal.kind === "cloud-account").map((principal) => principal.accountId));
  const readGroups = restriction.mode === "private"
    ? []
    : restriction.viewers.filter((principal) => principal.kind === "cloud-group").map((principal) => principal.groupId);
  const updateAccounts = restriction.mode === "private"
    ? [importerAccountId]
    : withImporter(restriction.editors.filter((principal) => principal.kind === "cloud-account").map((principal) => principal.accountId));
  const updateGroups = restriction.mode === "private"
    ? []
    : restriction.editors.filter((principal) => principal.kind === "cloud-group").map((principal) => principal.groupId);

  await client.setContentRestrictions(pageId, {
    read: { accountIds: readAccounts, groupIds: readGroups },
    update: { accountIds: updateAccounts, groupIds: updateGroups },
  });
  const effective = await client.getContentRestrictions(pageId);
  const missing: string[] = [];
  for (const id of readAccounts) if (!effective.read.accountIds.includes(id)) missing.push("read account");
  for (const id of readGroups) if (!effective.read.groupIds.includes(id)) missing.push("read group");
  for (const id of updateAccounts) if (!effective.update.accountIds.includes(id)) missing.push("update account");
  for (const id of updateGroups) if (!effective.update.groupIds.includes(id)) missing.push("update group");
  if (effective.read.accountIds.length === 0 && effective.read.groupIds.length === 0) missing.push("empty read restriction");
  if (missing.length > 0) throw new Error(`Restriction readback failed: ${missing.join(", ")}.`);
}

/** Apply and prove required labels and namespaced content properties. */
export async function applyMetadata(
  client: ConfluenceClient,
  pageId: string,
  governance: DestinationGovernance,
): Promise<void> {
  if (governance.labels.length > 0) {
    await client.addLabels(pageId, governance.labels);
    const effective = new Set((await client.getLabels(pageId)).map((label) => label.name));
    const missing = governance.labels.filter((label) => !effective.has(label));
    if (missing.length > 0) throw new Error(`Label readback failed: ${missing.length} required label(s) are missing.`);
  }
  for (const property of governance.contentProperties) {
    await client.createPageProperty(pageId, property.key, property.value);
    const value = await client.getPagePropertyByKey(pageId, property.key);
    if (JSON.stringify(value) !== JSON.stringify(property.value)) {
      throw new Error(`Property readback failed for ${property.key}.`);
    }
  }
}
