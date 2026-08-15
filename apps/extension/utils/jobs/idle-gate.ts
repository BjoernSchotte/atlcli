/**
 * The durable gate in front of the offscreen idle timer (spec 010 T5.6,
 * Architecture point 3 defect (b)).
 *
 * ## The defect
 *
 * `background.ts` used to arm the idle close from an in-memory counter:
 * `runPdfCompile` did `activePdfJobs += 1; offscreenIdle.stop()` and, in its
 * `finally`, `activePdfJobs -= 1; if (0) offscreenIdle.reset()`. That counter is
 * a plain `let` in a **service worker Chrome may terminate at any moment**. After
 * a restart it reads `0` while a compile is still running in the offscreen
 * document (which has its own lifetime). A *second* job started afterwards then
 * completes, takes the counter 1 → 0, arms the timer — and five minutes later
 * `closeOffscreen()` kills the first, still-running compile. Its record stays
 * `compiling` forever and the panel never sees a result.
 *
 * ## The fix
 *
 * In-flight state is read from the **durable job records** instead. This wrapper
 * is an {@link IdleTimerLike}, so it slots in wherever the raw timer went and
 * covers *both* call sites at once — `runWasmSmoke`'s `touch()` and
 * `runPdfCompile`'s `end()` both funnel through `reset()`, which is exactly
 * where the counter used to lie.
 *
 * Two properties beyond "don't arm under a running job":
 *
 *   - **Someone must still arm it.** The job whose completion the restarted
 *     worker never observed will never call `end()` here, so a declined arm
 *     schedules a re-check rather than leaving the document resident forever.
 *   - **An unreadable store arms the timer.** Failing closed would mean a broken
 *     IndexedDB pins a ≥ 20 MB wasm artifact in memory indefinitely; failing
 *     open is at worst today's behaviour.
 */
import type { IdleTimerLike } from "../pdf/offscreen-activity.js";

export interface DurableIdleGateOptions {
  /** The real idle timer this gate arms or withholds. */
  timer: IdleTimerLike;
  /** How many jobs the durable records say are still in flight. */
  countInFlight: () => Promise<number>;
  /** How long to wait before re-testing after a declined arm. */
  recheckMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
  /** Surface a store read failure without taking the worker down. */
  onError?: (error: unknown) => void;
}

export interface DurableIdleGate extends IdleTimerLike {
  /** Resolves once the in-flight query behind the latest `reset()` has settled. */
  settled(): Promise<void>;
}

/** Re-test this often while a durable job is still running. */
export const DURABLE_IDLE_RECHECK_MS = 30_000;

export function createDurableIdleGate(options: DurableIdleGateOptions): DurableIdleGate {
  const recheckMs = options.recheckMs ?? DURABLE_IDLE_RECHECK_MS;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((id) => clearTimeout(id));
  let recheck: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> = Promise.resolve();
  // Only the newest arm request may act: an `end()` immediately followed by a
  // `begin()` must not have the first one's late store read re-arm the timer
  // under the job the second one just started.
  let generation = 0;

  function clearRecheck(): void {
    if (recheck !== null) {
      cancel(recheck);
      recheck = null;
    }
  }

  function stop(): void {
    generation += 1;
    clearRecheck();
    options.timer.stop();
  }

  function arm(mine: number): Promise<void> {
    return options
      .countInFlight()
      .then((inFlight) => {
        if (mine !== generation) return;
        if (inFlight > 0) {
          // A compile is running that this worker may know nothing about.
          options.timer.stop();
          clearRecheck();
          recheck = schedule(() => {
            recheck = null;
            if (mine === generation) pending = arm(mine);
          }, recheckMs);
          return;
        }
        clearRecheck();
        options.timer.reset();
      })
      .catch((error) => {
        options.onError?.(error);
        // Fail open: an unreadable store must not pin the offscreen document.
        if (mine === generation) options.timer.reset();
      });
  }

  function reset(): void {
    generation += 1;
    clearRecheck();
    pending = arm(generation);
  }

  return { reset, stop, settled: () => pending };
}
