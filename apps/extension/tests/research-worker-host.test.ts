import { describe, expect, it } from "bun:test";
import type {
  ResearchOneShotEventV1,
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
const policy = {
  schema: "atlcli.research-one-shot-policy/v1",
  requestedEffort: "analysis",
  requestedPlanApproval: "automatic",
  scopeExpansionMode: "ask",
  requestedReconciliation: "auto",
} as const;

describe("dedicated research worker host", () => {
  it("forwards progress and terminates the fresh worker after completion", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const progress: ResearchProgressV1[] = [];
    const events: ResearchOneShotEventV1[] = [];
    const resultPromise = host.run({
      runId: "run-1",
      sessionId: "research-session:run-1",
      turnId: "research-turn:run-1",
      apiKey: "synthetic-key",
      request,
      policy,
      onProgress: (value) => progress.push(value),
      onEvent: (value) => events.push(value),
    });

    expect(worker.posted).toEqual([
      {
        kind: "research-worker:run",
        runId: "run-1",
        sessionId: "research-session:run-1",
        turnId: "research-turn:run-1",
        apiKey: "synthetic-key",
        request,
        policy,
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
      kind: "research-worker:event",
      runId: "run-1",
      event: {
        kind: "artifact",
        seq: 1,
        at: "2026-07-31T12:00:00.000Z",
        path: "/artifacts/report.md",
      },
    });
    worker.emit({
      kind: "research-worker:complete",
      runId: "run-1",
      report,
    });

    expect(await resultPromise).toBe(report);
    expect(progress).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ kind: "artifact" })]);
    expect(worker.terminated).toBe(true);
  });

  it("terminates and rejects an active run on cancellation", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const resultPromise = host.run({
      runId: "run-cancel",
      sessionId: "research-session:run-cancel",
      turnId: "research-turn:run-cancel",
      apiKey: "synthetic-key",
      request,
    });

    expect(host.cancel("run-cancel")).toBe(true);
    await expect(resultPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.terminated).toBe(true);
    expect(host.cancel("run-cancel")).toBe(false);
  });

  it("forwards a durable resume without caller-controlled request or policy", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const resultPromise = host.run({
      runId: "run-resume",
      sessionId: "research-session:resume",
      turnId: "research-turn:resume",
      apiKey: "synthetic-key",
      resume: true,
    });

    expect(worker.posted).toEqual([{
      kind: "research-worker:run",
      runId: "run-resume",
      sessionId: "research-session:resume",
      turnId: "research-turn:resume",
      apiKey: "synthetic-key",
      resume: true,
    }]);
    worker.emit({ kind: "research-worker:complete", runId: "run-resume", report });
    expect(await resultPromise).toBe(report);
    expect(worker.terminated).toBe(true);
  });
});
