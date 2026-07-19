import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePdfOutputSink } from "./export-pdf.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atlcli-sink-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BYTES = new TextEncoder().encode("%PDF-1.7 fake\n%%EOF");
const OTHER = new TextEncoder().encode("%PDF-1.7 other\n%%EOF");

function tmpCount(files: string[]): number {
  return files.filter((f) => f.endsWith(".tmp")).length;
}

describe("filePdfOutputSink commit protocol (spec 008 T3.2)", () => {
  it("writes a new file and leaves no temp behind", async () => {
    const path = join(dir, "out.pdf");
    await filePdfOutputSink(path).emit("out.pdf", BYTES);
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
    expect(tmpCount(await readdir(dir))).toBe(0);
  });

  it("refuses to clobber an existing file without --force", async () => {
    const path = join(dir, "out.pdf");
    await writeFile(path, OTHER);
    await expect(filePdfOutputSink(path).emit("out.pdf", BYTES)).rejects.toThrow(/already exists/);
    expect(new Uint8Array(await readFile(path))).toEqual(OTHER);
  });

  it("overwrites an existing regular file with --force", async () => {
    const path = join(dir, "out.pdf");
    await writeFile(path, OTHER);
    await filePdfOutputSink(path, { force: true }).emit("out.pdf", BYTES);
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
  });

  it("refuses to write through a symlink at the target, even with --force", async () => {
    const real = join(dir, "real.pdf");
    const path = join(dir, "link.pdf");
    await writeFile(real, OTHER);
    await symlink(real, path);
    await expect(filePdfOutputSink(path, { force: true }).emit("x", BYTES)).rejects.toThrow(/symlink/);
    expect(new Uint8Array(await readFile(real))).toEqual(OTHER);
  });

  it("refuses a directory at the target path", async () => {
    const path = join(dir, "adir");
    await mkdir(path);
    await expect(filePdfOutputSink(path, { force: true }).emit("x", BYTES)).rejects.toThrow(/directory/);
  });

  it("holds no-clobber under a concurrent race (exactly one writer wins)", async () => {
    const path = join(dir, "race.pdf");
    const results = await Promise.allSettled([
      filePdfOutputSink(path).emit("x", BYTES),
      filePdfOutputSink(path).emit("x", OTHER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const written = new Uint8Array(await readFile(path));
    expect([BYTES, OTHER].some((b) => b.length === written.length && b.every((v, i) => v === written[i]))).toBe(true);
    expect(tmpCount(await readdir(dir))).toBe(0);
  });

  it("handles a Unicode filename", async () => {
    const path = join(dir, "рёпорт-örnek-图.pdf");
    await filePdfOutputSink(path).emit("x", BYTES);
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
  });

  it("removes the temp file when the write is aborted mid-flight", async () => {
    const path = join(dir, "aborted.pdf");
    const controller = new AbortController();
    controller.abort();
    await expect(filePdfOutputSink(path).emit("x", BYTES, { signal: controller.signal })).rejects.toThrow();
    await expect(readFile(path)).rejects.toThrow();
    expect(tmpCount(await readdir(dir))).toBe(0);
  });

  it("ignores a stray temp file left by a killed process", async () => {
    const path = join(dir, "out.pdf");
    await writeFile(join(dir, ".out.pdf.deadbeef.tmp"), OTHER);
    await filePdfOutputSink(path).emit("x", BYTES);
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
  });
});
