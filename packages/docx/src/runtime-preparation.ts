import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import type { ExportBlock } from "@atlcli/confluence";

export interface PrepareDocxExportRuntimeOptions {
  codeTheme?: CodeThemeId;
  /**
   * Explicitly preload and validate the bundled code font while known
   * highlighting grammars are prepared.
   *
   * Defaults to `false`. The renderer owns the authoritative demand check
   * after macro resolution, include expansion, diagram fallback, and OOXML
   * serialization, so an empty or no-code preflight performs no font work.
   */
  preloadCodeFont?: boolean;
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
 * Warm the deterministic DOCX highlighting runtime after explicit intent.
 *
 * Highlighting is conditional on the known block tree. Font demand cannot be
 * inferred safely here: inline and nested content, resolved macros/includes,
 * and Mermaid fallback can change the emitted OOXML. The renderer therefore
 * stages the font from completed OOXML; hosts may request explicit preload when
 * they intentionally want to overlap the same shared work with acquisition.
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
  const codeFont = options.preloadCodeFont
    ? (async () => {
        const phaseStartedAt = nowMs();
        const module = await import("./font-embedding.js");
        const bytes = await module.loadValidatedBundledCodeFont();
        codeFontBytes = bytes.byteLength;
        codeFontMs = nowMs() - phaseStartedAt;
      })()
    : Promise.resolve();
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
