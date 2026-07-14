/**
 * Typed message protocol for the atlcli extension (spec 002 §2.3).
 *
 * All cross-context messages (side panel <-> service worker <-> offscreen)
 * are members of the `ExtMessage` discriminated union, keyed on `kind`. Both
 * sides exhaustively switch on `kind`; later specs EXTEND this union rather
 * than inventing ad-hoc messages.
 *
 * Request/response pairing rides `chrome.runtime.sendMessage`'s response
 * callback (promise-returning in MV3): a request message resolves to its
 * paired response, related by the `ResponseFor<K>` mapping below.
 */

/** Request messages sent from the panel to the service worker. */
export type ExtRequest =
  | { kind: "ping" }
  | { kind: "wasm-smoke"; a: number; b: number };

/** Response messages returned to the panel. */
export type ExtResponse =
  | { kind: "pong" }
  | { kind: "wasm-smoke-result"; ok: true; result: number }
  | { kind: "wasm-smoke-result"; ok: false; error: string };

/**
 * Internal messages the service worker forwards to the offscreen document.
 * Namespaced (`offscreen:`) so the SW's own panel-facing listener ignores them
 * (no self-delivery loop over the shared `chrome.runtime` message bus).
 */
export type OffscreenRequest = { kind: "offscreen:wasm-add"; a: number; b: number };
export type OffscreenResponse =
  | { kind: "offscreen:wasm-add-result"; ok: true; result: number }
  | { kind: "offscreen:wasm-add-result"; ok: false; error: string };

/** Every message that can travel over the protocol. */
export type ExtMessage =
  | ExtRequest
  | ExtResponse
  | OffscreenRequest
  | OffscreenResponse;

/** Discriminant literal type for requests. */
export type ExtRequestKind = ExtRequest["kind"];

/**
 * Maps a request `kind` to the exact response type the router resolves with.
 * Keeps `sendMessage` call sites type-safe without runtime cost.
 */
export interface ResponseMap {
  ping: Extract<ExtResponse, { kind: "pong" }>;
  "wasm-smoke": Extract<ExtResponse, { kind: "wasm-smoke-result" }>;
}

export type ResponseFor<K extends ExtRequestKind> = ResponseMap[K];

/** Narrowing type guard for panel-facing request messages. */
export function isExtRequest(value: unknown): value is ExtRequest {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "ping" || kind === "wasm-smoke";
}

/** Narrowing type guard for offscreen-bound request messages. */
export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (typeof value !== "object" || value === null) return false;
  return (value as { kind?: unknown }).kind === "offscreen:wasm-add";
}
