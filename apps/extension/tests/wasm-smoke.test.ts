import { describe, expect, it } from "bun:test";
import { runWasmAdd, WASM_ADD_BYTES } from "../utils/wasm-smoke.js";

describe("runWasmAdd (inline WASM smoke)", () => {
  it("instantiates the inline module and adds two integers", async () => {
    expect(await runWasmAdd(40, 2)).toBe(42);
    expect(await runWasmAdd(-5, 5)).toBe(0);
  });

  it("uses a valid, self-contained WASM binary", () => {
    // Magic "\0asm" + version 1.
    expect([...WASM_ADD_BYTES.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect([...WASM_ADD_BYTES.slice(4, 8)]).toEqual([0x01, 0x00, 0x00, 0x00]);
  });

  it("rejects (surfaces an error, never hangs) on invalid bytes", async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    await expect(runWasmAdd(1, 2, garbage)).rejects.toThrow();
  });
});
