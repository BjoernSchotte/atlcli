import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface BoundaryReportV1 {
  readonly success: boolean;
  readonly importedSpecifiers: readonly string[];
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly consumers: readonly {
    readonly host: "extension" | "forge";
    readonly reactVersion: string;
    readonly runtimeMarker: string;
    readonly loadedReactRoots: readonly string[];
    readonly markerOccurrences: number;
    readonly versionOccurrences: number;
  }[];
}

const packageRoot = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  sideEffects?: readonly string[];
};

function runBoundaryProbe(): BoundaryReportV1 {
  const result = spawnSync(
    process.execPath,
    ["--conditions=development", join(import.meta.dir, "testing/package-boundary-probe.ts")],
    { cwd: join(import.meta.dir, "../../.."), encoding: "utf8", timeout: 60_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as BoundaryReportV1;
}

describe("published presenter boundary", () => {
  test("keeps React host-owned and rejects a second dialog/listbox framework", () => {
    expect(manifest.peerDependencies).toEqual({ react: ">=18 <20", "react-dom": ">=18 <20" });
    expect(manifest.dependencies).toEqual({ "@atlcli/action-registry": "workspace:*" });
    expect(manifest.sideEffects).toEqual(["./styles.css"]);
    expect(manifest.exports?.["./styles.css"]).toBe("./styles.css");

    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    });
    expect(dependencyNames).not.toContain("@radix-ui/react-dialog");
    expect(dependencyNames).not.toContain("@headlessui/react");
    expect(dependencyNames).not.toContain("cmdk");
    expect(dependencyNames).not.toContain("downshift");
  });

  test("builds for browsers without Node, Bun, Forge, WXT, or extension APIs", () => {
    const report = runBoundaryProbe();
    expect(report.success).toBe(true);
    expect(report.importedSpecifiers).toContain("react");
    expect(
      report.importedSpecifiers.some((specifier) =>
        specifier === "react/jsx-runtime" || specifier === "react/jsx-dev-runtime"
      ),
    ).toBe(true);
    expect(report.importedSpecifiers).toContain("react-dom");
    expect(report.importedSpecifiers).not.toContain("react-dom/client");
    expect(report.importedSpecifiers).not.toContain("@forge/bridge");
    expect(report.importedSpecifiers).not.toContain("wxt");
    expect(report.importedSpecifiers).not.toContain("bun");
    expect(report.importedSpecifiers.some((specifier) => specifier.startsWith("node:"))).toBe(false);
    expect(report.bytes).toBeLessThan(60_000);
    expect(report.gzipBytes).toBeLessThan(15_000);
  });

  test("resolves exactly one host React runtime in Extension and Forge fixtures", () => {
    const { consumers } = runBoundaryProbe();
    expect(consumers.map(({ host, reactVersion, loadedReactRoots }) => ({
      host,
      reactVersion,
      loadedReactRoots,
    }))).toEqual([
      {
        host: "extension",
        reactVersion: "19.2.0",
        loadedReactRoots: ["node_modules/react", "node_modules/react-dom"],
      },
      {
        host: "forge",
        reactVersion: "18.3.1",
        loadedReactRoots: ["node_modules/react", "node_modules/react-dom"],
      },
    ]);
    for (const consumer of consumers) {
      expect(consumer.markerOccurrences).toBe(1);
      expect(consumer.versionOccurrences).toBe(1);
    }
  });
});
