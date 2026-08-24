import { spawn } from "bun";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Minimal shape of the subprocess returned by the spawner. */
export interface DrawioSubprocess {
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

/** Spawner signature used by renderDrawioPreview. Defaults to Bun's `spawn`. */
export type DrawioSpawner = (
  cmd: string[],
  options: { cwd: string; stdout: "pipe"; stderr: "pipe" },
) => DrawioSubprocess;

export interface PreviewOptions {
  executable?: string;
  force?: boolean;
  /** Max milliseconds to wait for a Draw.io export before failing (default: 60s). */
  timeoutMs?: number;
  /** Injectable spawner for tests. Defaults to Bun's `spawn`. */
  spawn?: DrawioSpawner;
}

export interface PreviewResult {
  source: string;
  output: string;
  status: "rendered" | "skipped" | "failed";
  message?: string;
}

export function previewOutputPath(source: string): string {
  return `${source}.png`;
}

export function buildDrawioCommand(source: string, output: string, executable = "drawio"): string[] {
  return [executable, "--export", "--format", "png", "--output", output, source];
}

export async function findDrawioSources(directory: string): Promise<string[]> {
  const sources: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".atlcli" || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      // Never follow symlinks: a docs push must not traverse or write outside
      // the selected tree, and directory cycles must not hang discovery.
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".drawio") {
        sources.push(path);
      }
    }
  }

  await visit(resolve(directory));
  return sources.sort();
}

export async function renderDrawioPreview(source: string, options: PreviewOptions = {}): Promise<PreviewResult> {
  const output = previewOutputPath(source);
  const temporaryOutput = join(dirname(output), `.${randomUUID()}.atlcli-drawio.png`);
  const executable = options.executable || process.env.ATLCLI_DRAWIO_EXECUTABLE || "drawio";

  try {
    if (!options.force && existsSync(output)) {
      const [sourceStats, outputStats] = await Promise.all([stat(source), stat(output)]);
      if (outputStats.mtimeMs >= sourceStats.mtimeMs) {
        return { source, output, status: "skipped" };
      }
    }

    const spawnFn = options.spawn ?? spawn;
    const subprocess = spawnFn(buildDrawioCommand(source, temporaryOutput, executable), {
      cwd: dirname(source),
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = options.timeoutMs ?? 60_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = Symbol("timeout");
    const stderrPromise = new Response(subprocess.stderr).text();
    try {
      const exitCode = await Promise.race([
        subprocess.exited,
        new Promise<typeof timeoutResult>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(timeoutResult), timeoutMs);
        }),
      ]);
      if (exitCode === timeoutResult) {
        try {
          subprocess.kill();
        } catch {
          // The process may already have disappeared between timeout and kill.
        }
        // A GUI process can acknowledge termination late and write after the
        // immediate finally cleanup. Remove the UUID temp again on real exit.
        void subprocess.exited
          .then(() => rm(temporaryOutput, { force: true }))
          .catch(() => rm(temporaryOutput, { force: true }))
          .catch(() => {});
        void stderrPromise.catch(() => {});
        return {
          source,
          output,
          status: "failed",
          message: `Draw.io timed out after ${timeoutMs}ms`,
        };
      }

      const stderr = await stderrPromise;
      const outputExists = await stat(temporaryOutput).then(() => true).catch(() => false);
      if (exitCode !== 0 || !outputExists) {
        return {
          source,
          output,
          status: "failed",
          message: stderr.trim() || `Draw.io exited with code ${exitCode}`,
        };
      }
      await rename(temporaryOutput, output);
      return { source, output, status: "rendered" };
    } finally {
      if (timeout) clearTimeout(timeout);
      await rm(temporaryOutput, { force: true }).catch(() => {});
    }
  } catch (error) {
    return {
      source,
      output,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Max concurrent Draw.io exports. Draw.io Desktop is a GUI/CLI hybrid that
 * may not handle many parallel exports (single-instance lock, shared temp
 * dir), so we cap concurrency to avoid flaky failures. */
const MAX_CONCURRENT_EXPORTS = 4;

export async function renderDrawioPreviews(directory: string, options: PreviewOptions = {}): Promise<PreviewResult[]> {
  const sources = await findDrawioSources(directory);
  const results: PreviewResult[] = new Array(sources.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < sources.length) {
      const index = next++;
      results[index] = await renderDrawioPreview(sources[index], options);
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_EXPORTS, sources.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
