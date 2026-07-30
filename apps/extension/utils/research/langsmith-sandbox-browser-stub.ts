/**
 * DeepAgentsJS exports its optional LangSmith sandbox backend from the same
 * browser-compatible module as the in-memory StateBackend used by this spike.
 * This fail-closed shim prevents the unused sandbox client (and its Node/tooling
 * dependency graph) from entering the MV3 worker bundle.
 */
export class LangSmithResourceNotFoundError extends Error {}

export class LangSmithSandboxError extends Error {}

export class SandboxClient {
  constructor() {
    throw new Error(
      "LangSmith sandboxes are disabled in the browser research worker."
    );
  }
}
