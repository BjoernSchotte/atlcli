export {};

(globalThis as typeof globalThis & {
  __ATLCLI_DOCX_BROWSER_INTENT_STARTED_AT?: number;
}).__ATLCLI_DOCX_BROWSER_INTENT_STARTED_AT = performance.now();

await import("./app.js");
