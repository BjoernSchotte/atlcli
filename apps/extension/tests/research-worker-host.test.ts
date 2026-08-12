import { describe, expect, it } from "bun:test";
import type {
  ChatPresentationStreamEventV1,
  ChatAnswerV1,
  ResearchOneShotEventV1,
  ResearchProgressV1,
  ResearchReportV1,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import { ResearchAgentWorkerHost } from "../utils/research/worker-host.js";
import {
  CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
  CHAT_USER_QUESTION_SCHEMA_V1,
  ChatUserQuestionRequiredError,
  type ChatInteractionStateV1,
} from "@atlcli/research";
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
  transfers: Array<Transferable[] | undefined> = [];
  terminated = false;

  postMessage(message: ResearchWorkerRequestV1, transfer?: Transferable[]): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: ResearchWorkerResponseV1): void {
    this.onmessage?.({ data: message } as MessageEvent<ResearchWorkerResponseV1>);
  }

  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  emitOpaqueError(filename = "chrome-extension://fixture/assets/research-agent.js"): void {
    this.onerror?.({
      error: undefined,
      message: "",
      filename,
      lineno: 0,
      colno: 0,
    } as ErrorEvent);
  }
}

const request = {
  schema: "atlcli.research-request/v1",
} as ResearchRequestV1;
const report = {
  schema: "atlcli.research-report/v1",
} as ResearchReportV1;
const answer = {
  schema: "atlcli.chat-answer/v1",
  messageMarkdown: "A concise answer.",
  citations: [],
  evidenceRefs: [],
  gaps: [],
  strategy: {
    qualityMode: "quick",
    path: "direct",
    delegated: false,
    reasonCode: "quick-direct",
    reasonCodes: ["quick-direct"],
    ambiguityDisposition: "none",
    requiredCapabilities: ["chat-answer"],
    expectedComplexity: "simple",
    qualityRisks: [],
  },
  run: {
    model: "synthetic-model",
    startedAt: "2026-08-05T08:00:00.000Z",
    completedAt: "2026-08-05T08:00:00.001Z",
    durationMs: 1,
    counts: {
      ptcCalls: 0,
      httpCalls: 0,
      jiraItems: 0,
      confluenceItems: 0,
    },
  },
} as ChatAnswerV1;
const policy = {
  schema: "atlcli.research-one-shot-policy/v1",
  requestedEffort: "analysis",
  requestedPlanApproval: "automatic",
  scopeExpansionMode: "ask",
  requestedReconciliation: "auto",
} as const;
const qualityPolicy = {
  mode: "quick",
  delegation: "disabled",
  completionTarget: "direct",
  planning: "none",
  scopeExpansion: "deny",
  providerReasoningPreference: "fast",
} as const;

describe("dedicated research worker host", () => {
  it("transfers the local model port into the existing Chat worker", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const channel = new MessageChannel();
    const running = host.run({
      runId: "chat-local-1",
      sessionId: "chat-session:local",
      turnId: "chat-turn:local",
      apiKey: "",
      mode: "chat",
      request,
      qualityPolicy,
      modelBinding: {
        kind: "local-gemma",
        modelId: "fixture/model",
        port: channel.port1,
      },
    });
    expect(worker.posted[0]).toMatchObject({
      kind: "research-worker:run",
      apiKey: "",
      modelBinding: { kind: "local-gemma", modelId: "fixture/model" },
    });
    expect(worker.transfers[0]).toEqual([channel.port1]);
    worker.emit({ kind: "research-worker:complete", runId: "chat-local-1", answer });
    expect(await running).toBe(answer);
    channel.port2.close();
  });

  it("surfaces a redacted local worker start error without weakening Anthropic errors", async () => {
    const localWorker = new FakeWorker();
    const localHost = new ResearchAgentWorkerHost({ createWorker: () => localWorker });
    const localChannel = new MessageChannel();
    const localRun = localHost.run({
      runId: "chat-local-start-error",
      sessionId: "chat-session:local-start-error",
      turnId: "chat-turn:local-start-error",
      apiKey: "",
      mode: "chat",
      request,
      qualityPolicy,
      modelBinding: {
        kind: "local-gemma",
        modelId: "fixture/model",
        port: localChannel.port1,
      },
    });
    localWorker.emitError("Module startup failed with x-api-key=secret-value");
    await expect(localRun).rejects.toMatchObject({
      code: "provider-error",
      message: "Local Gemma browser host failed: Module startup failed with x-api-key=[REDACTED]",
    });
    localChannel.port2.close();

    const anthropicWorker = new FakeWorker();
    const anthropicHost = new ResearchAgentWorkerHost({ createWorker: () => anthropicWorker });
    const anthropicRun = anthropicHost.run({
      runId: "chat-anthropic-start-error",
      sessionId: "chat-session:anthropic-start-error",
      turnId: "chat-turn:anthropic-start-error",
      apiKey: "synthetic-key",
      mode: "chat",
      request,
      qualityPolicy,
    });
    anthropicWorker.emitError("Module startup failed");
    await expect(anthropicRun).rejects.toMatchObject({
      code: "provider-error",
      message: "The research provider failed.",
    });
  });

  it("does not surface undefined when Chrome withholds local worker error details", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const channel = new MessageChannel();
    const running = host.run({
      runId: "chat-local-opaque-error",
      sessionId: "chat-session:local-opaque-error",
      turnId: "chat-turn:local-opaque-error",
      apiKey: "",
      mode: "chat",
      request,
      qualityPolicy,
      modelBinding: {
        kind: "local-gemma",
        modelId: "fixture/model",
        port: channel.port1,
      },
    });

    worker.emitOpaqueError();

    await expect(running).rejects.toMatchObject({
      code: "provider-error",
      message: "Local Gemma browser host failed: Research worker failed without browser error details at chrome-extension://fixture/assets/research-agent.js:0:0.",
    });
    channel.port2.close();
  });

  it("retains a redacted local worker diagnostic across the message boundary", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const channel = new MessageChannel();
    const running = host.run({
      runId: "chat-local-runtime-error",
      sessionId: "chat-session:local-runtime-error",
      turnId: "chat-turn:local-runtime-error",
      apiKey: "",
      mode: "chat",
      request,
      qualityPolicy,
      modelBinding: {
        kind: "local-gemma",
        modelId: "fixture/model",
        port: channel.port1,
      },
    });
    worker.emit({
      kind: "research-worker:error",
      runId: "chat-local-runtime-error",
      code: "provider-error",
      error: "The research provider failed.",
      localDetail: "Synthetic durable workspace failed with cookie=secret",
    });

    await expect(running).rejects.toMatchObject({
      code: "provider-error",
      message: "Local Gemma browser host failed: Synthetic durable workspace failed with cookie=[REDACTED]",
    });
    channel.port2.close();
  });

  it("transports a typed Chat checkpoint continuation without token replay state", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const running = host.run({
      runId: "chat-steering-resume-1",
      sessionId: "chat-session:steering-resume",
      turnId: "chat-turn:steering-resume",
      apiKey: "synthetic-key",
      mode: "chat",
      request,
      qualityPolicy,
      resumeCheckpoint: { kind: "steering" },
    });
    expect(worker.posted[0]).toEqual(expect.objectContaining({
      kind: "research-worker:run",
      resumeCheckpoint: { kind: "steering" },
    }));
    expect(JSON.stringify(worker.posted[0])).not.toContain("token");
    worker.emit({
      kind: "research-worker:complete",
      runId: "chat-steering-resume-1",
      answer,
    });
    expect(await running).toBe(answer);
  });

  it("serializes revision-fenced Chat queue controls through the owning worker", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const running = host.run({
      runId: "chat-control-1",
      sessionId: "chat-session:control-1",
      turnId: "chat-turn:control-1",
      apiKey: "synthetic-key",
      mode: "chat",
      request,
      qualityPolicy,
    });
    const controlled = host.control("chat-control-1", "control:enqueue-1", {
      kind: "enqueue",
      expectedRevision: 1,
      messageId: "chat-message:next",
      content: "Ask this next.",
      at: "2026-08-06T12:00:00.000Z",
    });
    expect(worker.posted.at(-1)).toMatchObject({
      kind: "research-worker:chat-control",
      runId: "chat-control-1",
      controlId: "control:enqueue-1",
      control: { kind: "enqueue", messageId: "chat-message:next" },
    });
    const interaction: ChatInteractionStateV1 = {
      schema: "atlcli.chat-interaction-state/v1",
      conversationId: "chat-session:control-1",
      revision: 2,
      binding: {
        userId: "browser-principal:control",
        providerCacheIdentity: "anthropic:browser-principal:control",
        threadId: "chat-session:control-1",
        tenantOrigin: "https://example.atlassian.net",
      },
      updatedAt: "2026-08-06T12:00:00.000Z",
      queue: [{
        id: "chat-message:next",
        revision: 1,
        content: "Ask this next.",
        enqueuedAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:00:00.000Z",
      }],
      resolvedQuestions: [],
    };
    worker.emit({
      kind: "research-worker:chat-control-result",
      runId: "chat-control-1",
      controlId: "control:enqueue-1",
      ok: true,
      state: interaction,
    });
    expect(await controlled).toEqual(interaction);
    worker.emit({ kind: "research-worker:complete", runId: "chat-control-1", answer });
    expect(await running).toBe(answer);
  });

  it("transports a durable Chat question and its exact resume answer", async () => {
    const question = {
      schema: CHAT_USER_QUESTION_SCHEMA_V1,
      id: "chat-question:scope",
      prompt: "Which approved scope should I use?",
      required: true,
      responseKind: "single_choice" as const,
      options: [
        { id: "scope:one", label: "First scope" },
        { id: "scope:two", label: "Second scope" },
      ],
    };
    const firstWorker = new FakeWorker();
    const firstHost = new ResearchAgentWorkerHost({ createWorker: () => firstWorker });
    const interrupted = firstHost.run({
      runId: "chat-hitl-1",
      sessionId: "chat-session:hitl",
      turnId: "chat-turn:hitl",
      apiKey: "synthetic-key",
      mode: "chat",
      request,
      qualityPolicy,
    });
    firstWorker.emit({ kind: "research-worker:hitl", runId: "chat-hitl-1", question });
    await expect(interrupted).rejects.toBeInstanceOf(ChatUserQuestionRequiredError);
    expect(firstWorker.terminated).toBe(true);

    const answerValue = {
      schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
      questionId: question.id,
      value: { kind: "selection" as const, optionIds: ["scope:one"] },
    };
    const secondWorker = new FakeWorker();
    const secondHost = new ResearchAgentWorkerHost({ createWorker: () => secondWorker });
    const resumed = secondHost.run({
      runId: "chat-hitl-2",
      sessionId: "chat-session:hitl",
      turnId: "chat-turn:hitl",
      apiKey: "synthetic-key",
      mode: "chat",
      request,
      qualityPolicy,
      resumeAnswer: answerValue,
    });
    expect(secondWorker.posted[0]).toMatchObject({
      kind: "research-worker:run",
      turnId: "chat-turn:hitl",
      resumeAnswer: answerValue,
    });
    secondWorker.emit({ kind: "research-worker:complete", runId: "chat-hitl-2", answer });
    expect(await resumed).toBe(answer);
  });

  it("returns a Chat answer only for an explicitly routed Chat run", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const resultPromise = host.run({
      runId: "chat-run-1",
      sessionId: "chat-session:run-1",
      turnId: "chat-turn:run-1",
      apiKey: "synthetic-key",
      mode: "chat",
      request,
      qualityPolicy,
    });

    expect(worker.posted).toEqual([expect.objectContaining({
      kind: "research-worker:run",
      mode: "chat",
      runId: "chat-run-1",
      qualityPolicy,
    })]);
    worker.emit({ kind: "research-worker:complete", runId: "chat-run-1", answer });

    expect(await resultPromise).toBe(answer);
    expect(worker.terminated).toBe(true);
  });

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
      qualityPolicy,
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
        mode: "research",
        request,
        policy,
        qualityPolicy,
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

  it("forwards ephemeral Chat presentation deltas without adding them to durable events", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const presentation: ChatPresentationStreamEventV1[] = [];
    const durableEvents: ResearchOneShotEventV1[] = [];
    const resultPromise = host.run({
      runId: "chat-stream-1",
      sessionId: "chat-session:stream-1",
      turnId: "chat-turn:stream-1",
      apiKey: "synthetic-key",
      mode: "chat",
      request,
      qualityPolicy,
      onEvent: (event) => durableEvents.push(event),
      onChatPresentation: (event) => presentation.push(event),
    });

    worker.emit({
      kind: "research-worker:chat-presentation",
      runId: "chat-stream-1",
      event: {
        kind: "chat-presentation",
        seq: 1,
        at: "2026-08-06T12:00:00.000Z",
        channel: "reasoning-summary",
        status: "delta",
        delta: "Checking the selected page.",
      },
    });
    expect(presentation.map((event) => event.delta)).toEqual(["Checking the selected page."]);
    expect(durableEvents).toEqual([]);

    worker.emit({ kind: "research-worker:complete", runId: "chat-stream-1", answer });
    expect(await resultPromise).toBe(answer);
  });

  it("cooperatively cancels an active run and quarantines a late completion", async () => {
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
    expect(worker.posted.at(-1)).toEqual({
      kind: "research-worker:interrupt",
      runId: "run-cancel",
      disposition: "cancelled",
    });
    expect(worker.terminated).toBe(false);
    worker.emit({ kind: "research-worker:complete", runId: "run-cancel", report });
    await expect(resultPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.terminated).toBe(true);
    expect(host.cancel("run-cancel")).toBe(false);
  });

  it("uses a distinct paused result for a durable pause interruption", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const resultPromise = host.run({
      runId: "run-pause",
      sessionId: "research-session:run-pause",
      turnId: "research-turn:run-pause",
      apiKey: "synthetic-key",
      request,
    });

    expect(host.pause("run-pause")).toBe(true);
    expect(worker.posted.at(-1)).toEqual({
      kind: "research-worker:interrupt",
      runId: "run-pause",
      disposition: "paused",
    });
    worker.emit({
      kind: "research-worker:error",
      runId: "run-pause",
      code: "paused",
      error: "Paused.",
    });
    await expect(resultPromise).rejects.toMatchObject({ code: "paused" });
    expect(worker.terminated).toBe(true);
    expect(host.pause("run-pause")).toBe(false);
  });

  it("forwards a durable resume without caller-controlled request or policy", async () => {
    const worker = new FakeWorker();
    const host = new ResearchAgentWorkerHost({ createWorker: () => worker });
    const hostileResume = {
      runId: "run-resume",
      sessionId: "research-session:resume",
      turnId: "research-turn:resume",
      apiKey: "synthetic-key",
      resume: true,
      // Hostile stale presenter fields are deliberately not part of the input
      // contract and must never be forwarded as resume authority.
      request,
      policy,
      sessionSnapshot: { revision: 999, status: "complete" },
    } as unknown as Parameters<typeof host.run>[0];
    const resultPromise = host.run(hostileResume);

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
