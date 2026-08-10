import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputFile = process.argv[2];
if (!outputFile) {
  throw new Error("Expected the packed-worker output path as the first argument.");
}

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const researchModule = (name: string): string =>
  fileURLToPath(new URL(`../utils/research/${name}.ts`, import.meta.url));

const result = await Bun.build({
  entrypoints: [
    fileURLToPath(
      new URL(
        "../tests/research/packed/dispatch-characterization.worker.ts",
        import.meta.url,
      ),
    ),
  ],
  root: extensionRoot,
  outdir: dirname(outputFile),
  naming: basename(outputFile),
  target: "browser",
  format: "esm",
  conditions: ["development", "browser"],
  plugins: [{
    name: "research-dispatch-characterization-browser-aliases",
    setup(build) {
      build.onResolve(
        { filter: /^json-schema-to-typescript$/ },
        () => ({ path: researchModule("json-schema-to-typescript-browser") }),
      );
      build.onResolve(
        { filter: /^langsmith\/experimental\/sandbox$/ },
        () => ({ path: researchModule("langsmith-sandbox-browser-stub") }),
      );
      build.onResolve(
        { filter: /^micromatch$/ },
        () => ({ path: researchModule("micromatch-browser") }),
      );
      build.onResolve(
        { filter: /^deepagents$/ },
        () => ({ path: researchModule("deepagents-browser-compat") }),
      );
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Failed to build the packed dispatch characterization worker.");
}

const quickJsEntry = fileURLToPath(import.meta.resolve("@langchain/quickjs"));
const quickJsPackageRoot = dirname(dirname(quickJsEntry));
const quickJsWasm = join(
  dirname(dirname(quickJsPackageRoot)),
  "@jitl",
  "quickjs-ng-wasmfile-release-asyncify",
  "dist",
  "emscripten-module.wasm",
);
await Bun.write(
  join(dirname(outputFile), "emscripten-module.wasm"),
  Bun.file(quickJsWasm),
);
