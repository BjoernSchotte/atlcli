import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapBinary } from "./update-swap";

describe("swapBinary", () => {
  let dir: string;
  let target: string;
  let backup: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlcli-swap-test-"));
    target = join(dir, "atlcli");
    backup = join(dir, "atlcli.bak");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("restores the previous binary when installation fails", async () => {
    await writeFile(target, "old");
    await expect(
      swapBinary(target, backup, async () => {
        await writeFile(target, "partial");
        throw new Error("tar extraction failed with code 2");
      })
    ).rejects.toThrow("tar extraction failed");
    expect(await readFile(target, "utf-8")).toBe("old");
    expect(existsSync(backup)).toBe(false);
  });

  test("keeps the new binary and the backup on success", async () => {
    await writeFile(target, "old");
    await swapBinary(target, backup, () => writeFile(target, "new"));
    expect(await readFile(target, "utf-8")).toBe("new");
    expect(await readFile(backup, "utf-8")).toBe("old");
  });

  test("a failed first install leaves nothing behind to restore", async () => {
    await expect(
      swapBinary(target, backup, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(existsSync(target)).toBe(false);
  });
});
