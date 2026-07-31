/**
 * Browser model-runtime entrypoint.
 *
 * This graph intentionally contains DeepAgentsJS, LangChain, Anthropic, and
 * QuickJS. Browser hosts must bundle it with the package's documented
 * optional-dependency aliases; the host-neutral and REST-only browser surfaces
 * remain independently importable without those model dependencies.
 */
export * from "./index.browser.js";
export * from "./scope-catalog-tools.js";
export * from "./agent-tools.js";
export * from "./dynamic-subagents.js";
export * from "./agent-runtime.browser.js";
