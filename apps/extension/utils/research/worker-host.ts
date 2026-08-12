import {
  ResearchContractError,
  type ChatPresentationStreamEventV1,
  type ChatAnswerV1,
  type ChatQualityPolicyV1,
  type ResearchOneShotPolicyV1,
  type ResearchOneShotEventV1,
  type ResearchProgressV1,
  type ResearchReport,
  type ResearchRequestV1,
} from "./contracts.js";
import {
  ChatUserQuestionRequiredError,
  type ChatHostIdentityV1,
  type ChatUserQuestionAnswerV1,
  type ChatInteractionStateV1,
} from "@atlcli/research";
import { classifyLocalGemmaHostErrorV1 } from "../local-model/error.js";
import type {
  ChatWorkerControlV1,
  ResearchWorkerRequestV1,
  ResearchWorkerResponseV1,
} from "./worker-protocol.js";

interface WorkerLike {
  onmessage: ((event: MessageEvent<ResearchWorkerResponseV1>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ResearchWorkerRequestV1, transfer?: Transferable[]): void;
  terminate(): void;
}

interface ActiveRun {
  worker: WorkerLike;
  reject: (reason: unknown) => void;
  interruption?: ResearchContractError;
  fallback?: ReturnType<typeof globalThis.setTimeout>;
  controls: Map<string, {
    resolve: (state: ChatInteractionStateV1) => void;
    reject: (reason: unknown) => void;
  }>;
}

interface ResearchAgentWorkerRunInput {
  runId: string;
  sessionId: string;
  turnId: string;
  apiKey: string;
  mode?: "chat" | "research";
  request?: ResearchRequestV1;
  policy?: ResearchOneShotPolicyV1;
  qualityPolicy?: ChatQualityPolicyV1;
  hostIdentity?: ChatHostIdentityV1;
  modelBinding?: {
    kind: "local-gemma";
    modelId: string;
    port: MessagePort;
  };
  resumeAnswer?: ChatUserQuestionAnswerV1;
  resumeCheckpoint?: {
    kind: "stream-interruption" | "steering";
  };
  resume?: true;
  onProgress?: (progress: ResearchProgressV1) => void;
  onEvent?: (event: ResearchOneShotEventV1) => void;
  onChatPresentation?: (event: ChatPresentationStreamEventV1) => void;
}

export class ResearchAgentWorkerHost {
  readonly #createWorker: () => WorkerLike;
  readonly #active = new Map<string, ActiveRun>();

  constructor(options: { createWorker: () => WorkerLike }) {
    this.#createWorker = options.createWorker;
  }

  run(input: ResearchAgentWorkerRunInput & { mode: "chat"; resume?: false }): Promise<ChatAnswerV1>;
  run(input: ResearchAgentWorkerRunInput & ({ mode?: "research" } | { resume: true })): Promise<ResearchReport>;
  run(input: ResearchAgentWorkerRunInput): Promise<ResearchReport | ChatAnswerV1>;
  run(input: ResearchAgentWorkerRunInput): Promise<ResearchReport | ChatAnswerV1> {
    if (this.#active.has(input.runId)) {
      throw new ResearchContractError("invalid-request", "Research run id is already active.");
    }
    const worker = this.#createWorker();
    return new Promise<ResearchReport | ChatAnswerV1>((resolve, reject) => {
      this.#active.set(input.runId, { worker, reject, controls: new Map() });
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.runId !== input.runId) return;
        const active = this.#active.get(input.runId);
        if (message.kind === "research-worker:chat-control-result") {
          const pending = active?.controls.get(message.controlId);
          if (!pending) return;
          active!.controls.delete(message.controlId);
          if (message.ok) pending.resolve(message.state);
          else pending.reject(new ResearchContractError(message.code, message.error));
          return;
        }
        if (active?.interruption) {
          if (
            message.kind === "research-worker:complete" ||
            message.kind === "research-worker:error" ||
            message.kind === "research-worker:hitl"
          ) {
            active.reject(active.interruption);
          }
          return;
        }
        if (message.kind === "research-worker:progress") {
          input.onProgress?.(message.progress);
          return;
        }
        if (message.kind === "research-worker:event") {
          input.onEvent?.(message.event);
          return;
        }
        if (message.kind === "research-worker:chat-presentation") {
          input.onChatPresentation?.(message.event);
          return;
        }
        if (message.kind === "research-worker:complete") {
          if ("answer" in message && message.answer) resolve(message.answer);
          else if ("report" in message && message.report) resolve(message.report);
          else reject(new ResearchContractError("provider-error", "The worker returned an empty completion."));
          return;
        }
        if (message.kind === "research-worker:hitl") {
          reject(new ChatUserQuestionRequiredError(message.question));
          return;
        }
        const classified = classifyLocalGemmaHostErrorV1(
          message.localDetail ?? message.error,
          input.modelBinding !== undefined,
        );
        reject(new ResearchContractError(classified.code, classified.message));
      };
      worker.onerror = (event) => {
        const classified = classifyLocalGemmaHostErrorV1(
          event.error ?? event.message,
          input.modelBinding !== undefined,
        );
        reject(new ResearchContractError(classified.code, classified.message));
      };
      if (input.resume) {
        const request: ResearchWorkerRequestV1 = {
          kind: "research-worker:run",
          runId: input.runId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          apiKey: input.apiKey,
          resume: true,
          ...(input.modelBinding ? { modelBinding: input.modelBinding } : {}),
        };
        worker.postMessage(request, input.modelBinding ? [input.modelBinding.port] : undefined);
        return;
      }
      if (!input.request) {
        reject(new ResearchContractError(
          "invalid-request",
          "A new research worker run requires a request.",
        ));
        return;
      }
      const request: ResearchWorkerRequestV1 = {
        kind: "research-worker:run",
        runId: input.runId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        apiKey: input.apiKey,
        mode: input.mode ?? "research",
        request: input.request,
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.qualityPolicy ? { qualityPolicy: input.qualityPolicy } : {}),
        ...(input.hostIdentity ? { hostIdentity: input.hostIdentity } : {}),
        ...(input.modelBinding ? { modelBinding: input.modelBinding } : {}),
        ...(input.resumeAnswer ? { resumeAnswer: input.resumeAnswer } : {}),
        ...(input.resumeCheckpoint ? { resumeCheckpoint: input.resumeCheckpoint } : {}),
      };
      worker.postMessage(request, input.modelBinding ? [input.modelBinding.port] : undefined);
    }).finally(() => {
      const active = this.#active.get(input.runId);
      if (active?.worker === worker) {
        if (active.fallback) globalThis.clearTimeout(active.fallback);
        this.#active.delete(input.runId);
        for (const pending of active.controls.values()) {
          pending.reject(new ResearchContractError("cancelled", "The Chat run ended before its control was accepted."));
        }
      }
      worker.terminate();
    });
  }

  cancel(runId: string): boolean {
    return this.#interrupt(
      runId,
      new ResearchContractError("cancelled", "The research run was cancelled."),
    );
  }

  control(
    runId: string,
    controlId: string,
    control: ChatWorkerControlV1,
  ): Promise<ChatInteractionStateV1> {
    const active = this.#active.get(runId);
    if (!active || active.interruption || active.controls.has(controlId)) {
      return Promise.reject(new ResearchContractError(
        "invalid-request",
        "The active Chat run cannot accept this control input.",
      ));
    }
    return new Promise<ChatInteractionStateV1>((resolve, reject) => {
      active.controls.set(controlId, { resolve, reject });
      active.worker.postMessage({
        kind: "research-worker:chat-control",
        runId,
        controlId,
        control,
      });
    });
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
    if (!active || active.interruption) return false;
    active.interruption = reason;
    active.worker.postMessage({
      kind: "research-worker:interrupt",
      runId,
      disposition: reason.code === "paused" ? "paused" : "cancelled",
    });
    active.fallback = globalThis.setTimeout(() => {
      const retained = this.#active.get(runId);
      if (retained !== active) return;
      active.reject(reason);
      active.worker.terminate();
      this.#active.delete(runId);
    }, 2_000);
    return true;
  }
}
