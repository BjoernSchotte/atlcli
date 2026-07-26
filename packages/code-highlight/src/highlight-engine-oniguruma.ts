import { installCodeHighlightEngine } from "./highlight-engine-state.js";

/** Install Shiki's Oniguruma/WASM RegExp engine for Node and Bun hosts. */
export function installOnigurumaHighlightEngine(): void {
  installCodeHighlightEngine({
    id: "oniguruma",
    create: async () => {
      const [{ createOnigurumaEngine }, wasm] = await Promise.all([
        import("shiki/engine/oniguruma"),
        import("shiki/wasm"),
      ]);
      return createOnigurumaEngine(Promise.resolve(wasm));
    },
  });
}
