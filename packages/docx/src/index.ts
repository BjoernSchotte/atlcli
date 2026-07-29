/**
 * Node entry point for `@atlcli/docx` (spec 006).
 *
 * The full isomorphic engine (identical to the browser entry) plus the
 * Node-side env adapters (filesystem template source / output sink). PizZip
 * and docxtemplater use the real `Buffer` here. Browser bootstrap and DOM
 * adapters are available only through the explicit `./browser-runtime`
 * subpath and are deliberately not re-exported here.
 */
import "./node-code-font.js";

export * from "./index.browser.js";
export * from "./node-adapters.js";
