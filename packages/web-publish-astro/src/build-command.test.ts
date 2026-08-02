import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AstroBuildCommandErrorV1, runAstroBuildCommandV1 } from "./build-command.js";

test("runs an explicit argv with a bounded clean environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-astro-build-command-"));
  try {
    const result = await runAstroBuildCommandV1({
      projectDirectory: directory,
      command: [process.execPath, "-e", "process.stdout.write(process.env.ATLCLI_FIXTURE ?? 'missing')"],
      environment: { ATLCLI_FIXTURE: "explicit" },
    });
    expect(result).toEqual({ stdout: "explicit", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects failing, aborted, and oversized commands with bounded diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-astro-build-command-"));
  try {
    await expect(runAstroBuildCommandV1({ projectDirectory: directory, command: [process.execPath, "-e", "process.exit(7)"] }))
      .rejects.toMatchObject({ kind: "exit" } satisfies Partial<AstroBuildCommandErrorV1>);
    await expect(runAstroBuildCommandV1({ projectDirectory: directory, command: [process.execPath, "-e", "process.stdout.write('x'.repeat(100))"], maxOutputBytes: 10 }))
      .rejects.toMatchObject({ kind: "output-limit" } satisfies Partial<AstroBuildCommandErrorV1>);
    const controller = new AbortController();
    controller.abort();
    await expect(runAstroBuildCommandV1({ projectDirectory: directory, command: [process.execPath, "-e", "process.exit(0)"], signal: controller.signal }))
      .rejects.toMatchObject({ kind: "aborted" } satisfies Partial<AstroBuildCommandErrorV1>);
    await expect(runAstroBuildCommandV1({ projectDirectory: directory, command: ["definitely-not-an-atlcli-executable"] }))
      .rejects.toMatchObject({ kind: "spawn" } satisfies Partial<AstroBuildCommandErrorV1>);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
