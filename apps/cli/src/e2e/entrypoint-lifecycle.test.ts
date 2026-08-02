import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("the CLI entrypoint keeps the process alive until its asynchronous command completes", async () => {
  const entrypoint = await readFile(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "utf8",
  );

  expect(entrypoint).toContain("await main().catch(");
  expect(entrypoint).not.toMatch(/^\s*main\(\)\.catch\(/m);
});
