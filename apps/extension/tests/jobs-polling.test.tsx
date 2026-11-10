/**
 * `useDurableJobs` keeps reading: a failed read is retried, an unchanged read
 * does not re-render, and a `jobs:changed` hint triggers an immediate re-read.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { DurableJobsProvider, useDurableJobs } from "../utils/jobs/context.js";
import type { DurableJobsPort, ExportActivityJob } from "../utils/jobs/store.js";
import { createReactHarness } from "./react-harness.js";

const harness = createReactHarness();
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  harness.setup();
  // The poll cadences are seconds; the test only cares that a timer is armed.
  globalThis.setTimeout = ((handler: () => void, ms?: number) =>
    realSetTimeout(handler, (ms ?? 0) >= 1_000 ? 1 : ms)) as typeof setTimeout;
});
afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  await harness.teardown();
});
afterAll(() => expect(harness.leakedGlobals()).toEqual([]));

const job = (key: string): ExportActivityJob =>
  ({ key, actions: {} }) as unknown as ExportActivityJob;

function port(list: DurableJobsPort["list"], extra: Partial<DurableJobsPort> = {}): DurableJobsPort {
  return {
    list,
    getPreferences: async () => ({ pulseEnabled: true }),
    ...extra,
  } as DurableJobsPort;
}

let renders = 0;
function Probe(): React.JSX.Element {
  const view = useDurableJobs(null);
  const seen = React.useRef(view.jobs);
  if (seen.current !== view.jobs) {
    seen.current = view.jobs;
    renders += 1;
  }
  return (
    <p data-testid="probe">
      {view.jobs.map((entry) => entry.key).join(",")}|{view.error ?? "ok"}
    </p>
  );
}

describe("useDurableJobs", () => {
  it("keeps polling after a failed read", async () => {
    let calls = 0;
    const jobs = port(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient read failure");
      return [job("common:a")];
    });
    await harness.render(<DurableJobsProvider port={jobs}><Probe /></DurableJobsProvider>);
    await harness.flush(8);
    expect(harness.find("probe").textContent).toBe("common:a|ok");
  });

  it("keeps the same list when a poll finds nothing new", async () => {
    renders = 0;
    let calls = 0;
    const jobs = port(async () => {
      calls += 1;
      return [job("common:a")];
    });
    await harness.render(<DurableJobsProvider port={jobs}><Probe /></DurableJobsProvider>);
    await harness.flush(8);
    expect(calls).toBeGreaterThan(2);
    expect(renders).toBe(1);
  });

  it("re-reads when the port announces a change", async () => {
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = realSetTimeout; // real cadence: only the hint can re-read
    let announce: () => void = () => undefined;
    let unsubscribed = false;
    let rows = [job("common:a")];
    const jobs = port(async () => rows, {
      onChanged(listener) {
        announce = listener;
        return () => {
          unsubscribed = true;
        };
      },
    });
    await harness.render(<DurableJobsProvider port={jobs}><Probe /></DurableJobsProvider>);
    rows = [job("common:a"), job("common:b")];
    const { act } = await import("react");
    await act(async () => announce());
    await harness.flush();
    expect(harness.find("probe").textContent).toBe("common:a,common:b|ok");
    await harness.teardown();
    expect(unsubscribed).toBe(true);
    harness.setup();
    globalThis.setTimeout = realTimeout;
  });
});
