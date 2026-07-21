/**
 * Default (Node) entry point for `@atlcli/jira`.
 *
 * The isomorphic half — the REST client and its types — is defined once in
 * `./index.browser.ts` and re-exported here, so the two barrels cannot drift
 * (the same arrangement `@atlcli/confluence` uses). Everything added below
 * reaches a `node:`/`bun:` builtin and is therefore Node/Bun-only: worklog
 * reporting, template storage, the webhook server, and the file-based
 * import/export helpers.
 *
 * A browser host must import `@atlcli/jira/browser`, never this barrel.
 */
export * from "./index.browser.js";
export * from "./worklog.js";
export * from "./analysis.js";
export * from "./export.js";
export * from "./import.js";
export * from "./webhook-server.js";
export * from "./templates.js";
