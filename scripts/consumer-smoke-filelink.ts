#!/usr/bin/env bun
/**
 * Filesystem-link consumer smoke (spec 009, Consumer smoke).
 *
 * A throwaway consumer that depends on the package DIRECTORIES via the
 * `file:` protocol — the most likely Track 2 consumption path (a Forge app
 * linking against this repo or a sibling checkout). The smoke runs with
 * NODE_ENV=production so Bun does NOT apply the workspace-only `development`
 * condition: resolution must land in the built `dist/` output (asserted
 * inside the smoke fixtures), proving the linked packages work from their
 * build artifacts, not their sources.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSUMER_DEV_DEPS,
  buildPackages,
  publishablePackages,
  repoRoot,
  run,
  runSmokes,
  scaffoldConsumer,
  type SmokeRunResult,
} from "./consumer-smoke.js";

/** The packages the DOCX/PDF smokes need: docx + pdf + their @atlcli closure. */
const FILELINK_PACKAGES = [
  "@atlcli/core",
  "@atlcli/diagram",
  "@atlcli/confluence",
  "@atlcli/docx",
  "@atlcli/pdf",
  "@atlcli/pdf-compiler-browser",
];

export interface FilelinkSmokeResult {
  projectDir: string;
  smokes: SmokeRunResult;
}

export async function runFilelinkSmoke(baseDir?: string): Promise<FilelinkSmokeResult> {
  const workDir = baseDir ?? join(tmpdir(), `atlcli-filelink-smoke-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });

  buildPackages();

  const byName = new Map(publishablePackages().map((p) => [p.name, p.dir]));
  const dependencies: Record<string, string> = {};
  for (const name of FILELINK_PACKAGES) {
    const dir = byName.get(name);
    if (!dir) throw new Error(`${name} is not in the publishable set`);
    dependencies[name] = `file:${dir}`;
  }

  const projectDir = join(workDir, "consumer");
  scaffoldConsumer(projectDir, { dependencies, devDependencies: CONSUMER_DEV_DEPS });

  const install = run(["bun", "install"], projectDir);
  if (install.exitCode !== 0) {
    throw new Error(`bun install (filelink consumer) failed:\n${install.stdout}\n${install.stderr}`);
  }
  // NOTE: no workspace-leak assertion here — `file:` DIRECTORY installs link
  // the real workspace manifests verbatim (still carrying `workspace:*`
  // ranges); the consumer's `overrides` pin every `@atlcli/*` resolution to
  // the linked dirs, which is exactly what this suite proves. The
  // `workspace:`-rewrite contract applies to packed tarballs and is asserted
  // by pack-check and the tarball/Node smokes.

  // NODE_ENV=production: Bun must resolve the default (dist) targets, not the
  // workspace-only development condition — the fixtures assert /dist/.
  const smokes = runSmokes(projectDir, ["bun"], { NODE_ENV: "production" });
  return { projectDir, smokes };
}

if (import.meta.main) {
  const { projectDir, smokes } = await runFilelinkSmoke();
  console.log(`filesystem-link consumer smoke OK in ${projectDir} (repo: ${repoRoot})`);
  console.log(smokes.docx);
  console.log(smokes.pdf);
}
