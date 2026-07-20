/**
 * CLI-side export orchestration helpers.
 *
 * The token asset fetcher + verified disk byte cache moved to
 * `@atlcli/export-node` (spec 009, batteries-included Node consumer) — the
 * CLI re-exports them here so existing imports and their regression tests
 * keep working against the single shared implementation.
 */
import type { ExportMentionLookup } from "@atlcli/confluence";

export {
  createAssetByteCache,
  tokenAssetFetcher,
  type AssetByteCache,
  type AssetClient,
} from "@atlcli/export-node";

interface MentionClient {
  getUsersBulk(accountIds: string[]): Promise<Map<string, { displayName: string | null } | null>>;
}

/**
 * Token-auth {@link ExportMentionLookup} backed by the client's bulk user fetch
 * (spec 008 T3.2). Shared by the PDF and both ts DOCX paths so `@mention`s
 * resolve to display names identically to the extension pipeline. Dedup across a
 * tree/space document happens upstream in `resolveExportMentions` (one bulk call
 * per unique id set).
 */
export function tokenMentionLookup(client: MentionClient): ExportMentionLookup {
  return async (accountIds) => {
    const users = await client.getUsersBulk(accountIds);
    const out = new Map<string, string | null>();
    for (const id of accountIds) out.set(id, users.get(id)?.displayName ?? null);
    return out;
  };
}

/** Cheap, conservative gate before loading the resvg wasm and bundled fonts. */
export function mightContainMermaid(storage: string): boolean {
  return /<ac:parameter\b[^>]*\bac:name\s*=\s*["']language["'][^>]*>\s*mermaid\s*<\/ac:parameter\s*>/i.test(
    storage
  );
}

/** Start only the page-key-dependent requests named by the local template scan. */
export function prestartPageDependentDeps(input: {
  pagePromise: Promise<{ spaceKey?: string }>;
  templateDeps: ReadonlySet<string>;
  embedImages: boolean;
  getSpaceWithIcon: (spaceKey: string) => Promise<unknown>;
  getSpaceHomepageStorage: (spaceKey: string) => Promise<unknown>;
}): void {
  const prefetch = input.pagePromise.then((details) => {
    const key = details.spaceKey;
    if (!key) return;
    if (
      input.templateDeps.has("space") ||
      (input.embedImages && input.templateDeps.has("spaceLogo"))
    ) {
      input.getSpaceWithIcon(key).catch(() => {});
    }
    if (input.templateDeps.has("spaceHomepage")) {
      input.getSpaceHomepageStorage(key).catch(() => {});
    }
  });
  // The engine still awaits the original page promise and reports that error.
  // This derived optimization branch must never become an unhandled rejection.
  prefetch.catch(() => {});
}
