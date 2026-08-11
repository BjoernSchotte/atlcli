import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { ACTION_PALETTE_CONSUMER_FIXTURES_V1 } from "./consumer-fixtures.js";

interface ConsumerReportV1 {
  readonly host: string;
  readonly reactVersion: string;
  readonly runtimeMarker: string;
  readonly loadedReactRoots: readonly string[];
  readonly markerOccurrences: number;
  readonly versionOccurrences: number;
}

interface BoundaryReportV1 {
  readonly success: boolean;
  readonly importedSpecifiers: readonly string[];
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly consumers: readonly ConsumerReportV1[];
}

const packageRoot = resolve(import.meta.dir, "../..");
const entrypoint = join(packageRoot, "src/index.ts");
const externalReact = ["react", "react/*", "react-dom", "react-dom/*"];

function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

async function buildPresenter(): Promise<{ source: string; imports: string[] }> {
  const imported = new Set<string>();
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: true,
    external: externalReact,
    plugins: [{
      name: "record-imports",
      setup(build) {
        build.onResolve({ filter: /.*/u }, (args) => {
          if (args.kind !== "entry-point-build" && args.kind !== "entry-point-run") {
            imported.add(args.path);
          }
          return undefined;
        });
      },
    }],
  });
  if (!result.success || !result.outputs[0]) {
    throw new Error(result.logs.map(String).join("\n") || "Presenter build emitted no output");
  }
  return {
    source: await result.outputs[0].text(),
    imports: [...imported].sort(),
  };
}

async function writeHostReact(root: string, marker: string, version: string): Promise<void> {
  const reactRoot = join(root, "node_modules/react");
  const reactDomRoot = join(root, "node_modules/react-dom");
  await Promise.all([mkdir(reactRoot, { recursive: true }), mkdir(reactDomRoot, { recursive: true })]);
  await writeFile(join(reactRoot, "package.json"), JSON.stringify({
    name: "react",
    version,
    type: "module",
    exports: {
      ".": "./index.js",
      "./jsx-runtime": "./jsx-runtime.js",
      "./jsx-dev-runtime": "./jsx-dev-runtime.js",
    },
  }));
  await writeFile(join(reactRoot, "index.js"), [
    `export const version = ${JSON.stringify(version)};`,
    `export const __hostMarker = ${JSON.stringify(marker)};`,
    "export const Fragment = Symbol.for('react.fragment');",
    "export const useCallback = (value) => value;",
    "export const useEffect = () => undefined;",
    "export const useLayoutEffect = () => undefined;",
    "export const useMemo = (value) => value();",
    "export const useReducer = () => [undefined, () => undefined];",
    "export const useRef = (value) => ({ current: value });",
    "export const useState = (value) => [typeof value === 'function' ? value() : value, () => undefined];",
    "export default { version, __hostMarker };",
  ].join("\n"));
  await writeFile(join(reactRoot, "jsx-runtime.js"), [
    "export const Fragment = Symbol.for('react.fragment');",
    "export const jsx = (type, props, key) => ({ type, props, key });",
    "export const jsxs = jsx;",
  ].join("\n"));
  await writeFile(join(reactRoot, "jsx-dev-runtime.js"), [
    "export const Fragment = Symbol.for('react.fragment');",
    "export const jsxDEV = (type, props, key) => ({ type, props, key });",
  ].join("\n"));
  await writeFile(join(reactDomRoot, "package.json"), JSON.stringify({
    name: "react-dom",
    version,
    type: "module",
    exports: { ".": "./index.js" },
  }));
  await writeFile(join(reactDomRoot, "index.js"), "export const createPortal = (node) => node;\n");
}

async function proveConsumer(
  fixture: (typeof ACTION_PALETTE_CONSUMER_FIXTURES_V1)[number],
  presenterSource: string,
): Promise<ConsumerReportV1> {
  const root = await mkdtemp(join(tmpdir(), `atlcli-palette-${fixture.host}-`));
  try {
    const realRoot = (await realpath(root)).replaceAll("\\", "/");
    const packageDir = join(root, "node_modules/@atlcli/action-palette-react");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "@atlcli/action-palette-react",
      type: "module",
      exports: "./index.js",
      peerDependencies: { react: ">=18 <20", "react-dom": ">=18 <20" },
    }));
    await writeFile(join(packageDir, "index.js"), presenterSource);
    await writeHostReact(root, fixture.runtimeMarker, fixture.reactVersion);

    const consumerEntry = join(root, "consumer.ts");
    await writeFile(consumerEntry, [
      "import React, { __hostMarker, version } from 'react';",
      "import { ActionPaletteV1 } from '@atlcli/action-palette-react';",
      "export const proof = [React, __hostMarker, version, ActionPaletteV1];",
    ].join("\n"));

    const loadedReactRoots = new Set<string>();
    let loadedReactSource = "";
    const result = await Bun.build({
      entrypoints: [consumerEntry],
      target: "browser",
      format: "esm",
      minify: true,
      plugins: [{
        name: "record-host-react-runtime",
        setup(build) {
          build.onLoad({ filter: /node_modules[\\/](?:react|react-dom)[\\/].*[.]js$/u }, async (args) => {
            const normalized = args.path.replaceAll("\\", "/");
            const match = normalized.match(/^(.*\/node_modules\/(?:react|react-dom))\//u);
            if (match?.[1]) loadedReactRoots.add(match[1]);
            const contents = await Bun.file(args.path).text();
            loadedReactSource += contents;
            return { contents, loader: "js" };
          });
        },
      }],
    });
    if (!result.success || !result.outputs[0]) {
      throw new Error(result.logs.map(String).join("\n") || `${fixture.host} consumer emitted no output`);
    }
    const normalizedRoots = [...loadedReactRoots].map((path) => path.replaceAll("\\", "/"));
    const unexpectedRoot = normalizedRoots.find((path) =>
      !path.startsWith(`${realRoot}/node_modules/`)
    );
    if (unexpectedRoot) {
      throw new Error(`${fixture.host} resolved React outside its host root: ${unexpectedRoot}`);
    }
    return {
      host: fixture.host,
      reactVersion: fixture.reactVersion,
      runtimeMarker: fixture.runtimeMarker,
      loadedReactRoots: normalizedRoots
        .map((path) => relative(realRoot, path).replaceAll("\\", "/"))
        .sort(),
      markerOccurrences: count(loadedReactSource, fixture.runtimeMarker),
      versionOccurrences: count(loadedReactSource, fixture.reactVersion),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const presenter = await buildPresenter();
const consumers = await Promise.all(
  ACTION_PALETTE_CONSUMER_FIXTURES_V1.map((fixture) => proveConsumer(fixture, presenter.source)),
);
const report: BoundaryReportV1 = {
  success: true,
  importedSpecifiers: presenter.imports,
  bytes: new TextEncoder().encode(presenter.source).byteLength,
  gzipBytes: gzipSync(presenter.source).byteLength,
  consumers,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
