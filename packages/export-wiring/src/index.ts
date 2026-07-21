/**
 * `@atlcli/export-wiring` — the host-wiring layer between the real
 * Confluence/Jira REST clients and the pure export engines.
 *
 * ## What belongs here
 *
 * Everything an export host must do to turn a *client* into engine inputs, and
 * nothing that depends on *which* host is asking:
 *
 * - `@atlcli/export-macros` ports over `ConfluenceClient` / a `JiraClient`-shaped
 *   object (`./ports.js`);
 * - the external-asset security boundary — origin policy, SSRF guard,
 *   redirect-re-checking / byte-capped / deadline-bounded fetcher
 *   (`./asset-policy.js`);
 * - the sink-side trust routers that make that boundary apply to the bytes the
 *   ENGINES fetch, not just the ones the macro renderers fetch
 *   (`./trust-routing.js`);
 * - the `MacroResolutionOptions` assembly (`./macro-options.js`).
 *
 * ## Why a separate package
 *
 * `@atlcli/export-macros` cannot host this: `src/deps.ts` keeps that package at
 * ZERO runtime imports from any `@atlcli/*` package (that is what makes it
 * trivially isomorphic and injectable), and this layer must import
 * `@atlcli/confluence`. So the honest home is a small package one level up: it
 * depends on the clients AND on the engines' asset seams, and nothing depends
 * on it except hosts.
 *
 * All of it lived in `apps/cli/src/commands/export-macros-wiring.ts` until spec
 * 010 — browser-safe by construction, but unreachable from the extension, which
 * therefore grew a second copy of the asset policy. `scripts/check-browser-build.ts`
 * now proves this package builds for `--target=browser` with zero `node:`/`bun:`
 * specifiers, so there is no longer a reason for a second copy to exist.
 *
 * Host-specific concerns stay in the host: credentials and client construction,
 * session-expiry latching, origin allowlists beyond the site itself, UI wiring.
 */

/**
 * The two port types this package produces. Re-exported (not redefined) from
 * `@atlcli/export-macros` so a host that only depends on `@atlcli/export-wiring`
 * can still name what `createExternalAssetPolicy` returns.
 */
export type { ExternalAssetFetcher, ExternalAssetPolicy } from "@atlcli/export-macros";

// --- External-asset security boundary ---
export {
  createExternalAssetPolicy,
  createExternalAssetFetcher,
  defaultExternalAssetPolicy,
  defaultExternalAssetFetcher,
  externalAssetBlockedMessage,
  isExternalAssetBlockedError,
  isExternalAssetTimeoutError,
  isPrivateHost,
  parseIpv6,
  ExternalAssetBlockedError,
  ExternalAssetTimeoutError,
  EXTERNAL_ASSET_MAX_BYTES,
  EXTERNAL_ASSET_MAX_REDIRECTS,
  EXTERNAL_ASSET_TIMEOUT_MS,
} from "./asset-policy.js";
export type {
  ExternalAssetPolicyOptions,
  ExternalAssetFetcherDeps,
} from "./asset-policy.js";

// --- Ports over the real clients ---
export {
  attachmentLookupFromClient,
  classifyClientError,
  confluenceContentPortFromClient,
  exportViewPortFromClient,
  jiraIssuePortFromClient,
  jiraIssueRef,
} from "./ports.js";
export type { JiraClientLike, JiraIssueLike } from "./ports.js";

// --- Sink-side trust routing ---
export { trustRoutingAssetFetcher, trustRoutingPdfAssetResolver } from "./trust-routing.js";

// --- Macro resolution options ---
export { buildMacroResolutionOptions, createMacroRegistry } from "./macro-options.js";
export type { BuildMacroOptionsArgs } from "./macro-options.js";
