import { ERROR_CODES, fail, type OutputOptions, type Profile } from "@atlcli/core";

/**
 * Exact error message emitted when a `session` auth profile is used from the CLI.
 * `session` auth relies on an ambient browser cookie and is only usable from a
 * browser context (the Chrome extension); the CLI must fail fast (spec 001 §2.4).
 */
export const SESSION_CLI_ERROR =
  'auth type "session" is only supported in browser contexts (Chrome extension)';

/**
 * Reject `session` auth profiles before any network client is constructed.
 *
 * `session` profiles authenticate via the ambient Atlassian browser session,
 * which has no meaning in a Node/CLI process. This is a deliberate hard failure,
 * not a silent fallback (spec 001 §2.4 / §3.3).
 */
export function assertCliAuthSupported(
  profile: Pick<Profile, "auth">,
  opts: OutputOptions
): void {
  if (profile.auth.type === "session") {
    fail(opts, 1, ERROR_CODES.AUTH, SESSION_CLI_ERROR);
  }
}
