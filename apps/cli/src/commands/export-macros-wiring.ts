/**
 * CLI host wiring for dynamic-macro resolution (spec 004, "Host wiring").
 *
 * ## This module is now a seam, not an implementation
 *
 * Everything it used to define lives in `@atlcli/export-wiring` (spec 010 W2-0).
 * The code was browser-safe by construction — it only ever needed
 * `ConfluenceClient`/`JiraClient`, both already isomorphic — but it sat under
 * `apps/cli/`, so the Chrome extension could not import it and grew a SECOND,
 * divergent copy of the external-asset policy. Promoting it deleted that copy
 * and made "the CLI and the panel reject the same URL" a testable claim (see
 * `@atlcli/export-wiring/fixtures`).
 *
 * What stays here is the CLI-shaped half: turning a `Profile` into the
 * `siteBaseUrl` the shared builder wants. Import sites keep their existing
 * specifier, so this file is also the place a reviewer looks to see exactly
 * which shared symbols the CLI depends on.
 */
import type { Profile } from "@atlcli/core";
import type { ConfluenceClient } from "@atlcli/confluence";
import type { JiraClient } from "@atlcli/jira";
import {
  buildMacroResolutionOptions as buildSharedMacroResolutionOptions,
  type JiraClientLike,
} from "@atlcli/export-wiring";
import type { MacroResolutionOptions } from "@atlcli/export-macros";

export {
  attachmentLookupFromClient,
  confluenceContentPortFromClient,
  defaultExternalAssetFetcher,
  defaultExternalAssetPolicy,
  exportViewPortFromClient,
  jiraIssuePortFromClient,
  trustRoutingAssetFetcher,
  trustRoutingPdfAssetResolver,
} from "@atlcli/export-wiring";

/**
 * A real `JiraClient` satisfies the shared structural `JiraClientLike` with no
 * cast. Compile-time only — if `packages/jira` ever changes `getIssue`/`search`
 * incompatibly, this line fails the typecheck instead of the wiring silently
 * needing an `as`.
 */
const _jiraClientSatisfiesPort: JiraClientLike = {} as JiraClient;
void _jiraClientSatisfiesPort;

export interface BuildMacroOptionsArgs {
  profile: Profile;
  confluence: ConfluenceClient;
  /** Present only when the profile has Jira access configured. */
  jira?: JiraClient;
  targetEngine: "docx" | "pdf";
  /** `false` for `--no-live-macros` (compliance/deterministic exports). */
  live?: boolean;
  /** Whether the DOCX template already carries a native TOC field. */
  nativeTocPresent?: boolean;
  /**
   * `composeChapters(...).chapterAnchorById` for a tree/space export, so a
   * renderer listing other Confluence pages links into THIS document for the
   * ones that are chapters of it. Omitted for single-page exports.
   */
  chapterAnchorById?: ReadonlyMap<string, string>;
  /** Cancels in-flight macro, attachment, and export-view requests. */
  signal?: AbortSignal;
}

/**
 * Assemble the `MacroResolutionOptions` the engine env accepts. The CLI's only
 * contribution is the profile → `siteBaseUrl` mapping; the ports, the registry,
 * the per-source-page `contextFor` and the same-origin external-asset policy
 * are the shared ones.
 */
export function buildMacroResolutionOptions(args: BuildMacroOptionsArgs): MacroResolutionOptions {
  return buildSharedMacroResolutionOptions({
    siteBaseUrl: args.profile.baseUrl,
    confluence: args.confluence,
    ...(args.jira ? { jira: args.jira } : {}),
    targetEngine: args.targetEngine,
    ...(args.live !== undefined ? { live: args.live } : {}),
    ...(args.nativeTocPresent !== undefined ? { nativeTocPresent: args.nativeTocPresent } : {}),
    ...(args.chapterAnchorById ? { chapterAnchorById: args.chapterAnchorById } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
}
