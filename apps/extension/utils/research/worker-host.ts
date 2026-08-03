import {
  ResearchContractError,
  type ResearchOneShotPolicyV1,
  type ResearchOneShotEventV1,
  type ResearchProgressV1,
  type ResearchReport,
  type ResearchRequestV1,
} from "./contracts.js";
import { classifyResearchError } from "@atlcli/research";
import type {
  ResearchWorkerRequestV1,
  ResearchWorkerResponseV1,
} from "./worker-protocol.js";

interface WorkerLike {
  onmessage: ((event: MessageEvent<ResearchWorkerResponseV1>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ResearchWorkerRequestV1): void;
  terminate(): void;
}

interface ActiveRun {
  worker: WorkerLike;
  reject: (reason: unknown) => void;
}

export class ResearchAgentWorkerHost {
  readonly #createWorker: () => WorkerLike;
  readonly #active = new Map<string, ActiveRun>();

  constructor(options: { createWorker: () => WorkerLike }) {
    this.#createWorker = options.createWorker;
  }

  run(input: {
    runId: string;
    sessionId: string;
    turnId: string;
    apiKey: string;
    mode?: "chat" | "research";
    request?: ResearchRequestV1;
    policy?: ResearchOneShotPolicyV1;
    resume?: true;
    onProgress?: (progress: ResearchProgressV1) => void;
    onEvent?: (event: ResearchOneShotEventV1) => void;
  }): Promise<ResearchReport> {
    if (this.#active.has(input.runId)) {
      throw new ResearchContractError("invalid-request", "Research run id is already active.");
    }
    const worker = this.#createWorker();
    return new Promise<ResearchReport>((resolve, reject) => {
      this.#active.set(input.runId, { worker, reject });
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.runId !== input.runId) return;
        if (message.kind === "research-worker:progress") {
          input.onProgress?.(message.progress);
          return;
        }
        if (message.kind === "research-worker:event") {
          input.onEvent?.(message.event);
          return;
        }
        if (message.kind === "research-worker:complete") {
          resolve(message.report);
          return;
        }
        reject(new ResearchContractError(message.code, message.error));
      };
      worker.onerror = (event) => {
        const classified = classifyResearchError(event.error ?? event.message);
        reject(new ResearchContractError(classified.code, classified.message));
      };
      if (input.resume) {
        worker.postMessage({
          kind: "research-worker:run",
          runId: input.runId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          apiKey: input.apiKey,
          resume: true,
        });
        return;
      }
      if (!input.request) {
        reject(new ResearchContractError(
          "invalid-request",
          "A new research worker run requires a request.",
        ));
        return;
      }
      worker.postMessage({
        kind: "research-worker:run",
        runId: input.runId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        apiKey: input.apiKey,
        mode: input.mode ?? "research",
        request: input.request,
        ...(input.policy ? { policy: input.policy } : {}),
      });
    }).finally(() => {
      const active = this.#active.get(input.runId);
      if (active?.worker === worker) this.#active.delete(input.runId);
      worker.terminate();
    });
  }

  cancel(runId: string): boolean {
    return this.#interrupt(
      runId,
      new ResearchContractError("cancelled", "The research run was cancelled."),
    );
  }

  /** Stop a worker at an already persisted durable pause checkpoint. */
  pause(runId: string): boolean {
    return this.#interrupt(
      runId,
      new ResearchContractError("paused", "The research run reached a durable pause checkpoint."),
    );
  }

  #interrupt(runId: string, reason: ResearchContractError): boolean {
    const active = this.#active.get(runId);
    if (!active) return false;
    this.#active.delete(runId);
    active.worker.terminate();
    active.reject(reason);
    return true;
  }
}
