/**
 * Default (Node) entry point for `@atlcli/confluence` (spec 009).
 *
 * Trimmed to the documented v1 seams — identical to the browser barrel: the
 * REST client, the storage<->markdown converter, the `ExportBlock` document
 * model, mention resolution, and page properties. This barrel must never
 * statically reach a `node:`/`bun:` builtin (the old wide barrel dragged in
 * `bun:sqlite` via `sync-db`, breaking plain-Node consumers at import time).
 *
 * The repo-internal sync machinery (atlcli-dir, sync-db, webhook-server,
 * poller, …) lives behind the explicitly non-frozen `./internal` subpath.
 */
export * from "./index.browser.js";
