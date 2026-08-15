export * from "deepagents/browser";

// @langchain/quickjs@1.0.0 imports this root-only constant. The package's
// browser export omits it, so the exact-root Vite alias points here while all
// application imports continue to use deepagents/browser explicitly.
export const SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY =
  "__deepagents_subagent_response_format";
