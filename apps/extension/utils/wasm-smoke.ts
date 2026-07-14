/**
 * Minimal inline WebAssembly smoke module (spec 002 Task 5).
 *
 * Hand-written bytes for a module exporting a single `add(i32, i32) -> i32`
 * function. No external dependency, no fetch, no remote asset — the whole
 * module is the byte array below, so it works under the extension CSP
 * (`script-src 'self' 'wasm-unsafe-eval'`). This proves the offscreen WASM
 * round-trip that spec 005 (Typst) will depend on.
 */

/**
 * A complete WASM binary: `(module (func (export "add") (param i32 i32)
 * (result i32) local.get 0 local.get 1 i32.add))`.
 */
export const WASM_ADD_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // magic "\0asm"
  0x01, 0x00, 0x00, 0x00, // version 1
  // type section: one (i32, i32) -> i32
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  // function section: one function using type 0
  0x03, 0x02, 0x01, 0x00,
  // export section: export "add" as function 0
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  // code section: local.get 0; local.get 1; i32.add; end
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

/**
 * Instantiate the inline WASM module and run `add(a, b)`.
 *
 * Throws (rejects) if instantiation fails or the `add` export is missing — the
 * caller (router) turns that into an error response so failures surface as a
 * message in the panel rather than a hang.
 *
 * @param bytes  override the module bytes (used to force the failure path in tests).
 */
export async function runWasmAdd(
  a: number,
  b: number,
  bytes: Uint8Array = WASM_ADD_BYTES
): Promise<number> {
  const module = await WebAssembly.compile(bytes as BufferSource);
  const instance = await WebAssembly.instantiate(module);
  const add = instance.exports.add as unknown;
  if (typeof add !== "function") {
    throw new Error("WASM smoke module has no callable 'add' export");
  }
  return (add as (x: number, y: number) => number)(a, b);
}
