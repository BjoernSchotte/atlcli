/**
 * Browser-safe entrypoint for `@atlcli/research`.
 *
 * Only JSON-safe, host-neutral research and capability contracts belong in
 * this graph. Hosts provide credentials, persistence, Atlassian transport,
 * model access, and sandbox execution through later adapters.
 */
export * from "./contracts.js";
export * from "./capability-contracts.js";
