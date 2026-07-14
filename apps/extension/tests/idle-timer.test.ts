import { describe, expect, it } from "bun:test";
import { createIdleTimer, type TimerId } from "../utils/idle-timer.js";

/** Minimal deterministic fake clock (injected scheduler + canceller). */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (fn: () => void, ms: number): TimerId => {
      const id = ++seq;
      tasks.set(id, { at: now + ms, fn });
      return id as unknown as TimerId;
    },
    cancel: (id: TimerId): void => {
      tasks.delete(id as unknown as number);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...tasks]) {
        if (t.at <= now) {
          tasks.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe("createIdleTimer", () => {
  it("fires onIdle once after the idle window elapses", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createIdleTimer({
      delayMs: 1000,
      onIdle: () => (fired += 1),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    timer.reset();
    clock.advance(999);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    // Does not re-fire without another reset.
    clock.advance(5000);
    expect(fired).toBe(1);
  });

  it("re-arms from the last reset (activity postpones onIdle)", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createIdleTimer({
      delayMs: 1000,
      onIdle: () => (fired += 1),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    timer.reset();
    clock.advance(800);
    timer.reset(); // activity before idle window elapsed
    clock.advance(800); // 1600ms since first reset, only 800ms since last
    expect(fired).toBe(0);
    clock.advance(200); // now 1000ms since last reset
    expect(fired).toBe(1);
  });

  it("stop() cancels a pending onIdle", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createIdleTimer({
      delayMs: 1000,
      onIdle: () => (fired += 1),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    timer.reset();
    clock.advance(500);
    timer.stop();
    clock.advance(5000);
    expect(fired).toBe(0);
  });
});
