import { installCodeHighlightEngine } from "./highlight-engine-state.js";

/** Install Shiki's CSP-safe JavaScript RegExp engine for browser hosts. */
export function installJavaScriptHighlightEngine(): void {
  installCodeHighlightEngine({
    id: "javascript",
    create: async () => {
      const { createJavaScriptRegexEngine } = await import(
        "shiki/engine/javascript"
      );
      return createJavaScriptRegexEngine();
    },
  });
}
