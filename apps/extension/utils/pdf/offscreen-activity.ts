/**
 * Offscreen-document activity policy (spec 010 T5.3).
 *
 * The offscreen document owns the compiler worker, and the worker memoizes its
 * Typst compiler (wasm + fonts) for its whole lifetime. Closing the document
 * therefore costs the next compile a full cold init — which is exactly the cost
 * T5.3's debounced preview loop exists to avoid paying on every keystroke.
 *
 * Two failure modes this encodes against:
 *
 *   - **Closing too eagerly.** A preview compile is offscreen activity like any
 *     other. While one is in flight the idle timer must be *stopped*, not
 *     merely re-armed, so a long compile cannot be interrupted by its own
 *     start-time countdown.
 *   - **Never closing.** The mirror-image bug: if activity only ever stops the
 *     timer, the document lives forever and the ≥ 20 MB wasm artifact stays
 *     resident after the user walks away. The timer is re-armed the moment the
 *     last job finishes, so a quiet panel still closes the document.
 *
 * Between two debounced previews (~400 ms) nothing closes: the re-arm sets a
 * five-minute countdown that the next compile cancels long before it fires.
 * That is the intended behaviour, and the reason this is a counter rather than
 * a flag — two overlapping jobs must not let the first one's completion re-arm
 * the timer under the second.
 *
 * Pure apart from the injected timer, so both modes are unit-testable without a
 * browser (`tests/pdf/offscreen-activity.test.ts`).
 */

/** The slice of `createIdleTimer` this policy drives. */
export interface IdleTimerLike {
  /** Cancel any pending idle close. */
  stop(): void;
  /** (Re-)arm the idle close. */
  reset(): void;
}

export interface OffscreenActivityTracker {
  /** A job started. Cancels the idle close for as long as it runs. */
  begin(): void;
  /** A job finished. Re-arms the idle close once the last one is done. */
  end(): void;
  /** Non-job traffic (a ping, a wasm smoke test): re-arm only when idle. */
  touch(): void;
  /** Jobs currently in flight. */
  readonly inFlight: number;
}

export function createOffscreenActivityTracker(timer: IdleTimerLike): OffscreenActivityTracker {
  let inFlight = 0;
  return {
    begin(): void {
      inFlight += 1;
      timer.stop();
    },
    end(): void {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) timer.reset();
    },
    touch(): void {
      if (inFlight === 0) timer.reset();
    },
    get inFlight(): number {
      return inFlight;
    },
  };
}
