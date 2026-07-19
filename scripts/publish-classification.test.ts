import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is the parent of this scripts/ directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const RECOGNIZED_PUBLISH = new Set(["public-stable", "public-0.x", "private"]);

// Publish invocations that must never appear in a workflow.
const FORBIDDEN_PUBLISH_PATTERNS = ["npm publish", "npm stage publish", "bun publish"];

interface WorkspaceManifest {
  path: string;
  json: Record<string, unknown>;
}

/**
 * Derive the workspace package.json list from the root package.json "workspaces"
 * globs (never a hardcoded list). Each glob (e.g. "apps/*", "packages/*") is
 * expanded and any directory that contains a package.json counts as a workspace
 * package.
 */
function loadWorkspaceManifests(): WorkspaceManifest[] {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  const globs = rootPkg.workspaces ?? [];

  const manifests: WorkspaceManifest[] = [];
  const seen = new Set<string>();

  for (const pattern of globs) {
    // Match the package.json directly under each expanded workspace directory.
    const glob = new Glob(`${pattern}/package.json`);
    for (const rel of glob.scanSync({ cwd: repoRoot, onlyFiles: true, dot: false })) {
      const abs = join(repoRoot, rel);
      if (seen.has(abs)) continue;
      seen.add(abs);
      manifests.push({
        path: rel,
        json: JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>,
      });
    }
  }

  return manifests;
}

describe("publish classification (fail-closed)", () => {
  const manifests = loadWorkspaceManifests();

  it("discovers every workspace package from the root workspaces globs", () => {
    // Sanity check: the discovery mechanism actually found packages. If this is
    // empty the rest of the suite would vacuously pass.
    expect(manifests.length).toBeGreaterThan(0);
  });

  it("classifies every workspace package as private or with a recognized atlcli.publish value", () => {
    const offenders: string[] = [];

    for (const { path, json } of manifests) {
      const isPrivate = json.private === true;
      const atlcli = json.atlcli as { publish?: unknown } | undefined;
      const publish = atlcli?.publish;

      if (isPrivate) continue; // fail-closed via explicit private: true

      if (publish === undefined) {
        offenders.push(
          `${path}: has neither "private": true nor an "atlcli.publish" classification`,
        );
        continue;
      }

      if (typeof publish !== "string" || !RECOGNIZED_PUBLISH.has(publish)) {
        offenders.push(
          `${path}: unrecognized "atlcli.publish" value ${JSON.stringify(publish)} ` +
            `(expected one of ${[...RECOGNIZED_PUBLISH].map((v) => `"${v}"`).join(", ")})`,
        );
      }
    }

    expect(
      offenders,
      offenders.length
        ? `Fail-closed publish classification violated:\n  ${offenders.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});

describe("workflows never publish to a registry", () => {
  const workflowsDir = join(repoRoot, ".github", "workflows");

  function listWorkflowFiles(): string[] {
    return readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => join(workflowsDir, f));
  }

  it("contains no npm/bun publish invocation in any workflow", () => {
    const offenders: string[] = [];

    for (const file of listWorkflowFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        // Ignore YAML comment lines (first non-whitespace char is '#') so a
        // documentation note explaining that publishing was removed does not
        // trip the guard.
        if (line.trimStart().startsWith("#")) return;
        for (const pattern of FORBIDDEN_PUBLISH_PATTERNS) {
          if (line.includes(pattern)) {
            offenders.push(
              `${file.replace(`${repoRoot}/`, "")}:${idx + 1}: forbidden "${pattern}"`,
            );
          }
        }
      });
    }

    expect(
      offenders,
      offenders.length
        ? `Registry publishing is deferred — no workflow may run npm/bun publish:\n  ${offenders.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});
