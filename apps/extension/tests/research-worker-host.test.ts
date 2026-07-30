import { describe, expect, it } from "bun:test";
import type {
  ResearchProgressV1,
  ResearchReportV1,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import { ResearchAgentWorkerHost } from "../utils/research/worker-host.js";
import type {
  ResearchWorkerRequestV1,
  ResearchWorkerResponseV1,
} from "../utils/research/worker-protocol.js";

class FakeWorker {
  onmessage:
    | ((event: MessageEvent<ResearchWorkerResponseV1>) => void)
    | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: ResearchWorkerRequestV1[] = [];
  terminated = false;

  postMessage(message: ResearchWorkerRequestV1): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: ResearchWorkerResponseV1): void {
    this.onmessage?.({ data: message } as MessageEvent<ResearchWorkerResponseV1>);
  }
}

const request = {
  schema: "atlcli.research-request/v1",
} as ResearchRequestV1;
const report = {
  schema: "atlcli.research-report/v1",
} as ResearchReportV1;

describe("dedicated research worker host", () => {
  it("forwards progress and terminates the fresh worker after completion", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const progress: ResearchProgressV1[] = [];
    const resultPromise = host.run({
      runId: "run-1",
      apiKey: "synthetic-key",
      request,
      onProgress: (value) => progress.push(value),
    });

    expect(worker.posted).toEqual([
      {
        kind: "research-worker:run",
        runId: "run-1",
        apiKey: "synthetic-key",
        request,
      },
    ]);
    worker.emit({
      kind: "research-worker:progress",
      runId: "run-1",
      progress: {
        phase: "researching",
        message: "Researching.",
        completedCalls: 1,
        maxCalls: 8,
      },
    });
    worker.emit({
      kind: "research-worker:complete",
      runId: "run-1",
      report,
    });

    expect(await resultPromise).toBe(report);
    expect(progress).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("terminates and rejects an active run on cancellation", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const resultPromise = host.run({
      runId: "run-cancel",
      apiKey: "synthetic-key",
      request,
    });

    expect(host.cancel("run-cancel")).toBe(true);
    await expect(resultPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.terminated).toBe(true);
    expect(host.cancel("run-cancel")).toBe(false);
  });
});
