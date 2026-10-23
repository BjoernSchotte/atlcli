import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stderrVfsLogger } from "./stderr-logger.js";

test("warnings and errors reach stderr; debug and info stay quiet (#299)", () => {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => (written.push(chunk), true)) as typeof process.stderr.write;
  try {
    stderrVfsLogger.debug("d");
    stderrVfsLogger.info("i");
    stderrVfsLogger.warn("page.md: this page does not round-trip through Markdown.");
    stderrVfsLogger.error("boom");
  } finally {
    process.stderr.write = original;
  }
  expect(written).toEqual(["atlcli: warning: page.md: this page does not round-trip through Markdown.\n", "atlcli: error: boom\n"]);
});

test("wiki sh and wiki mount hand the VFS that logger", () => {
  for (const file of ["../commands/wiki-sh.ts", "../commands/wiki-mount.ts"]) {
    expect(readFileSync(new URL(file, import.meta.url), "utf8")).toContain("logger: stderrVfsLogger");
  }
});
