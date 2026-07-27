import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import type { ExportBlock } from "@atlcli/confluence";

export interface PrepareDocxExportRuntimeOptions {
  codeTheme?: CodeThemeId;
  /**
   * Cancels only this caller's wait. Shared highlighter/font initialization
   * continues so one dismissed dialog cannot poison another caller's cache.
   */
  signal?: AbortSignal;
}

/** Local intent-to-ready evidence. Export/render timing remains in ExportReport. */
export interface DocxExportRuntimePreparation {
  totalMs: number;
  highlightingMs: number;
  codeFontMs: number;
  codeFontBytes: number;
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("DOCX runtime preparation was cancelled.", "AbortError");
}

/**
 * Race one caller against cancellation without passing its signal into shared
 * package initialization. The owned promise keeps rejection handlers attached
 * even when the caller leaves early.
 */
function waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Warm the complete deterministic DOCX render runtime after explicit intent.
 *
 * Highlighting is conditional on the known block tree. The bundled code font
 * is deliberately unconditional: inline code and included content can require
 * it without appearing in the initial code-block scan. Rendering still embeds
 * the font only when the produced OOXML uses it.
 */
export async function prepareDocxExportRuntime(
  blocks: readonly ExportBlock[],
  options: PrepareDocxExportRuntimeOptions = {},
): Promise<DocxExportRuntimePreparation> {
  const startedAt = nowMs();
  options.signal?.throwIfAborted();

  let highlightingMs = 0;
  let codeFontMs = 0;
  let codeFontBytes = 0;

  const highlighting = (async () => {
    const phaseStartedAt = nowMs();
    const module = await import("./code-highlighting.js");
    await module.prepareDocxCodeHighlighting(blocks, {
      ...(options.codeTheme ? { codeTheme: options.codeTheme } : {}),
    });
    highlightingMs = nowMs() - phaseStartedAt;
  })();
  const codeFont = (async () => {
    const phaseStartedAt = nowMs();
    const module = await import("./font-embedding.js");
    const bytes = await module.loadBundledCodeFont();
    await module.assertBundledCodeFont(bytes);
    codeFontBytes = bytes.byteLength;
    codeFontMs = nowMs() - phaseStartedAt;
  })();
  const operation = Promise.all([highlighting, codeFont]);

  await waitForCaller(operation, options.signal);
  options.signal?.throwIfAborted();
  return {
    totalMs: nowMs() - startedAt,
    highlightingMs,
    codeFontMs,
    codeFontBytes,
  };
}
