/**
 * Cross-engine export progress event (spec 002, Engine integration).
 *
 * One event shape both engines and the tree fetch emit so a host (CLI spinner,
 * extension panel) drives a single progress channel across every phase of a
 * tree/space export — discovery, body fetch, composition, asset embedding,
 * serialization, and final emit. Distinct from the coarse `onPhase` channel the
 * PDF engine already carries: this is the granular, per-item channel.
 *
 * `done` is monotonically non-decreasing WITHIN a phase; `total` is `null` while
 * a phase's item count is still unknown (e.g. discovery before the tree size is
 * known). Isomorphic: a pure type, no imports.
 */
export type ExportPhase =
  | "discover"
  | "fetch"
  | "compose"
  | "assets"
  | "serialize"
  | "emit";

export interface ExportProgressEvent {
  phase: ExportPhase;
  /** Items completed in this phase so far (monotonic non-decreasing per phase). */
  done: number;
  /** Total items in this phase, or `null` while still unknown. */
  total: number | null;
  /** Optional human detail (e.g. the current page title or asset filename). */
  detail?: string;
  /** True when this event reports a retry (e.g. a 429/5xx backoff). */
  retrying?: boolean;
}

/** Callback shape hosts pass to the engines / tree fetch. */
export type ExportProgressCallback = (event: ExportProgressEvent) => void;
