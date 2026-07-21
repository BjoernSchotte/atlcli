import { describe, expect, it } from "bun:test";
import { createOffscreenActivityTracker } from "../../utils/pdf/offscreen-activity.js";

function fakeTimer(): { stop(): void; reset(): void; log: string[] } {
  const log: string[] = [];
  return {
    log,
    stop: () => log.push("stop"),
    reset: () => log.push("reset"),
  };
}

/**
 * The two failure modes T5.3's debounced preview loop sits between: closing the
 * offscreen document (and with it the warm Typst compiler) too eagerly, and
 * never closing it at all.
 */
describe("offscreen activity tracker", () => {
  it("counts a preview compile as activity and re-arms the idle close afterwards", () => {
    const timer = fakeTimer();
    const tracker = createOffscreenActivityTracker(timer);
    tracker.begin();
    expect(tracker.inFlight).toBe(1);
    tracker.end();
    expect(tracker.inFlight).toBe(0);
    // The panel has gone quiet — the document must still close eventually.
    expect(timer.log).toEqual(["stop", "reset"]);
  });

  it("survives a debounce pause: back-to-back previews never leave the timer armed while compiling", () => {
    const timer = fakeTimer();
    const tracker = createOffscreenActivityTracker(timer);
    for (let i = 0; i < 3; i += 1) {
      tracker.begin();
      tracker.end();
    }
    expect(timer.log).toEqual(["stop", "reset", "stop", "reset", "stop", "reset"]);
    // Every compile window is a `stop`; the countdown only runs between them.
    expect(timer.log.filter((entry) => entry === "reset")).toHaveLength(3);
  });

  it("does not re-arm under an overlapping job", () => {
    const timer = fakeTimer();
    const tracker = createOffscreenActivityTracker(timer);
    tracker.begin();
    tracker.begin();
    tracker.end();
    // One job is still running: arming here is the T5.6 defect (b) — the idle
    // timer closing an offscreen document mid-compile.
    expect(timer.log).toEqual(["stop", "stop"]);
    tracker.end();
    expect(timer.log).toEqual(["stop", "stop", "reset"]);
  });

  it("touch() only arms the timer when nothing is running", () => {
    const timer = fakeTimer();
    const tracker = createOffscreenActivityTracker(timer);
    tracker.touch();
    expect(timer.log).toEqual(["reset"]);
    tracker.begin();
    tracker.touch();
    expect(timer.log).toEqual(["reset", "stop"]);
  });

  it("never lets the counter go negative on an unbalanced end()", () => {
    const timer = fakeTimer();
    const tracker = createOffscreenActivityTracker(timer);
    tracker.end();
    tracker.end();
    expect(tracker.inFlight).toBe(0);
    tracker.begin();
    expect(tracker.inFlight).toBe(1);
  });
});
