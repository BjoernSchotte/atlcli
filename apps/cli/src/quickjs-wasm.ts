/**
 * The QuickJS WASM behind Jinja templates and scripts, embedded into every CLI
 * build. The QuickJS loader looks for `emscripten-module.wasm` beside the
 * bundle; a `bun build --compile` binary has no such file, so `wiki page
 * create` and every other render aborted with ENOENT.
 *
 * The `with { type: "file" }` import is the load-bearing part, as in
 * `commands/export-pdf-assets.ts`: under `bun run` it resolves to the file in
 * `node_modules`, under `--compile` Bun embeds the file and yields its `$bunfs`
 * path, and in a `--target bun` dist bundle it yields a path relative to the
 * bundle. Importing this module hands those bytes to both QuickJS users.
 */
import quickJsWasm from "@jitl/quickjs-ng-wasmfile-release-asyncify/wasm" with { type: "file" };
import { setJinjaWasmBinary } from "@atlcli/jinja";
import { setDefaultQuickJsWasmBinary } from "@atlcli/script-runtime";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const wasmPath = isAbsolute(quickJsWasm) ? quickJsWasm : resolve(import.meta.dir, quickJsWasm);

async function loadQuickJsWasm(): Promise<ArrayBuffer> {
  const bytes = await readFile(wasmPath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

setJinjaWasmBinary(loadQuickJsWasm);
setDefaultQuickJsWasmBinary(loadQuickJsWasm);
