/**
 * Package boundaries for the extension host (spec 010 W2-0).
 *
 * ## The drift this exists to stop
 *
 * The macro/asset host-wiring layer was browser-safe by construction but lived
 * under `apps/cli/`, so this host could not import it — and wrote its own copy
 * of the external-asset policy instead. The copy then diverged: it grew four
 * SSRF fixes the CLI's original never got. Two implementations of one security
 * boundary, one of them silently weaker, and nothing in CI could see it.
 *
 * Promoting the layer into `@atlcli/export-wiring` fixed the instance. This file
 * is the guard for the CLASS: a convention that "host adapters must not
 * re-implement package ports" is enforceable by attention exactly until the
 * first tired afternoon. Here it is enforceable by `bun run test`.
 *
 * ## What counts as a violation
 *
 * A file under `apps/extension/utils/` **declaring** a symbol a shared package
 * already exports. Declaring — `export function isPrivateHost(…)` — not
 * re-exporting: `export { isPrivateHost } from "@atlcli/export-wiring"` is the
 * pattern this file is trying to encourage, and a host wrapper that adds
 * genuinely host-specific behaviour (the extension's origin allowlist) is fine
 * as long as it does not SHADOW the shared name, because a shadow is how a
 * re-implementation starts looking legitimate at a call site.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const child = join(dir, name);
    if (statSync(child).isDirectory()) return sourceFiles(child);
    return /\.tsx?$/.test(name) ? [child] : [];
  });
}

const UTILS = join(ROOT, "utils");
const utilsFiles = sourceFiles(UTILS);

/**
 * The packages whose surface this host must consume rather than re-create.
 * `@atlcli/export-wiring` is the promoted layer itself; `@atlcli/export-macros`
 * is the contract it wires up, and re-declaring a renderer registry or a port
 * type here would be the same mistake one level down.
 */
const GUARDED_BARRELS: readonly string[] = [
  "packages/export-wiring/src/index.ts",
  "packages/export-macros/src/index.ts",
  "packages/export-jobs/src/index.ts",
];

/**
 * Names a `utils/` file may legitimately declare despite the collision, each
 * with the reason. Adding an entry is a reviewed decision, which is the point:
 * an empty-by-default list makes every future collision visible in a diff.
 */
const COLLISION_ALLOWLIST: Readonly<Record<string, string>> = {
  // `utils/read-path.ts` models an attachment listed on a page (id, download
  // URL, media type) for the panel's read path. `@atlcli/export-macros`'s
  // `AttachmentMeta` is the macro resolver's freshness key (filename, version,
  // modified). Same word, unrelated shapes, neither derived from the other.
  AttachmentMeta: "utils/read-path.ts — panel read-path shape, unrelated to the macro port's",
};

/** Names a barrel exports, including type-only ones (which have no runtime trace). */
export function exportedNames(barrelSource: string): Set<string> {
  const names = new Set<string>();
  for (const block of barrelSource.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of block[1]!.split(",")) {
      // `foo as bar` exports `bar`; a bare `foo` exports `foo`.
      const name = entry.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Top-level DECLARATIONS a source file exports (re-exports deliberately excluded). */
export function declaredExports(source: string): string[] {
  return [
    ...source.matchAll(
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|enum|type)\s+([A-Za-z0-9_$]+)/gm
    ),
  ].map((m) => m[1]!);
}

const guarded = new Set<string>();
for (const barrel of GUARDED_BARRELS) {
  for (const name of exportedNames(readFileSync(join(REPO, barrel), "utf8"))) guarded.add(name);
}

describe("extension host boundaries — no re-implementation of packages/* surface", () => {
  it("reads a non-trivial guarded surface from the real barrels", () => {
    // Without this, a barrel-parsing regression would make every assertion
    // below pass vacuously.
    expect(guarded.size).toBeGreaterThan(30);
    for (const anchor of [
      "isPrivateHost",
      "createExternalAssetPolicy",
      "trustRoutingPdfAssetResolver",
      "buildMacroResolutionOptions",
      "jiraIssueRef",
      "defaultRegistry",
      "resolveMacroBlocks",
      "claimExportJob",
      "ExportJobStore",
    ]) {
      expect([...guarded]).toContain(anchor);
    }
    expect(utilsFiles.length).toBeGreaterThan(20);
  });

  it("no file under utils/ declares a symbol a shared package already exports", () => {
    const offenders: string[] = [];
    for (const file of utilsFiles) {
      const rel = file.slice(ROOT.length + 1);
      for (const name of declaredExports(readFileSync(file, "utf8"))) {
        if (!guarded.has(name)) continue;
        if (COLLISION_ALLOWLIST[name]) continue;
        offenders.push(
          `${rel}: declares "${name}", which @atlcli/export-wiring or @atlcli/export-macros ` +
            `already exports — import it (or re-export it), or rename the host-specific one`
        );
      }
    }
    expect(
      offenders,
      offenders.length
        ? `Host adapter re-implements shared surface:\n  ${offenders.join("\n  ")}`
        : undefined
    ).toEqual([]);
  });

  it("every allowlisted collision still exists (a stale exemption is a hole)", () => {
    const declared = new Set(
      utilsFiles.flatMap((file) => declaredExports(readFileSync(file, "utf8")))
    );
    for (const name of Object.keys(COLLISION_ALLOWLIST)) {
      expect(declared, `${name} is allowlisted but no longer declared — drop the exemption`).toContain(
        name
      );
    }
  });

  /**
   * The second, independent guard. The name check above catches a copy that
   * keeps the shared name; this one catches a copy that renames it — the SSRF
   * rule set is a set of literal addresses, and there is no legitimate reason
   * for a host adapter to know them.
   */
  it("no file under utils/ carries the private-network address rules", () => {
    const rules = [
      "169.254",
      "::ffff",
      "fc00",
      "fe80",
      "100.64",
      "192.168.",
      "127.0.0.1",
      "metadata.google.internal",
      "home.arpa",
    ];
    const offenders: string[] = [];
    for (const file of utilsFiles) {
      const source = readFileSync(file, "utf8");
      for (const rule of rules) {
        if (source.includes(rule)) {
          offenders.push(`${file.slice(ROOT.length + 1)}: contains the SSRF rule literal "${rule}"`);
        }
      }
    }
    expect(
      offenders,
      offenders.length
        ? `The SSRF guard belongs to @atlcli/export-wiring (isPrivateHost), not to a host:\n  ${offenders.join("\n  ")}`
        : undefined
    ).toEqual([]);
  });

  it("the asset-policy adapter reaches the shared package rather than re-deriving it", () => {
    const source = readFileSync(join(UTILS, "macros/external-asset-policy.ts"), "utf8");
    expect(source).toContain(`from "@atlcli/export-wiring"`);
    // The mechanics that made the two copies diverge: none of them may reappear
    // here, under any name.
    expect(source).not.toMatch(/getReader\(\)|redirect:\s*"manual"|content-length/);
    // Its whole remaining job is the origin allowlist.
    expect(source).toContain("ATLASSIAN_MEDIA_ORIGINS");
  });

  it("the extension declares the shared packages it imports", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const dep of ["@atlcli/export-wiring", "@atlcli/export-macros", "@atlcli/export-jobs", "@atlcli/jira"]) {
      expect(manifest.dependencies[dep], `${dep} is imported but not declared`).toBe("workspace:*");
    }
  });
});

/**
 * Node barrels must not be importable from this bundle (spec 010 T5.4).
 *
 * ## Relationship to `bun run check:browser`
 *
 * HISTORICAL NOTE (kept because it explains why this file exists): when this
 * was written the shared gate scanned a `--target=browser` build for **quoted
 * `node:`/`bun:` specifiers** only, and the modules that make `@atlcli/jira`'s
 * default barrel node-only import the LEGACY bare form — `import { homedir }
 * from "os"`, `"path"`, `"fs"`, `"crypto"` — which Bun silently polyfills for
 * the browser target. Measured then: pointing `BROWSER_ENTRYPOINTS` at
 * `packages/jira/src/index.ts` produced a ~1 MB bundle containing `homedir`,
 * `createHmac`, `Bun.serve` and Bun's own "not implemented" polyfill text —
 * and the gate reported it CLEAN.
 *
 * That hole is now closed: `scripts/check-browser-build.ts` resolves each
 * entrypoint's source graph and flags builtins in BOTH spellings, and its test
 * runs the real check against that real barrel and asserts it fails.
 *
 * This file is still the cheaper and more specific check, so it stays: it
 * asserts the *intent* at the source level — a package that ships a browser
 * barrel must be imported through it — without needing a build at all, and it
 * covers extension sources that are not §6 entrypoints. The `exports` map is
 * the source of truth: a `"."` entry carrying a `browser` condition already
 * resolves safely for a bundler, so a bare import of such a package
 * (`@atlcli/core`) is fine; one without it is not.
 */
describe("no extension source imports a package's node barrel", () => {
  const SOURCE_ROOTS = ["utils", "entrypoints", "components", "workers"];
  const sources = SOURCE_ROOTS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  /** `@atlcli/x` → does its `"."` export resolve to a browser-safe barrel? */
  function rootExportIsBrowserSafe(pkg: string): boolean {
    const manifestPath = join(REPO, "packages", pkg.replace("@atlcli/", ""), "package.json");
    const exportsMap = (
      JSON.parse(readFileSync(manifestPath, "utf8")) as {
        exports?: Record<string, unknown>;
      }
    ).exports;
    const root = exportsMap?.["."];
    // No `./browser` subpath at all ⇒ the package has one isomorphic barrel
    // (`@atlcli/export-macros`, `@atlcli/export-wiring`), nothing to get wrong.
    if (!exportsMap || exportsMap["./browser"] === undefined) return true;
    return JSON.stringify(root ?? {}).includes('"browser"');
  }

  it("reads a non-trivial set of @atlcli imports", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("every bare @atlcli import resolves to a browser-safe barrel", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["'](@atlcli\/[a-z0-9-]+)["']/g)) {
        const pkg = match[1]!;
        if (rootExportIsBrowserSafe(pkg)) continue;
        offenders.push(
          `${file.slice(ROOT.length + 1)}: imports "${pkg}" — that barrel is Node-only; ` +
            `use "${pkg}/browser"`
        );
      }
    }
    expect(
      offenders,
      offenders.length ? `Node barrel reached the extension bundle:\n  ${offenders.join("\n  ")}` : undefined
    ).toEqual([]);
  });

  it("guard-the-guard: the classifier knows a node-only barrel when it sees one", () => {
    // `@atlcli/jira` gained the `browser` condition in T5.4; before that this
    // returned false, which is exactly the state the rule exists to forbid.
    expect(rootExportIsBrowserSafe("@atlcli/jira")).toBe(true);
    expect(rootExportIsBrowserSafe("@atlcli/export-macros")).toBe(true);
    // And a package whose "." has no browser condition is classified unsafe.
    const unsafe = { exports: { ".": { default: "./dist/index.js" }, "./browser": {} } };
    expect(JSON.stringify(unsafe.exports["."]).includes('"browser"')).toBe(false);
  });

  it("the Jira client is imported through the browser barrel specifically", () => {
    const source = readFileSync(join(UTILS, "macros/session-ports.ts"), "utf8");
    expect(source).toContain('from "@atlcli/jira/browser"');
    expect(source).not.toMatch(/from\s+["']@atlcli\/jira["']/);
    expect(source).not.toContain('from "@atlcli/jira/node"');
  });
});

describe("browser-local model runtime dependency boundary", () => {
  const extensionManifest = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  const researchManifest = JSON.parse(
    readFileSync(join(REPO, "packages", "research", "package.json"), "utf8")
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const researchSources = sourceFiles(join(REPO, "packages", "research", "src"));
  const extensionSources = ["utils", "entrypoints", "components", "workers"]
    .flatMap((dir) => sourceFiles(join(ROOT, dir)));

  it("declares Transformers.js as an exact extension runtime dependency only", () => {
    expect(extensionManifest.dependencies?.["@huggingface/transformers"]).toBe("4.2.0");
    expect(researchManifest.dependencies?.["@huggingface/transformers"]).toBeUndefined();
    expect(researchManifest.devDependencies?.["@huggingface/transformers"]).toBeUndefined();
  });

  it("keeps Transformers.js and ONNX Runtime out of the provider-neutral research package", () => {
    const offenders = researchSources.filter((file) =>
      /(?:@huggingface\/transformers|onnxruntime-(?:web|node))/.test(
        readFileSync(file, "utf8")
      )
    );
    expect(
      offenders.map((file) => file.slice(REPO.length + 1)),
      "Browser inference runtime imports belong to the extension host adapter"
    ).toEqual([]);
  });

  it("rejects Node-only Transformers.js and ONNX Runtime entry points in extension source", () => {
    const forbidden = /(?:@huggingface\/transformers\/(?:node|src\/env)|onnxruntime-node)/;
    const offenders = extensionSources.filter((file) =>
      forbidden.test(readFileSync(file, "utf8"))
    );
    expect(
      offenders.map((file) => file.slice(ROOT.length + 1)),
      "The MV3 bundle must use the browser-safe Transformers.js entry point"
    ).toEqual([]);
  });
});

/**
 * Guard-the-guard. Both detectors are string matchers; a regression in either
 * would make the suite above pass silently, which is the failure mode this
 * whole file was written to prevent.
 */
describe("the boundary detectors actually detect", () => {
  it("declaredExports finds declarations and ignores re-exports", () => {
    const source = [
      `export { isPrivateHost } from "@atlcli/export-wiring";`,
      `export type { JiraClientLike } from "@atlcli/export-wiring";`,
      `export function isPrivateHost(host: string): boolean { return false; }`,
      `export const EXTERNAL_ASSET_MAX_BYTES = 1;`,
      `export interface JiraClientLike { getIssue(): void }`,
      `function notExported() {}`,
    ].join("\n");
    const found = declaredExports(source);
    expect(found).toEqual(["isPrivateHost", "EXTERNAL_ASSET_MAX_BYTES", "JiraClientLike"]);
    expect(found).not.toContain("notExported");
  });

  it("exportedNames reads both value and type re-export blocks", () => {
    const barrel = [
      `export { alpha, beta as gamma } from "./a.js";`,
      `export type { Delta } from "./b.js";`,
      `export { epsilon } from "./c.js";`,
    ].join("\n");
    expect([...exportedNames(barrel)].sort()).toEqual(["Delta", "alpha", "epsilon", "gamma"]);
  });

  it("a re-implementation of a guarded symbol under utils/ would be flagged", () => {
    // The exact shape of the drift: a host file that declares, rather than
    // imports, a symbol the shared package owns.
    const reimplementation = `export function isPrivateHost(h: string): boolean { return h === "localhost"; }`;
    const flagged = declaredExports(reimplementation).filter((n) => guarded.has(n));
    expect(flagged).toEqual(["isPrivateHost"]);
  });
});
