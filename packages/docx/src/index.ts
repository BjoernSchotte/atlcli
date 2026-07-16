/**
 * Node entry point for `@atlcli/docx` (spec 006).
 *
 * The full isomorphic engine (identical to the browser entry) plus the
 * Node-side env adapters (filesystem template source / output sink). PizZip
 * and docxtemplater use the real `Buffer` here; the browser `Uint8Array`
 * shim is a host concern of the extension bundle (spec 006 §2.4) and never
 * appears in this package.
 */
export * from "./index.browser.js";
export * from "./node-adapters.js";
