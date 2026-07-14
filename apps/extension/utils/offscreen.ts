/**
 * Offscreen-document lifecycle helper (spec 002 §2.3, Task 3).
 *
 * MV3 service workers are short-lived, so multi-second WASM jobs (Typst compile
 * in spec 005) must run in an offscreen document. `ensureOffscreen()` creates
 * that document exactly once and is safe under concurrent/repeated invocation:
 * a single-flight in-flight promise — assigned BEFORE any await and shared by
 * all concurrent callers — coalesces the whole `getContexts` + `createDocument`
 * sequence, so a delayed/stale `getContexts` result can never race a second
 * `createDocument`.
 *
 * The chrome dependency is injectable (`deps`) so the helper is unit-testable
 * with a mocked `chrome.offscreen` without touching a real browser.
 */

/** The slice of the `chrome` API `ensureOffscreen` depends on. */
export interface OffscreenChrome {
  runtime: {
    getURL(path: string): string;
    getContexts(filter: {
      contextTypes: string[];
      documentUrls?: string[];
    }): Promise<unknown[]>;
  };
  offscreen: {
    createDocument(opts: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
  };
}

/** Default path to the bundled offscreen document (WXT flattens dir/index.html). */
export const OFFSCREEN_PATH = "offscreen.html";

let ensuring: Promise<void> | null = null;

/** Test-only: reset the in-flight guard between unit tests. */
export function __resetOffscreenState(): void {
  ensuring = null;
}

/**
 * The full check-then-create sequence for one ensure operation. Kept private so
 * the single-flight promise wraps BOTH the `getContexts` check and the
 * `createDocument` call — never just the create.
 */
async function doEnsure(deps: OffscreenChrome, path: string): Promise<void> {
  const url = deps.runtime.getURL(path);

  const existing = await deps.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (existing.length > 0) return;

  await deps.offscreen.createDocument({
    url: path,
    reasons: ["WORKERS"],
    justification:
      "Instantiate and run WebAssembly modules (e.g. Typst compilation in spec 005) off the short-lived MV3 service worker.",
  });
}

/**
 * Ensure the offscreen document exists, creating it at most once.
 *
 * Single-flight: the in-flight promise is assigned BEFORE any await, so all
 * concurrent callers await the exact same operation. A second caller therefore
 * never runs its own `getContexts` — eliminating the window where a stale empty
 * `getContexts` result could trigger a duplicate `createDocument`.
 *
 * @param deps  chrome-like API (defaults to the ambient global `chrome`).
 * @param path  offscreen document path (defaults to {@link OFFSCREEN_PATH}).
 */
export function ensureOffscreen(
  deps: OffscreenChrome = (globalThis as unknown as { chrome: OffscreenChrome }).chrome,
  path: string = OFFSCREEN_PATH
): Promise<void> {
  if (ensuring) return ensuring;
  ensuring = doEnsure(deps, path).finally(() => {
    ensuring = null;
  });
  return ensuring;
}
