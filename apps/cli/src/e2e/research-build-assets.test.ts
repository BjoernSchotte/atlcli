import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QUICKJS_CLI_WASM_FILE,
  materializeQuickJsCliRuntimeAsset,
} from "../../build-assets.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the CLI build materializes the QuickJS WASM filename expected by the bundled loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlcli-quickjs-build-asset-"));
  roots.push(root);

  const target = await materializeQuickJsCliRuntimeAsset({ outputDirectory: root });
  const bytes = await readFile(target);

  expect(target).toBe(join(root, QUICKJS_CLI_WASM_FILE));
  expect(bytes.byteLength).toBeGreaterThan(500_000);
  expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
});
