import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = fileURLToPath(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")));
const gluePath = fileURLToPath(new URL(import.meta.resolve("@embedpdf/pdfium")));
const [wasm, glue, wasmStats] = await Promise.all([readFile(wasmPath), readFile(gluePath, "utf8"), stat(wasmPath)]);
const module = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(module).map((entry) => ({ module: entry.module, name: entry.name, kind: entry.kind }));
const remoteLiterals = [...glue.matchAll(/https?:\/\/[^'"\s)]+/g)].map((match) => match[0]);
const result = {
  packageVersion: "2.15.0",
  wasmBytes: wasmStats.size,
  wasmSha256: createHash("sha256").update(wasm).digest("hex"),
  imports,
  importModules: [...new Set(imports.map((entry) => entry.module))].sort(),
  glue: {
    evalCalls: (glue.match(/\beval\s*\(/g) ?? []).length,
    newFunctionCalls: (glue.match(/\bnew\s+Function\s*\(/g) ?? []).length,
    defaultCdnLiteralPresent: glue.includes("cdn.jsdelivr.net"),
    remoteLiteralCount: remoteLiterals.length,
  },
  probePolicy: {
    wasmSource: "verified local bytes only",
    defaultCdnConstantUsed: false,
    allowedImportModules: ["env", "wasi_snapshot_preview1"],
    activePdfActionsExecuted: false,
  },
};
if (JSON.stringify(result.importModules) !== JSON.stringify(result.probePolicy.allowedImportModules)) {
  throw new Error(`unexpected WASM import modules: ${result.importModules.join(", ")}`);
}
if (result.glue.evalCalls !== 0 || result.glue.newFunctionCalls !== 0) throw new Error("dynamic code generation found in PDFium glue");
await Bun.write(resolve(ROOT, "../../../.tmp/import-pdf-probe/inspection.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
