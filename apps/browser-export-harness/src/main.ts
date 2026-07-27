// This side-effect import must evaluate before any PizZip/docxtemplater module.
// The actual application graph is therefore loaded dynamically, not statically.
import "@atlcli/docx/browser-runtime";

(globalThis as typeof globalThis & {
  __ATLCLI_DOCX_BROWSER_RUNTIME_READY_AT?: number;
}).__ATLCLI_DOCX_BROWSER_RUNTIME_READY_AT = performance.now();

await import("./app.js");
