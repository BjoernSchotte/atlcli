import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ORT_ASYNCIFY_FACTORY_MV3_SHA256,
  ORT_ASYNCIFY_FACTORY_UPSTREAM_SHA256,
  ORT_JSEP_FACTORY_MV3_SHA256,
  ORT_JSEP_FACTORY_UPSTREAM_SHA256,
  patchOrtAsyncifyFactoryForMv3,
  patchOrtJsepFactoryForMv3,
  sha256Hex,
} from "../scripts/patch-ort-jsep-csp.js";

const upstreamFactoryPath = fileURLToPath(
  import.meta.resolve("onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs"),
);
const upstreamAsyncifyFactoryPath = fileURLToPath(
  import.meta.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs"),
);

describe("ONNX Runtime JSEP MV3 patch", () => {
  it("replaces the one pinned dynamic invoker without leaving string-to-code execution", () => {
    const upstream = readFileSync(upstreamFactoryPath, "utf8");
    expect(sha256Hex(upstream)).toBe(ORT_JSEP_FACTORY_UPSTREAM_SHA256);

    const patched = patchOrtJsepFactoryForMv3(upstream);
    expect(patched).not.toContain("new Function(");
    expect(sha256Hex(patched)).toBe(ORT_JSEP_FACTORY_MV3_SHA256);
  });

  it("fails closed when the upstream factory changes", () => {
    const upstream = readFileSync(upstreamFactoryPath, "utf8");
    expect(() => patchOrtJsepFactoryForMv3(`${upstream}\n`)).toThrow(
      "Unexpected ONNX Runtime JSEP factory digest",
    );
  });
});

describe("ONNX Runtime asyncify WebGPU MV3 patch", () => {
  it("replaces the pinned dynamic invoker without leaving string-to-code execution", () => {
    const upstream = readFileSync(upstreamAsyncifyFactoryPath, "utf8");
    expect(sha256Hex(upstream)).toBe(ORT_ASYNCIFY_FACTORY_UPSTREAM_SHA256);

    const patched = patchOrtAsyncifyFactoryForMv3(upstream);
    expect(patched).not.toContain("new Function(");
    expect(sha256Hex(patched)).toBe(ORT_ASYNCIFY_FACTORY_MV3_SHA256);
  });
});
