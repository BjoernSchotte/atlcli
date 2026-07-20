/**
 * Profile → `TreeSource` wiring (spec 009 / BASELINE-DESIGN §A5).
 *
 * `@atlcli/confluence` exports `confluenceTreeSource(client)` (a client → port
 * adapter); this wraps it one level higher so a host starts from a `Profile`:
 *
 * ```ts
 * const tree = await fetchExportTree(confluenceTreeSource(profile),
 *   { kind: "tree", rootPageId: "123" }, { labels: { exclude: ["internal"] } });
 * ```
 */
import {
  ConfluenceClient,
  confluenceTreeSource as clientTreeSource,
  type TreeSource,
} from "@atlcli/confluence";
import type { Profile } from "@atlcli/core";

/** A {@link TreeSource} over a token-auth `ConfluenceClient` for `profile`. */
export function confluenceTreeSource(profile: Profile): TreeSource {
  return clientTreeSource(new ConfluenceClient(profile));
}
