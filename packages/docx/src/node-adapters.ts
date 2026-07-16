/**
 * Node-side implementations of the export-env interfaces (spec 006 Task 5).
 *
 * Deliberately in their own module, exported only from the Node barrel
 * (`index.ts`) — the browser entry must never pull `node:fs` into its graph
 * (the `check:browser` gate would fail). A Node host (CLI, MCP server,
 * Org-Server) composes these with a token-auth {@link AssetFetcher} to get a
 * full {@link ExportEnv}.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { AssetFetcher, OutputSink, TemplateSource } from "./env.js";

/**
 * A {@link TemplateSource} that reads the template from one fixed file path.
 * The `id` passed by {@link runExport} is ignored — a CLI invocation names
 * exactly one template.
 */
export function fileTemplateSource(path: string): TemplateSource {
  return {
    async getBytes(): Promise<Uint8Array> {
      return new Uint8Array(await readFile(path));
    },
  };
}

/**
 * An {@link OutputSink} that writes to one fixed file path, ignoring the
 * report's suggested filename (the CLI user chose the output path).
 */
export function fileOutputSink(path: string): OutputSink {
  return {
    async emit(_name: string, bytes: Uint8Array): Promise<void> {
      await writeFile(path, bytes);
    },
  };
}

/**
 * An {@link AssetFetcher} that fails on first use. Since spec 005 landed,
 * hosts without an asset path should simply OMIT `assets` from their
 * {@link ExportEnv} (images then degrade to `image-skipped` report notes);
 * inject this only where an asset fetch indicates a real wiring gap that
 * should surface loudly (as an `image-embed-failed` warning note).
 */
export function unsupportedAssetFetcher(reason = "asset fetching is not wired for this host"): AssetFetcher {
  return {
    fetch(): Promise<Uint8Array> {
      return Promise.reject(new Error(reason));
    },
  };
}
