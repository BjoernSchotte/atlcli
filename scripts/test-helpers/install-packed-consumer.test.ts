import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPackedConsumerOffline } from "./install-packed-consumer";

test("prepares the cache before proving a clean frozen offline consumer install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-offline-install-"));
  const commands: string[][] = [];
  try {
    await installPackedConsumerOffline(directory, async (command, cwd) => {
      expect(cwd).toBe(directory);
      commands.push(command);
      if (commands.length === 1) {
        await mkdir(join(directory, "node_modules"));
        await writeFile(join(directory, "bun.lock"), "prepared lockfile");
      } else {
        await expect(access(join(directory, "node_modules"))).rejects.toThrow();
        expect(await readFile(join(directory, "bun.lock"), "utf8")).toBe("prepared lockfile");
      }
    });
    expect(commands).toEqual([
      ["bun", "install", "--ignore-scripts"],
      ["bun", "install", "--offline", "--frozen-lockfile"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
