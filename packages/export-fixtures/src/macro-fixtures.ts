/**
 * Spec 004 — macro-renderer registry conformance fixtures (case 004 `macros`).
 *
 * A deterministic, IO-free reproduction of the real macro resolver pass: a
 * storage fixture carrying a live-Jira macro, a draw.io diagram macro, and a
 * genuinely-unknown macro is parsed with the REAL `storageToBlocks`, then run
 * through the REAL `defaultRegistry` + `resolveMacroBlocks` with in-memory
 * ports (recorded Jira search payload, an attachment lookup). No network, no
 * client — the ports are the designed seam, fed plain closures over fixture
 * data (the pattern from `packages/export-macros/src/resolve.test.ts`).
 *
 * The SAME `resolveMacroFixtureBlocks()` runs in the browser harness and the
 * Bun/CLI parity runner, so a digest divergence is a real engine divergence.
 *
 * Contract this fixture proves:
 *   - the Jira JQL macro renders as a REAL `table` block (+ `macro-rendered-via`),
 *   - the unknown/degraded macros hit the placeholder FLOOR: the original
 *     `unknown` block is preserved and a `macro-degraded` note is emitted,
 *   - the draw.io renderer's attachment-lookup port is exercised (returns
 *     nothing here → the diagram macro also degrades to the floor).
 */
import {
  adfToBlocks,
  extractMacroBody,
  htmlToExportBlocks,
  parsePageProperties,
  storageToBlocks,
  type ExportBlock,
  type StorageToBlocksResult,
} from "@atlcli/confluence/browser";
import {
  defaultRegistry,
  resolveMacroBlocks,
  type AttachmentLookupPort,
  type ExportViewPort,
  type JiraIssuePort,
  type JiraIssueRef,
  type MacroExportContext,
} from "@atlcli/export-macros";
import type { PdfExportMetadata } from "@atlcli/pdf/browser";

/** PDF export metadata for the macro conformance case (fixed clock → deterministic). */
export const MACRO_METADATA: PdfExportMetadata = {
  title: "Macro Coverage",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

/** Recorded Jira search payload — deterministic, no live site. */
export const MACRO_JIRA_ISSUES: JiraIssueRef[] = [
  {
    key: "ATLCLI-1",
    summary: "Wire the macro registry",
    status: "Done",
    statusColor: "Green",
    url: "https://jira.invalid/browse/ATLCLI-1",
  },
  {
    key: "ATLCLI-2",
    summary: "Add the conformance case",
    status: "In Progress",
    statusColor: "Yellow",
    url: "https://jira.invalid/browse/ATLCLI-2",
  },
];

/** In-memory Jira port replaying the recorded payload for any JQL query. */
export function macroJiraPort(): JiraIssuePort {
  return {
    async getIssue(key: string): Promise<JiraIssueRef> {
      const found = MACRO_JIRA_ISSUES.find((i) => i.key === key);
      if (!found) throw new Error(`no recorded issue ${key}`);
      return found;
    },
    async searchJql(): Promise<JiraIssueRef[]> {
      return MACRO_JIRA_ISSUES;
    },
  };
}

/**
 * In-memory attachment-lookup port that never finds a preview attachment, so
 * the draw.io renderer exercises its port then falls through to the placeholder
 * floor (a clean, asset-free outcome that keeps both engines' output byte-stable
 * — no PNG bytes to embed, no divergent rasterization).
 */
export function macroAttachmentsPort(): AttachmentLookupPort {
  return {
    async lookup(): Promise<undefined> {
      return undefined;
    },
  };
}

/**
 * Storage exercising three renderer outcomes: a resolvable Jira JQL table, a
 * draw.io diagram whose preview is absent, and an unsupported custom macro.
 */
export const MACRO_STORAGE: string =
  `<ac:structured-macro ac:name="jira">` +
  `<ac:parameter ac:name="jqlQuery">project = ATLCLI ORDER BY created</ac:parameter>` +
  `<ac:parameter ac:name="columns">key,summary,status</ac:parameter>` +
  `</ac:structured-macro>` +
  `<ac:structured-macro ac:name="drawio">` +
  `<ac:parameter ac:name="diagramName">architecture</ac:parameter>` +
  `</ac:structured-macro>` +
  `<ac:structured-macro ac:name="customwidget" ac:macro-id="cw-1">` +
  `<ac:parameter ac:name="mode">interactive</ac:parameter>` +
  `<ac:rich-text-body><p>Widget body preserved on the floor.</p></ac:rich-text-body>` +
  `</ac:structured-macro>`;

/** Forge-shaped ADF extensions whose local IDs are their documented export REST IDs. */
export const MACRO_ADF_BLOCK_EXTENSION_LOCAL_ID = "forge-block-extension-local-id";
export const MACRO_ADF_BODIED_EXTENSION_LOCAL_ID = "forge-bodied-extension-local-id";
export const MACRO_ADF_EXTENSION = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "extension",
      attrs: {
        extensionType: "com.atlassian.ecosystem",
        extensionKey: "forge-block-export-widget",
        localId: MACRO_ADF_BLOCK_EXTENSION_LOCAL_ID,
        parameters: { mode: "print" },
      },
    },
    {
      type: "bodiedExtension",
      attrs: {
        extensionType: "com.atlassian.ecosystem",
        extensionKey: "forge-bodied-export-widget",
        localId: MACRO_ADF_BODIED_EXTENSION_LOCAL_ID,
        parameters: { mode: "print" },
      },
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Forge body fallback" }],
      }],
    },
  ],
} as const;

export const MACRO_ADF_BLOCK_EXPORT_TEXT = "Platform-rendered Forge block ADF export";
export const MACRO_ADF_BODIED_EXPORT_TEXT = "Platform-rendered Forge bodied ADF export";

/** Deterministic replay of Confluence's platform-rendered `adfExport` result. */
export function macroExportViewPort(): ExportViewPort {
  return {
    async renderMacroHtml(_pageId, macroId): Promise<string | undefined> {
      if (macroId === MACRO_ADF_BLOCK_EXTENSION_LOCAL_ID) {
        return `<p><strong>${MACRO_ADF_BLOCK_EXPORT_TEXT}</strong></p>`;
      }
      if (macroId === MACRO_ADF_BODIED_EXTENSION_LOCAL_ID) {
        return `<p><strong>${MACRO_ADF_BODIED_EXPORT_TEXT}</strong></p>`;
      }
      return undefined;
    },
  };
}

function macroContext(): MacroExportContext {
  return {
    page: { id: "macro-page", spaceKey: "TEST" },
    jira: macroJiraPort(),
    attachments: macroAttachmentsPort(),
    exportView: macroExportViewPort(),
    depth: 0,
    visited: new Set<string>(),
  };
}

/**
 * Run the full, real macro resolver pass for a target engine. `live: true` so
 * the live-port renderers (Jira, diagram) actually run; the diagram's absent
 * preview and the unknown macro both settle on the placeholder floor.
 */
export async function resolveMacroFixtureBlocks(
  targetEngine: "pdf" | "docx",
): Promise<StorageToBlocksResult> {
  const registry = defaultRegistry({
    storageToBlocks,
    htmlToExportBlocks,
    parsePageProperties,
    extractMacroBody,
  });
  const storage = storageToBlocks(MACRO_STORAGE, {
    exporter: targetEngine === "pdf" ? "pdf" : "word",
    pageContext: { id: "macro-page", spaceKey: "TEST", title: "Macro Coverage" },
  });
  const adf = adfToBlocks(MACRO_ADF_EXTENSION, {
    exporter: targetEngine === "pdf" ? "pdf" : "word",
    pageContext: { id: "macro-page", spaceKey: "TEST", title: "Macro Coverage" },
  });
  const parsed: StorageToBlocksResult = {
    blocks: [...storage.blocks, ...adf.blocks],
    notes: [...storage.notes, ...adf.notes],
  };
  return resolveMacroBlocks(parsed, registry, macroContext(), { live: true, targetEngine });
}

/** Count the top-level table blocks in a resolved set (the Jira render). */
export function countTables(blocks: readonly ExportBlock[]): number {
  return blocks.filter((b) => b.type === "table").length;
}

/** Count the remaining `unknown` (floor) blocks in a resolved set. */
export function countUnknown(blocks: readonly ExportBlock[]): number {
  return blocks.filter((b) => b.type === "unknown").length;
}

/** True when the platform-rendered Forge export replaced its ADF fallback. */
export function hasMacroAdfExport(blocks: readonly ExportBlock[]): boolean {
  const serialized = JSON.stringify(blocks);
  return serialized.includes(MACRO_ADF_BLOCK_EXPORT_TEXT) &&
    serialized.includes(MACRO_ADF_BODIED_EXPORT_TEXT);
}
