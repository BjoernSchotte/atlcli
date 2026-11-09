import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailEntries } from "./log";

const dir = await mkdtemp(join(tmpdir(), "atlcli-log-tail-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

async function logFile(day: string, messages: string[]): Promise<string> {
  const path = join(dir, `${day}.jsonl`);
  const lines = messages.map((message, i) => JSON.stringify({ timestamp: `${day}T10:00:0${i}.000Z`, level: "info", type: "cli.command", message }));
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

describe("log tail", () => {
  test("returns the last N entries in chronological order, across files", async () => {
    const older = await logFile("2026-11-01", ["a", "b", "c"]);
    const newer = await logFile("2026-11-02", ["d", "e", "f"]);
    const messages = async (limit: number) => (await tailEntries([newer, older], limit)).map((e) => (e as unknown as { message: string }).message);

    // Used to be the FIRST N of the newest file, reversed: ["e", "d"].
    expect(await messages(2)).toEqual(["e", "f"]);
    expect(await messages(4)).toEqual(["c", "d", "e", "f"]);
    expect(await messages(20)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});
