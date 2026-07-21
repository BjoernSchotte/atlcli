/**
 * The durable idle gate — Architecture point 3 defect (b) (spec 010 T5.6).
 *
 * The bug, in one sentence: `background.ts#activePdfJobs` was an in-memory `let`
 * in a service worker Chrome may terminate at will, so after a restart it read
 * `0` while a compile was still running, and the *next* job's completion armed
 * the five-minute idle close that then tore the offscreen document down under
 * the first one.
 *
 * These tests reproduce that sequence directly: the tracker's counter is reset
 * (the restart), a second job completes, and the assertion is that the timer is
 * NOT armed while the records still say something is compiling.
 */
import { describe, expect, it } from "bun:test";
import { createDurableIdleGate } from "../../utils/jobs/idle-gate.js";
import { createOffscreenActivityTracker } from "../../utils/pdf/offscreen-activity.js";

function recordingTimer(): { events: string[]; stop(): void; reset(): void } {
  const events: string[] = [];
  return {
    events,
    stop: () => events.push("stop"),
    reset: () => events.push("reset"),
  };
}

describe("createDurableIdleGate", () => {
  it("arms the timer when the durable records say nothing is running", async () => {
    const timer = recordingTimer();
    const gate = createDurableIdleGate({ timer, countInFlight: async () => 0 });
    gate.reset();
    await gate.settled();
    expect(timer.events).toEqual(["reset"]);
  });

  it("withholds the timer while a durable record is still in flight", async () => {
    const timer = recordingTimer();
    const gate = createDurableIdleGate({
      timer,
      countInFlight: async () => 1,
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancel: () => undefined,
    });
    gate.reset();
    await gate.settled();
    expect(timer.events).toEqual(["stop"]);
    expect(timer.events).not.toContain("reset");
  });

  /**
   * The exact defect-(b) sequence, with the in-memory counter behaving exactly
   * as it did: job A starts, the worker restarts (counter back to zero), job B
   * runs and completes, and the tracker calls `reset()` because *its* count hit
   * zero. The gate must refuse, because A is still `compiling` in the store.
   */
  it("does not arm the timer after a restart while an older compile is still running", async () => {
    const timer = recordingTimer();
    let inFlightRecords = 1; // job A, still compiling in the offscreen document
    const gate = createDurableIdleGate({
      timer,
      countInFlight: async () => inFlightRecords,
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancel: () => undefined,
    });

    // --- service worker restart: a brand-new tracker, counter at zero --------
    const tracker = createOffscreenActivityTracker(gate);

    // Job B, started and finished entirely within the restarted worker.
    inFlightRecords = 2;
    tracker.begin();
    inFlightRecords = 1; // B finished; A is still compiling
    tracker.end();
    await gate.settled();

    expect(tracker.inFlight).toBe(0); // the volatile counter says "idle"
    expect(timer.events).not.toContain("reset"); // the records say otherwise
  });

  it("arms the timer once the older compile also finishes", async () => {
    const timer = recordingTimer();
    let inFlightRecords = 1;
    let fire: (() => void) | null = null;
    const gate = createDurableIdleGate({
      timer,
      countInFlight: async () => inFlightRecords,
      recheckMs: 1,
      schedule: (fn) => {
        fire = fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
    });

    gate.reset();
    await gate.settled();
    expect(timer.events).toEqual(["stop"]);

    // Nobody will call `end()` for the job this worker never observed, so the
    // gate must re-test on its own or the offscreen document lives forever.
    inFlightRecords = 0;
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();
    await gate.settled();
    expect(timer.events).toEqual(["stop", "reset"]);
  });

  it("fails open when the record store cannot be read", async () => {
    const timer = recordingTimer();
    const errors: unknown[] = [];
    const gate = createDurableIdleGate({
      timer,
      countInFlight: async () => {
        throw new Error("store unavailable");
      },
      onError: (error) => errors.push(error),
    });
    gate.reset();
    await gate.settled();
    // An unreadable store must not pin a ≥ 20 MB wasm artifact forever.
    expect(timer.events).toEqual(["reset"]);
    expect(errors).toHaveLength(1);
  });

  it("lets a newer stop() win over an in-flight arm", async () => {
    const timer = recordingTimer();
    let release: (() => void) | null = null;
    const gate = createDurableIdleGate({
      timer,
      countInFlight: () =>
        new Promise<number>((resolve) => {
          release = () => resolve(0);
        }),
    });
    gate.reset();
    gate.stop(); // a new job began before the store answered
    (release as unknown as () => void)();
    await gate.settled();
    expect(timer.events).toEqual(["stop"]);
  });
});
