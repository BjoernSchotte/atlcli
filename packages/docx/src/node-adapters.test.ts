/**
 * Atomic output-sink tests (spec 002) — real temp directories, no mocks.
 *
 * `fileOutputSink` writes to an exclusive-create temp file in the target's own
 * directory and renames it into place, so an aborted or failed write never
 * leaves a corrupt/partial file at the destination and never orphans a temp.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileOutputSink } from "./node-adapters.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "atlcli-sink-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmpLeftovers = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("fileOutputSink — atomic write", () => {
  it("writes bytes atomically and leaves no temp file behind on success", async () => {
    const dir = tempDir();
    const out = join(dir, "out.docx");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await fileOutputSink(out).emit("ignored.docx", bytes);
    expect(new Uint8Array(readFileSync(out))).toEqual(bytes);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("leaves a pre-existing target byte-unchanged when the write is aborted", async () => {
    const dir = tempDir();
    const out = join(dir, "out.docx");
    const original = new Uint8Array([9, 9, 9]);
    writeFileSync(out, original);

    const controller = new AbortController();
    controller.abort();
    await expect(
      fileOutputSink(out).emit("ignored.docx", new Uint8Array([1, 2, 3, 4]), {
        signal: controller.signal,
      })
    ).rejects.toThrow();

    // The pre-existing file is untouched, and no temp was orphaned.
    expect(new Uint8Array(readFileSync(out))).toEqual(original);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("leaves no orphaned temp file when the final rename fails", async () => {
    const dir = tempDir();
    // A directory at the target path makes the rename fail after the temp is
    // written — the finally-cleanup must still remove the temp.
    const out = join(dir, "target");
    mkdirSync(out);
    await expect(fileOutputSink(out).emit("ignored.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("concurrent exports to different paths do not collide", async () => {
    const dir = tempDir();
    const a = join(dir, "a.docx");
    const b = join(dir, "b.docx");
    const bytesA = new Uint8Array([1, 1, 1]);
    const bytesB = new Uint8Array([2, 2, 2, 2]);
    await Promise.all([
      fileOutputSink(a).emit("a", bytesA),
      fileOutputSink(b).emit("b", bytesB),
    ]);
    expect(new Uint8Array(readFileSync(a))).toEqual(bytesA);
    expect(new Uint8Array(readFileSync(b))).toEqual(bytesB);
    expect(tmpLeftovers(dir)).toEqual([]);
  });
});
