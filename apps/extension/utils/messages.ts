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

import type { AtlassianEntity } from "@atlcli/core";

/**
 * Detection payload shared by the SW push (`entity-changed`) and the
 * panel-initiated pull (`current-entity`): the active tab's URL and the entity
 * the extractor resolved from it (`null` for non-Atlassian / unrecognized tabs).
 */
export interface EntityDetection {
  /** Active tab URL, or `null` when no URL is available (e.g. no active tab). */
  url: string | null;
  /** Entity resolved via `extractEntityFromUrl`, or `null` when none matches. */
  entity: AtlassianEntity | null;
  /**
   * Monotonic ordering token stamped by the service worker's tab observer
   * (spec 003, finding: detection ordering). Both the SW push (`entity-changed`)
   * and the panel-initiated pull (`current-entity`) draw from the SAME counter,
   * so the panel can drop any detection older than the newest it has applied —
   * e.g. a delayed pull response for tab A that arrives after a newer push for
   * tab B must not clobber B.
   */
  seq: number;
}

/** Request messages sent from the panel to the service worker. */
export type ExtRequest =
  | { kind: "ping" }
  | { kind: "wasm-smoke"; a: number; b: number }
  | { kind: "get-current-entity" }
  | { kind: "pdf:compile"; jobId: string }
  | { kind: "pdf:cancel"; jobId: string };

/** Response messages returned to the panel. */
export type ExtResponse =
  | { kind: "pong" }
  | { kind: "wasm-smoke-result"; ok: true; result: number }
  | { kind: "wasm-smoke-result"; ok: false; error: string }
  | { kind: "current-entity"; detection: EntityDetection }
  | { kind: "pdf:compile-result"; jobId: string; ok: true }
  | { kind: "pdf:compile-result"; jobId: string; ok: false; error: string }
  | { kind: "pdf:cancel-result"; jobId: string; cancelled: boolean };

/**
 * Push message: the service worker (canonical tab observer, PLAN §2.1) notifies
 * the panel that the active tab's entity changed. Fire-and-forget — no paired
 * response — so it is NOT part of `ExtRequest`/`ResponseMap`. The panel filters
 * for it with {@link isEntityChanged}.
 */
export type EntityChanged = { kind: "entity-changed"; detection: EntityDetection };

/**
 * Internal messages the service worker forwards to the offscreen document.
 * Namespaced (`offscreen:`) so the SW's own panel-facing listener ignores them
 * (no self-delivery loop over the shared `chrome.runtime` message bus).
 */
export type OffscreenRequest =
  | { kind: "offscreen:wasm-add"; a: number; b: number }
  | { kind: "offscreen:pdf-compile"; jobId: string }
  | { kind: "offscreen:pdf-cancel"; jobId: string };
export type OffscreenResponse =
  | { kind: "offscreen:wasm-add-result"; ok: true; result: number }
  | { kind: "offscreen:wasm-add-result"; ok: false; error: string }
  | { kind: "offscreen:pdf-compile-result"; jobId: string; ok: true }
  | { kind: "offscreen:pdf-compile-result"; jobId: string; ok: false; error: string }
  | { kind: "offscreen:pdf-cancel-result"; jobId: string; cancelled: boolean };

/** Every message that can travel over the protocol. */
export type ExtMessage =
  | ExtRequest
  | ExtResponse
  | EntityChanged
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
  "get-current-entity": Extract<ExtResponse, { kind: "current-entity" }>;
  "pdf:compile": Extract<ExtResponse, { kind: "pdf:compile-result" }>;
  "pdf:cancel": Extract<ExtResponse, { kind: "pdf:cancel-result" }>;
}

export type ResponseFor<K extends ExtRequestKind> = ResponseMap[K];

/** Narrowing type guard for panel-facing request messages. */
export function isExtRequest(value: unknown): value is ExtRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; jobId?: unknown };
  const kind = candidate.kind;
  if (kind === "pdf:compile" || kind === "pdf:cancel") return isPdfJobId(candidate.jobId);
  return kind === "ping" || kind === "wasm-smoke" || kind === "get-current-entity";
}

/** Narrowing type guard for the SW→panel `entity-changed` push message. */
export function isEntityChanged(value: unknown): value is EntityChanged {
  if (typeof value !== "object" || value === null) return false;
  return (value as { kind?: unknown }).kind === "entity-changed";
}

/** Narrowing type guard for offscreen-bound request messages. */
export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; jobId?: unknown };
  if (candidate.kind === "offscreen:pdf-compile" || candidate.kind === "offscreen:pdf-cancel") {
    return isPdfJobId(candidate.jobId);
  }
  return candidate.kind === "offscreen:wasm-add";
}

function isPdfJobId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
