import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  readBoundedPublicationJsonV1,
} from "@atlcli/web-publish/node";
import type {
  PublicationBuildRequestV1,
  PublicationBuildResultV1,
  PublicationBuilderV1,
} from "@atlcli/web-publish";
import { runAstroBuildCommandV1 } from "./build-command.js";
import {
  createAstroStaticPublicationManifestV1,
  type AstroBuildInventoryV1,
} from "./manifest.js";

export interface AstroStaticPublicationBuilderOptionsV1 {
  /** Version of this trusted atlcli Astro builder adapter. */
  version: string;
  /** Exact supported Astro release used by the operator-owned project. */
  astroVersion: string;
  /** Private integration sidecar written by `astro:build:done`. */
  inventoryPath: string;
  /** Operator-owned Astro static output directory, never rewritten by atlcli. */
  outputDirectory: string;
  /** Optional cancellation propagated to the project-owned build child. */
  signal?: AbortSignal;
  /** Negotiated trusted experience recorded in the final publication manifest. */
  experience: { id: string; version: string; digest: string };
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function privatePathOutsideOutput(inventoryPath: string, outputDirectory: string): void {
  const relativePath = relative(resolve(outputDirectory), resolve(inventoryPath));
  if (relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"))) {
    throw new TypeError("inventoryPath must be outside outputDirectory");
  }
}

function isInventory(value: unknown): value is AstroBuildInventoryV1 {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== "atlcli.astro-build-inventory/1" || typeof candidate.bundleDigest !== "string") return false;
  if (!Array.isArray(candidate.pages) || !Array.isArray(candidate.output)) return false;
  return candidate.pages.every((page) => page !== null && typeof page === "object" &&
    (page as Record<string, unknown>).kind === "page" &&
    typeof (page as Record<string, unknown>).sourceId === "string" &&
    typeof (page as Record<string, unknown>).route === "string" &&
    typeof (page as Record<string, unknown>).pathname === "string") &&
    candidate.output.every((output) => output !== null && typeof output === "object" &&
      typeof (output as Record<string, unknown>).path === "string" &&
      typeof (output as Record<string, unknown>).sha256 === "string" &&
      typeof (output as Record<string, unknown>).byteLength === "number") &&
    (candidate.projectPages === undefined || Array.isArray(candidate.projectPages) && candidate.projectPages.every((page) =>
      page !== null && typeof page === "object" &&
      (page as Record<string, unknown>).kind === "project" &&
      typeof (page as Record<string, unknown>).pathname === "string"));
}

async function stageExistingPath(path: string, kind: "directory" | "file", token: string): Promise<string | undefined> {
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || (kind === "directory" ? !state.isDirectory() : !state.isFile())) {
      throw new TypeError(`${kind === "directory" ? "outputDirectory" : "inventoryPath"} must be a real ${kind}`);
    }
    const backup = `${path}.atlcli-previous-${token}`;
    await rename(path, backup);
    return backup;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readFreshInventory(path: string): Promise<AstroBuildInventoryV1> {
  const value = await readBoundedPublicationJsonV1(path);
  if (!isInventory(value)) throw new TypeError("Astro build did not write a valid private inventory");
  return value;
}

/**
 * Create the Node-only implementation of the builder port. It invokes the
 * project's literal build argv; Astro itself remains a project dependency and
 * is never called through an experimental programmatic API.
 */
export function createAstroStaticPublicationBuilderV1(
  options: AstroStaticPublicationBuilderOptionsV1,
): PublicationBuilderV1 {
  assertNonEmpty(options.version, "version");
  assertNonEmpty(options.astroVersion, "astroVersion");
  assertNonEmpty(options.inventoryPath, "inventoryPath");
  assertNonEmpty(options.outputDirectory, "outputDirectory");
  assertNonEmpty(options.experience.id, "experience.id");
  assertNonEmpty(options.experience.version, "experience.version");
  assertNonEmpty(options.experience.digest, "experience.digest");
  const inventoryPath = resolve(options.inventoryPath);
  const outputDirectory = resolve(options.outputDirectory);
  privatePathOutsideOutput(inventoryPath, outputDirectory);

  return {
    id: "astro-static",
    version: options.version,
    async build(request: PublicationBuildRequestV1): Promise<PublicationBuildResultV1> {
      if (request.project.builder.builder !== "astro-static") {
        throw new TypeError("Astro static builder received a non-Astro project");
      }
      if (!request.bundle.complete) {
        throw new TypeError("Astro static builder requires a complete activated publication bundle");
      }
      await mkdir(dirname(inventoryPath), { recursive: true });
      const token = `${process.pid}-${Date.now()}`;
      let previousOutput: string | undefined;
      let previousInventory: string | undefined;
      try {
        previousOutput = await stageExistingPath(outputDirectory, "directory", token);
        previousInventory = await stageExistingPath(inventoryPath, "file", token);
      } catch (error) {
        if (previousOutput !== undefined) await rename(previousOutput, outputDirectory).catch(() => undefined);
        throw error;
      }
      let committed = false;
      try {
        await runAstroBuildCommandV1({
          projectDirectory: request.project.builder.projectDir,
          command: request.project.builder.buildCommand,
          signal: options.signal,
        });
        const inventory = await readFreshInventory(inventoryPath);
        const manifest = await createAstroStaticPublicationManifestV1({
          request,
          inventory,
          builderVersion: options.version,
          astroVersion: options.astroVersion,
          experience: options.experience,
        });
        committed = true;
        if (previousOutput !== undefined) await rm(previousOutput, { recursive: true, force: true });
        if (previousInventory !== undefined) await rm(previousInventory, { force: true });
        return { manifest, outputDirectory };
      } catch (error) {
        await rm(outputDirectory, { recursive: true, force: true });
        if (previousOutput !== undefined) await rename(previousOutput, outputDirectory);
        await rm(inventoryPath, { force: true });
        if (previousInventory !== undefined) await rename(previousInventory, inventoryPath);
        throw error;
      } finally {
        if (!committed) {
          if (previousOutput !== undefined) await rm(previousOutput, { recursive: true, force: true }).catch(() => undefined);
          if (previousInventory !== undefined) await rm(previousInventory, { force: true }).catch(() => undefined);
        }
      }
    },
  };
}
