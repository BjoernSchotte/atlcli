/**
 * Pure, resettable idle timer (functional core — spec 002 §2.3 idle closure).
 *
 * The MV3 service worker uses this to close the offscreen document after a
 * period with no offscreen requests: each request calls `reset()`, and when the
 * idle window elapses without a further reset, `onIdle` fires exactly once.
 *
 * Timer scheduling is injectable so the logic is deterministically unit-testable
 * with a fake clock (no real wall-clock waits). It is best-effort by design: an
 * MV3 SW may be torn down before the timer fires — that is fine, because the
 * offscreen document dies with the extension process anyway.
 */

export type TimerId = ReturnType<typeof setTimeout>;

export interface IdleTimerOptions {
  /** Idle window in ms; elapsing without a `reset()` fires `onIdle`. */
  delayMs: number;
  /** Invoked once each time the idle window elapses. */
  onIdle: () => void;
  /** Injectable scheduler (defaults to the ambient `setTimeout`). */
  schedule?: (fn: () => void, ms: number) => TimerId;
  /** Injectable canceller (defaults to the ambient `clearTimeout`). */
  cancel?: (id: TimerId) => void;
}

export interface IdleTimer {
  /** Record activity: (re)arm the idle countdown from now. */
  reset(): void;
  /** Stop the countdown; no `onIdle` fires until the next `reset()`. */
  stop(): void;
}

/** Create a resettable idle timer. */
export function createIdleTimer(opts: IdleTimerOptions): IdleTimer {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((id) => clearTimeout(id));
  let handle: TimerId | null = null;

  function stop(): void {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  }

  function reset(): void {
    stop();
    handle = schedule(() => {
      handle = null;
      opts.onIdle();
    }, opts.delayMs);
  }

  return { reset, stop };
}
