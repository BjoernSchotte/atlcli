export type DocxEntryTopologyMode = "legacy" | "combined";

export interface DocxEntryTopologyResult {
  mode: DocxEntryTopologyMode;
  startedAt: number;
  runtimeReadyAt?: number;
  entryReadyAt: number;
  readyMs: number;
  hasRunExport: boolean;
  hasPreparation: boolean;
}

/**
 * Isolated production-build probe for #123.
 *
 * There are intentionally no static DOCX imports in this page. Navigation is
 * the discovery baseline; the test invokes this function to create explicit
 * DOCX intent and compares the old sequential pair with the combined entry.
 */
async function loadDocxEntry(
  mode: DocxEntryTopologyMode,
): Promise<DocxEntryTopologyResult> {
  const startedAt = performance.now();
  let runtimeReadyAt: number | undefined;
  let api:
    | typeof import("@atlcli/docx/browser")
    | typeof import("@atlcli/docx/browser-entry");

  if (mode === "legacy") {
    await import("@atlcli/docx/browser-runtime");
    runtimeReadyAt = performance.now();
    api = await import("@atlcli/docx/browser");
  } else {
    api = await import("@atlcli/docx/browser-entry");
  }

  const entryReadyAt = performance.now();
  return {
    mode,
    startedAt,
    ...(runtimeReadyAt === undefined ? {} : { runtimeReadyAt }),
    entryReadyAt,
    readyMs: entryReadyAt - startedAt,
    hasRunExport: typeof api.runExport === "function",
    hasPreparation: typeof api.prepareDocxExportRuntime === "function",
  };
}

declare global {
  interface Window {
    __ATLCLI_LOAD_DOCX_ENTRY?: typeof loadDocxEntry;
  }
}

window.__ATLCLI_LOAD_DOCX_ENTRY = loadDocxEntry;
