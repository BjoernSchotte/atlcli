/**
 * Browser-safe entrypoint for `@atlcli/research`.
 *
 * This entrypoint adds only browser-safe REST adapters. The model runtime is
 * isolated behind `@atlcli/research/browser/agent`.
 */
export * from "./index.js";
export * from "./rest-provider.js";
export * from "./scope-catalog-provider.js";
