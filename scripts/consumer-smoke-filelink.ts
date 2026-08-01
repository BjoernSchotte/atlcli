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

export interface InstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FilelinkInstallCoordinator {
  bunVersion: string;
  allowedPackages: ReadonlySet<string>;
  install: () => InstallResult;
  recreate: () => void;
  warn?: (message: string) => void;
}

export const KNOWN_FILELINK_EEXIST_BUN_VERSION = "1.3.14";

export const FILELINK_SMOKE_ENV: Record<string, string> = {
  NODE_ENV: "production",
  // Bun 1.3.14 gives a direct `file:` dependency and a transitive
  // override-backed `workspace:*` edge distinct physical package identities.
  // The DOCX output and report timings below remain authoritative; a singleton
  // imported from the direct copy cannot observe the runtime used by DOCX.
  ATLCLI_ASSERT_SHARED_CODE_HIGHLIGHT_STATE: "0",
};

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const KNOWN_FILELINK_EEXIST = [
  /^error: File exists: failed to link package (@atlcli\/[a-z0-9][a-z0-9._-]*)$/,
  /^EEXIST: File(?: or folder)? exists: failed to link package:\s*(@atlcli\/[a-z0-9][a-z0-9._-]*)(?:@.+)?\s+\(link\)$/,
];
const KNOWN_FILELINK_INSTALL_SUMMARY = /^(?:Failed to install \d+ packages?|Saved lockfile)$/;
const SECOND_FATAL_MARKER =
  /\b(?:error|failed|panic|fatal|ENOENT|integrity|checksum|signal)\b/i;

function normalizedInstallLines(result: InstallResult): string[] {
  return `${result.stdout}\n${result.stderr}`
    .replaceAll("\r\n", "\n")
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function knownFilelinkEexistPackage(
  result: InstallResult,
  bunVersion: string,
  allowedPackages: ReadonlySet<string>,
): string | null {
  if (bunVersion !== KNOWN_FILELINK_EEXIST_BUN_VERSION || result.exitCode === 0) return null;

  const lines = normalizedInstallLines(result);
  const matches = lines.flatMap((line) => {
    for (const pattern of KNOWN_FILELINK_EEXIST) {
      const match = pattern.exec(line);
      if (match?.[1]) return [match[1]];
    }
    return [];
  });
  if (matches.length !== 1) return null;

  const packageName = matches[0]!;
  if (!allowedPackages.has(packageName)) return null;

  const remaining = lines.filter((line) =>
    !KNOWN_FILELINK_EEXIST.some((pattern) => pattern.test(line))
    && !KNOWN_FILELINK_INSTALL_SUMMARY.test(line));
  if (remaining.some((line) => SECOND_FATAL_MARKER.test(line))) return null;
  return packageName;
}

function installFailure(result: InstallResult): Error {
  return new Error(
    `bun install (filelink consumer) failed:\n${result.stdout}\n${result.stderr}`,
  );
}

export function installFilelinkWithKnownRetry(coordinator: FilelinkInstallCoordinator): void {
  const first = coordinator.install();
  if (first.exitCode === 0) return;

  const packageName = knownFilelinkEexistPackage(
    first,
    coordinator.bunVersion,
    coordinator.allowedPackages,
  );
  if (!packageName) throw installFailure(first);

  coordinator.warn?.(
    `Bun ${coordinator.bunVersion} hit the known file-link EEXIST for ${packageName}; ` +
      "recreating the throwaway consumer and retrying once",
  );
  coordinator.recreate();

  const second = coordinator.install();
  if (second.exitCode !== 0) throw installFailure(second);
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
  const recreate = (): void => {
    rmSync(projectDir, { recursive: true, force: true });
    scaffoldConsumer(projectDir, {
      dependencies,
      overrides,
      devDependencies: CONSUMER_DEV_DEPS,
    });
  };
  recreate();
  installFilelinkWithKnownRetry({
    bunVersion: Bun.version,
    allowedPackages: new Set(publishablePackages().map((pkg) => pkg.name)),
    install: () => run(["bun", "install"], projectDir),
    recreate,
    warn: (message) => console.warn(`::warning::${message}`),
  });
  // NOTE: no workspace-leak assertion here — `file:` DIRECTORY installs link
  // the real workspace manifests verbatim (still carrying `workspace:*`
  // ranges); the consumer's `overrides` pin every `@atlcli/*` resolution to
  // the linked dirs, which is exactly what this suite proves. The
  // `workspace:`-rewrite contract applies to packed tarballs and is asserted
  // by pack-check and the tarball/Node smokes.

  // Defensive NODE_ENV=production (Bun skips `development` by default anyway
  // unless --conditions=development is passed) — the fixtures assert /dist/.
  runEntrypointsSmoke(projectDir, ["bun"], FILELINK_SMOKE_ENV);
  const smokes = runSmokes(projectDir, ["bun"], FILELINK_SMOKE_ENV);
  return { projectDir, smokes };
}

if (import.meta.main) {
  const { projectDir, smokes } = await runFilelinkSmoke();
  console.log(`filesystem-link consumer smoke OK in ${projectDir} (repo: ${repoRoot})`);
  console.log(smokes.docx);
  console.log(smokes.pdf);
}
