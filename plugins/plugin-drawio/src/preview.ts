import { spawn } from "bun";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

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
      // Follow directory symlinks so symlinked .drawio trees are not skipped.
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const isDir = entry.isDirectory() || (await stat(path)).isDirectory();
        if (isDir) await visit(path);
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
  const executable = options.executable || process.env.ATLCLI_DRAWIO_EXECUTABLE || "drawio";

  try {
    if (!options.force && existsSync(output)) {
      const [sourceStats, outputStats] = await Promise.all([stat(source), stat(output)]);
      if (outputStats.mtimeMs >= sourceStats.mtimeMs) {
        return { source, output, status: "skipped" };
      }
    }

    const spawnFn = options.spawn ?? spawn;
    const subprocess = spawnFn(buildDrawioCommand(source, output, executable), {
      cwd: dirname(source),
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = options.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => subprocess.kill(), timeoutMs);
    try {
      const [stderr, exitCode] = await Promise.all([new Response(subprocess.stderr).text(), subprocess.exited]);
      const outputExists = await stat(output).then(() => true).catch(() => false);
      if (exitCode !== 0 || !outputExists) {
        return {
          source,
          output,
          status: "failed",
          message: stderr.trim() || `Draw.io exited with code ${exitCode}`,
        };
      }
      return { source, output, status: "rendered" };
    } finally {
      clearTimeout(timeout);
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
