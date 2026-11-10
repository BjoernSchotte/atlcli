/**
 * Test-support entrypoint for `@atlcli/research/testing`.
 *
 * Reusable conformance suites for hosts that implement a session store, a
 * data namespace, or a chat retrieval workspace. Not part of the runtime
 * surface: production code must not import it.
 */
export * from "./session-store-conformance.js";
export * from "./data-store-conformance.js";
export * from "./chat-agent/retrieval-plan-conformance.js";
