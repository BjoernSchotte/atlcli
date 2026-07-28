#!/usr/bin/env bun
/**
 * Filesystem-link consumer smoke (spec 009, Consumer smoke).
 *
 * A throwaway consumer that depends on the package DIRECTORIES via the
 * `file:` protocol — the most likely Track 2 consumption path (a Forge app
 * linking against this repo or a sibling checkout). Bun only applies the
 * workspace-only `development` condition when explicitly requested
 * (--conditions=development — see fb021b6), so a plain consumer run already
 * resolves the built `dist/` output; NODE_ENV=production is set as a
 * defensive belt, and the smoke fixtures assert the /dist/ resolution,
 * proving the linked packages work from their build artifacts, not their
 * sources.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSUMER_DEV_DEPS,
  atlcliClosure,
  buildPackages,
  publishablePackages,
  repoRoot,
  run,
  runEntrypointsSmoke,
  runSmokes,
  scaffoldConsumer,
  type SmokeRunResult,
} from "./consumer-smoke.js";

/** The packages the DOCX/PDF smokes need: docx + pdf(+compiler) roots; the
 *  transitive @atlcli closure is derived from the real manifests. */
const FILELINK_ROOTS = [
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
  for (const name of atlcliClosure(FILELINK_ROOTS)) {
    dependencies[name] = `file:${byName.get(name)!}`;
  }
  // A file-linked package retains its workspace manifest. Bun may inspect
  // package devDependencies while linking, so explicitly resolve the browser
  // compiler's test-only intake edge without installing the same directory a
  // second time as a direct consumer dependency.
  const intakeName = "@atlcli/docx-template-intake";
  const overrides = {
    ...dependencies,
    [intakeName]: `file:${byName.get(intakeName)!}`,
  };

  const projectDir = join(workDir, "consumer");
  scaffoldConsumer(projectDir, {
    dependencies,
    overrides,
    devDependencies: CONSUMER_DEV_DEPS,
  });

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

  // Defensive NODE_ENV=production (Bun skips `development` by default anyway
  // unless --conditions=development is passed) — the fixtures assert /dist/.
  runEntrypointsSmoke(projectDir, ["bun"], { NODE_ENV: "production" });
  const smokes = runSmokes(projectDir, ["bun"], { NODE_ENV: "production" });
  return { projectDir, smokes };
}

if (import.meta.main) {
  const { projectDir, smokes } = await runFilelinkSmoke();
  console.log(`filesystem-link consumer smoke OK in ${projectDir} (repo: ${repoRoot})`);
  console.log(smokes.docx);
  console.log(smokes.pdf);
}
