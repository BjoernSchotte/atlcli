/**
 * Panel-initiated detection pull (spec 003 Task 1 wiring, imperative-shell glue).
 *
 * Extracted from App.tsx so the mount pull AND the visibility/focus re-pull share
 * one code path and so the logic is unit-testable without importing the React
 * shell (which touches `chrome.*` at module load). Pure over its two injected
 * deps — a `send` transport and a `dispatch` sink.
 */
import type { ExtResponse } from "./messages.js";
import type { PanelEvent } from "./panel-state.js";

/**
 * Pull the current entity from the service worker and dispatch it as a
 * `detected` event.
 *
 * Swallows a rejected send (SW asleep) — a push will follow on the next tab
 * event. The reducer's `seq` ordering guard drops a stale pull that races a
 * newer push, so re-pulling on visibility/focus is always safe (spec 003 E2E:
 * after an extension reload an already-open Confluence tab fired no tab event,
 * so the panel showed nothing until F5; re-pulling recovers detection with no
 * page reload).
 */
export async function pullCurrentEntity(
  send: (message: { kind: "get-current-entity" }) => Promise<unknown>,
  dispatch: (event: PanelEvent) => void
): Promise<void> {
  try {
    const res = (await send({ kind: "get-current-entity" })) as ExtResponse | undefined;
    if (!res || res.kind !== "current-entity") return;
    dispatch({
      type: "detected",
      url: res.detection.url,
      entity: res.detection.entity,
      seq: res.detection.seq,
    });
  } catch {
    /* SW asleep / no answer — a push will follow on the next tab event */
  }
}
