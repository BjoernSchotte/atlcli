import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDrawioCommand,
  findDrawioSources,
  previewOutputPath,
  renderDrawioPreview,
  renderDrawioPreviews,
  type DrawioSpawner,
  type PreviewOptions,
} from "./preview.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "atlcli-drawio-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A fake spawner. When `writeOutput` is true it creates the output file
 * (parsed from the `--output` arg) so the real `renderDrawioPreview` sees it
 * after exit.
 */
function fakeSpawn(writeOutput: boolean, exitCode = 0, stderrText = ""): DrawioSpawner {
  return (cmd) => {
    const outputIndex = cmd.indexOf("--output");
    const outputPath = outputIndex >= 0 ? cmd[outputIndex + 1] : undefined;
    return {
      stderr: new ReadableStream({
        start(c) {
          if (stderrText) c.enqueue(new TextEncoder().encode(stderrText));
          c.close();
        },
      }),
      exited: (async () => {
        if (writeOutput && outputPath) await writeFile(outputPath, "png");
        return exitCode;
      })(),
      kill: () => {},
    };
  };
}

function optionsWithSpawn(writeOutput: boolean, exitCode = 0, stderrText = "", force = true): PreviewOptions {
  return { force, spawn: fakeSpawn(writeOutput, exitCode, stderrText) };
}

describe("Draw.io previews", () => {
  test("uses the source filename plus .png for its preview", () => {
    expect(previewOutputPath("docs/architecture.drawio")).toBe("docs/architecture.drawio.png");
  });

  test("builds a Draw.io Desktop export command without shell interpolation", () => {
    expect(buildDrawioCommand("a diagram.drawio", "a diagram.drawio.png", "draw.io")).toEqual([
      "draw.io",
      "--export",
      "--format",
      "png",
      "--output",
      "a diagram.drawio.png",
      "a diagram.drawio",
    ]);
  });

  test("finds .drawio sources recursively, skipping .atlcli and node_modules", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "nested"), { recursive: true });
      await mkdir(join(dir, ".atlcli"), { recursive: true });
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "a.drawio"), "");
      await writeFile(join(dir, "nested", "b.drawio"), "");
      await writeFile(join(dir, ".atlcli", "hidden.drawio"), "");
      await writeFile(join(dir, "node_modules", "dep.drawio"), "");
      await writeFile(join(dir, "not-a-diagram.txt"), "");

      const sources = await findDrawioSources(dir);
      expect(sources).toEqual([join(dir, "a.drawio"), join(dir, "nested", "b.drawio")]);
    });
  });

  test("does not follow directory symlinks outside the selected tree", async () => {
    await withTempDir(async (dir) => {
      const scanRoot = join(dir, "scan");
      const outside = join(dir, "outside");
      await mkdir(scanRoot);
      await mkdir(outside);
      await writeFile(join(outside, "secret.drawio"), "secret");
      await symlink(outside, join(scanRoot, "linked"), "dir");

      expect(await findDrawioSources(scanRoot)).toEqual([]);
    });
  });

  test("skips a preview when the output is newer than the source", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "a.drawio");
      const output = previewOutputPath(source);
      await writeFile(source, "source");
      await writeFile(output, "png");

      const result = await renderDrawioPreview(source, { force: false });
      expect(result.status).toBe("skipped");
    });
  });

  test("renders a preview when the source is newer than the output", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "a.drawio");
      const output = previewOutputPath(source);
      await writeFile(output, "stale");
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(source, "newer");

      const result = await renderDrawioPreview(source, optionsWithSpawn(true, 0, "", false));
      expect(result.status).toBe("rendered");
    });
  });

  test("fails when Draw.io exits non-zero", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "a.drawio");
      await writeFile(source, "source");

      const result = await renderDrawioPreview(source, optionsWithSpawn(false, 1, "boom"));
      expect(result.status).toBe("failed");
      expect(result.message).toBe("boom");
    });
  });

  test("fails when Draw.io exits 0 but writes no output", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "a.drawio");
      await writeFile(source, "source");

      const result = await renderDrawioPreview(source, optionsWithSpawn(false, 0));
      expect(result.status).toBe("failed");
    });
  });

  test("does not accept or destroy a stale preview when Draw.io writes no new output", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "a.drawio");
      const output = previewOutputPath(source);
      await writeFile(source, "source");
      await writeFile(output, "previous-good-preview");

      const result = await renderDrawioPreview(source, optionsWithSpawn(false, 0));
      expect(result.status).toBe("failed");
      expect(await readFile(output, "utf8")).toBe("previous-good-preview");
    });
  });

  test("returns after its timeout even when the child never settles", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "a.drawio");
      await writeFile(source, "source");
      let killed = false;
      const spawnNever: DrawioSpawner = () => ({
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: new Promise<number>(() => {}),
        kill: () => { killed = true; },
      });

      const started = performance.now();
      const result = await renderDrawioPreview(source, { force: true, timeoutMs: 10, spawn: spawnNever });
      expect(performance.now() - started).toBeLessThan(500);
      expect(result.status).toBe("failed");
      expect(result.message).toContain("timed out");
      expect(killed).toBe(true);
    });
  });

  test("removes a temp preview written after a delayed process exit", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "a.drawio");
      await writeFile(source, "source");
      let resolveExit: (code: number) => void = () => {};
      let temporaryOutput = "";
      const delayedExit: DrawioSpawner = (cmd) => {
        temporaryOutput = cmd[cmd.indexOf("--output") + 1];
        return {
          stderr: new ReadableStream({ start(controller) { controller.close(); } }),
          exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
          kill: () => {
            setTimeout(async () => {
              await writeFile(temporaryOutput, "late-output");
              resolveExit(137);
            }, 10);
          },
        };
      };

      const result = await renderDrawioPreview(source, { force: true, timeoutMs: 1, spawn: delayedExit });
      expect(result.status).toBe("failed");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      expect(await readFile(temporaryOutput).then(() => true).catch(() => false)).toBe(false);
    });
  });

  test("renderDrawioPreviews renders all sources", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.drawio"), "a");
      await writeFile(join(dir, "b.drawio"), "b");

      const results = await renderDrawioPreviews(dir, optionsWithSpawn(true));
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "rendered")).toBe(true);
    });
  });
});
