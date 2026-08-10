import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const QUICKJS_CLI_WASM_FILE = "emscripten-module.wasm";
const QUICKJS_CLI_WASM_SPECIFIER = "@jitl/quickjs-ng-wasmfile-release-asyncify/wasm";

export interface QuickJsCliRuntimeAssetOptions {
  outputDirectory: string;
  resolve?: (specifier: string) => string;
}

/**
 * Materialize the exact filename used by quickjs-emscripten's Node ESM
 * loader. Bun bundles the JavaScript loader but does not copy its sibling WASM
 * automatically, so the CLI distribution owns this explicit asset contract.
 */
export async function materializeQuickJsCliRuntimeAsset(
  options: QuickJsCliRuntimeAssetOptions,
): Promise<string> {
  const resolve = options.resolve ?? ((specifier: string) => import.meta.resolve(specifier));
  const sourceUrl = resolve(QUICKJS_CLI_WASM_SPECIFIER);
  if (!sourceUrl.startsWith("file:")) {
    throw new Error("The QuickJS CLI runtime asset must resolve to a local file.");
  }
  const target = join(options.outputDirectory, QUICKJS_CLI_WASM_FILE);
  await mkdir(options.outputDirectory, { recursive: true });
  await copyFile(fileURLToPath(sourceUrl), target);
  return target;
}
