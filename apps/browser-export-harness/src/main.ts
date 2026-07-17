// This side-effect import must evaluate before any PizZip/docxtemplater module.
// The actual application graph is therefore loaded dynamically, not statically.
import "@atlcli/docx/browser-runtime";

await import("./app.js");
