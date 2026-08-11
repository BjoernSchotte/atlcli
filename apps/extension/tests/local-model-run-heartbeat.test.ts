import { describe, expect, it } from "bun:test";
import { withLocalRunHeartbeatV1 } from "../utils/research/run-heartbeat.js";

describe("local Gemma MV3 run heartbeat", () => {
  it("keeps a silent local operation alive and stops after completion", async () => {
    let tick: (() => void) | undefined;
    const cancelled: number[] = [];
    const beats: string[] = [];
    let finish: (value: string) => void = () => undefined;
    const operation = new Promise<string>((resolve) => { finish = resolve; });

    const result = withLocalRunHeartbeatV1({
      runId: "run-local",
      operation: () => operation,
      sendHeartbeat: (runId) => { beats.push(runId); },
      schedule: (callback, intervalMs) => {
        expect(intervalMs).toBe(20_000);
        tick = callback;
        return 41 as unknown as ReturnType<typeof setInterval>;
      },
      cancel: (handle) => { cancelled.push(handle as unknown as number); },
    });

    tick?.();
    tick?.();
    await Promise.resolve();
    expect(beats).toEqual(["run-local", "run-local"]);

    finish("done");
    await expect(result).resolves.toBe("done");
    expect(cancelled).toEqual([41]);
  });

  it("stops the heartbeat when the local operation fails", async () => {
    const cancelled: number[] = [];
    const result = withLocalRunHeartbeatV1({
      runId: "run-failed",
      operation: async () => { throw new Error("model failed"); },
      sendHeartbeat: () => undefined,
      schedule: () => 42 as unknown as ReturnType<typeof setInterval>,
      cancel: (handle) => { cancelled.push(handle as unknown as number); },
    });

    await expect(result).rejects.toThrow("model failed");
    expect(cancelled).toEqual([42]);
  });
});
