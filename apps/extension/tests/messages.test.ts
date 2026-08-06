import { describe, expect, it } from "bun:test";
import {
  isEntityChanged,
  isEntityChangedForWindow,
  isExtRequest,
  isExportJobsChanged,
  isOffscreenRequest,
  isChatPresentationMessage,
  isResearchEvent,
} from "../utils/messages.js";

describe("message guards", () => {
  it("accepts only bounded ephemeral Chat presentation messages", () => {
    const message = {
      kind: "research:chat-presentation",
      runId: "chat-run-1",
      event: {
        kind: "chat-presentation",
        seq: 1,
        at: "2026-08-06T12:00:00.000Z",
        channel: "reasoning-summary",
        status: "delta",
        delta: "Comparing the available evidence.",
      },
    } as const;
    expect(isChatPresentationMessage(message, "chat-run-1")).toBe(true);
    expect(isChatPresentationMessage({
      ...message,
      event: { ...message.event, signature: "must-not-cross" },
    })).toBe(false);
    expect(isChatPresentationMessage({
      ...message,
      event: { ...message.event, channel: "raw-chain-of-thought" },
    })).toBe(false);
  });

  it("isExtRequest accepts panel requests only", () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const opaqueJobId = "job-1";
    expect(isExtRequest({ kind: "ping" })).toBe(true);
    expect(isExtRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(true);
    expect(isExtRequest({ kind: "get-current-entity", windowId: 7 })).toBe(true);
    const panelChatRun = {
      kind: "research:run",
      runId: "run-chat-1",
      sessionId: "research-session:chat-1",
      turnId: "research-turn:chat-1",
      windowId: 7,
      mode: "chat",
      request: {},
    } as const;
    expect(isExtRequest(panelChatRun)).toBe(false);
    expect(isExtRequest({
      ...panelChatRun,
      hostIdentity: {
        userId: "browser-principal:synthetic",
        providerCacheIdentity: "provider-cache:synthetic",
      },
    })).toBe(true);
    const resumeAnswer = {
      schema: "atlcli.chat-user-question-answer/v1",
      questionId: "chat-question:scope",
      value: { kind: "selection", optionIds: ["scope:one"] },
    } as const;
    expect(isExtRequest({
      ...panelChatRun,
      hostIdentity: {
        userId: "browser-principal:synthetic",
        providerCacheIdentity: "provider-cache:synthetic",
      },
      resumeAnswer,
    })).toBe(true);
    expect(isExtRequest({
      ...panelChatRun,
      hostIdentity: {
        userId: "browser-principal:synthetic",
        providerCacheIdentity: "provider-cache:synthetic",
      },
      resumeAnswer: { ...resumeAnswer, value: { kind: "raw-chain-of-thought" } },
    })).toBe(false);
    expect(isExtRequest({
      ...panelChatRun,
      mode: "research",
    })).toBe(true);
    expect(isExtRequest({ kind: "get-current-entity" })).toBe(false);
    expect(isExtRequest({ kind: "get-current-entity", windowId: -1 })).toBe(false);
    expect(isExtRequest({ kind: "get-current-entity", windowId: 1.5 })).toBe(false);
    expect(isExtRequest({ kind: "pdf:compile", jobId })).toBe(true);
    expect(isExtRequest({ kind: "pdf:cancel", jobId })).toBe(true);
    expect(isExtRequest({ kind: "docx:prepare-runtime" })).toBe(true);
    expect(isExtRequest({
      kind: "docx:prepare-runtime",
      codeTheme: "github-dark",
    })).toBe(true);
    expect(isExtRequest({
      kind: "docx:prepare-runtime",
      codeTheme: "remote-theme",
    })).toBe(false);
    expect(isExtRequest({
      kind: "docx:prepare-runtime",
      blocks: [{ type: "codeBlock", code: "secret" }],
    })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId] })).toBe(true);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId], resumeWaiting: true })).toBe(true);
    expect(isExtRequest({ kind: "jobs:wake", resumeWaiting: true })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId], resumeWaiting: "yes" })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [opaqueJobId] })).toBe(true);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: ["   "] })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: ["x".repeat(4_097)] })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId], bytes: new Uint8Array([1]) })).toBe(false);
    expect(isExtRequest({
      kind: "research:resume",
      runId: "run-1",
      sessionId: "research-session:run-1",
      windowId: 7,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:resume",
      runId: "run-1",
      sessionId: "research-session:run-1",
      windowId: 7,
      request: { mustNotCross: true },
    })).toBe(false);
    expect(isExtRequest({ kind: "research:cancel-session", runId: "run-1" })).toBe(true);
    expect(isExtRequest({
      kind: "research:chat-control",
      windowId: 7,
      command: {
        kind: "enqueue",
        expectedRevision: 1,
        messageId: "chat-message:next",
        content: "Check this next.",
      },
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:chat-control",
      windowId: 7,
      command: {
        kind: "enqueue",
        expectedRevision: 0,
        messageId: "chat-message:next",
        content: "Check this next.",
      },
    })).toBe(false);
    expect(isExtRequest({ kind: "research:pause-session", runId: "run-1" })).toBe(true);
    expect(isExtRequest({
      kind: "research:pause-session",
      runId: "run-1",
      sessionId: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:cancel-session",
      runId: "run-1",
      sessionId: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:list-resumable-sessions",
      windowId: 7,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:list-resumable-sessions",
      windowId: 7,
      sessionId: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:list-retained-sessions",
      windowId: 7,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:prepare-follow-up-turn",
      windowId: 7,
      sessionId: "research-session:terminal",
      revision: 12,
      question: "Check the remaining evidence.",
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:prepare-follow-up-turn",
      windowId: 7,
      sessionId: "research-session:terminal",
      revision: 12,
      question: "   ",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:prepare-follow-up-turn",
      windowId: 7,
      sessionId: "research-session:terminal",
      revision: 12,
      question: "Check the remaining evidence.",
      scope: { jiraProjectKeys: ["must-not-cross"] },
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:steer-session",
      windowId: 7,
      sessionId: "research-session:checkpoint",
      revision: 12,
      instruction: "Prioritize the approved comparison.",
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:steer-session",
      windowId: 7,
      sessionId: "research-session:checkpoint",
      revision: 12,
      instruction: "Prioritize the approved comparison.",
      graphRevision: 7,
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:steer-session",
      windowId: 7,
      sessionId: "research-session:checkpoint",
      revision: 12,
      instruction: "   ",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:delete-session",
      windowId: 7,
      sessionId: "research-session:terminal",
      revision: 12,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:delete-session",
      windowId: 7,
      sessionId: "research-session:terminal",
      revision: 0,
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:delete-session",
      windowId: 7,
      sessionId: "research-session:terminal",
      revision: 12,
      report: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:list-scope-reviews",
      windowId: 7,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:list-scope-plan-reviews",
      windowId: 7,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:approve-scope-plan-review",
      windowId: 7,
      sessionId: "research-session:scope-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:approve-scope-plan-review",
      windowId: 7,
      sessionId: "research-session:scope-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      proposalId: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:prepare-plan-review",
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" },
      policy: { schema: "atlcli.research-one-shot-policy/v1" },
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:list-plan-reviews",
      windowId: 7,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:approve-plan-review",
      windowId: 7,
      sessionId: "research-session:plan-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:approve-plan-review",
      windowId: 7,
      sessionId: "research-session:plan-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      scope: { mustNotCross: true },
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:reject-plan-review",
      windowId: 7,
      sessionId: "research-session:plan-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      instruction: "Separate direct evidence from inferred relationships.",
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:reject-plan-review",
      windowId: 7,
      sessionId: "research-session:plan-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      instruction: "   ",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:reject-plan-review",
      windowId: 7,
      sessionId: "research-session:plan-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      instruction: "Correction",
      scope: { mustNotCross: true },
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:prepare-clarification-review",
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" },
      policy: { schema: "atlcli.research-one-shot-policy/v1" },
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:list-clarification-reviews",
      windowId: 7,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:resolve-clarification-review",
      windowId: 7,
      sessionId: "research-session:clarification-review",
      revision: 12,
      briefRevision: 3,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [{ assumptionId: "assumption:archive", decision: "rejected" }],
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:resolve-clarification-review",
      windowId: 7,
      sessionId: "research-session:clarification-review",
      revision: 12,
      briefRevision: 3,
      answers: [{ questionId: "clarification:window", response: "Use the latest week.", scope: "must-not-cross" }],
      assumptionDecisions: [],
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:continue-clarification-review",
      windowId: 7,
      sessionId: "research-session:clarification-review",
      revision: 13,
      briefRevision: 4,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:resolve-scope-clarification-review",
      windowId: 7,
      sessionId: "research-session:scope-clarification-review",
      revision: 13,
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: "mention:scope-1",
        candidateId: "research-scope-candidate:account-management",
      },
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:resolve-scope-clarification-review",
      windowId: 7,
      sessionId: "research-session:scope-clarification-review",
      revision: 13,
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: "mention:scope-1",
        candidateId: "research-scope-candidate:account-management",
      },
      scope: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:continue-scope-clarification-review",
      windowId: 7,
      sessionId: "research-session:scope-clarification-review",
      revision: 14,
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:approve-scope-review",
      windowId: 7,
      sessionId: "research-session:scope-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      proposalId: "scope-expansion:related-space",
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:approve-scope-review",
      windowId: 7,
      sessionId: "research-session:scope-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      proposalId: "scope-expansion:related-space",
      candidateId: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:reject-scope-review",
      windowId: 7,
      sessionId: "research-session:scope-review",
      revision: 0,
      briefRevision: 3,
      graphRevision: 4,
      proposalId: "scope-expansion:related-space",
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:resolve-scope",
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" },
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:resolve-scope",
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" },
      options: {
        candidateSelections: [{
          schema: "atlcli.research-scope-candidate-selection/v1",
          mentionId: "mention:scope-1",
          candidateId: "research-scope-candidate:confluence-space-account",
        }],
      },
    })).toBe(true);
    expect(isExtRequest({
      kind: "research:resolve-scope",
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" },
      options: { candidateSelections: [{ schema: "wrong" }] },
    })).toBe(false);
    expect(isExtRequest({
      kind: "research:resolve-scope",
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" },
      apiKey: "must-not-cross",
    })).toBe(false);
    expect(isExtRequest({ kind: "pdf:compile", jobId: "bad" })).toBe(false);
    expect(isExtRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(false);
    expect(isExtRequest({ kind: "pong" })).toBe(false);
    expect(isExtRequest({ kind: "entity-changed", detection: { windowId: 7, url: null, entity: null } })).toBe(
      false
    );
    expect(isExtRequest(null)).toBe(false);
    expect(isExtRequest("ping")).toBe(false);
  });

  it("isEntityChanged accepts only the entity-changed push", () => {
    expect(
      isEntityChanged({ kind: "entity-changed", detection: { windowId: 7, url: null, entity: null } })
    ).toBe(true);
    expect(
      isEntityChanged({ kind: "entity-changed", detection: { url: null, entity: null } })
    ).toBe(false);
    expect(
      isEntityChanged({ kind: "entity-changed", detection: { windowId: -1, url: null, entity: null } })
    ).toBe(false);
    expect(isEntityChanged({ kind: "ping" })).toBe(false);
    expect(isEntityChanged({ kind: "current-entity", detection: { windowId: 7, url: null, entity: null } })).toBe(
      false
    );
    expect(isEntityChanged(null)).toBe(false);
  });

  it("matches entity-changed broadcasts only to their owning window", () => {
    const message = {
      kind: "entity-changed",
      detection: { windowId: 7, url: null, entity: null },
    };
    expect(isEntityChangedForWindow(message, 7)).toBe(true);
    expect(isEntityChangedForWindow(message, 8)).toBe(false);
    expect(isEntityChangedForWindow({ kind: "ping" }, 7)).toBe(false);
  });

  it("accepts only bounded export-job change hints", () => {
    expect(isExportJobsChanged({
      kind: "jobs:changed",
      jobId: "123e4567-e89b-42d3-a456-426614174000",
    })).toBe(true);
    expect(isExportJobsChanged({
      kind: "jobs:changed",
      jobId: "badge-preference",
    })).toBe(true);
    expect(isExportJobsChanged({
      kind: "jobs:changed",
      jobId: " ",
    })).toBe(false);
    expect(isExportJobsChanged({
      kind: "jobs:changed",
      jobId: "x".repeat(4_097),
    })).toBe(false);
    expect(isExportJobsChanged({
      kind: "jobs:changed",
      jobId: "job-1",
      unexpected: true,
    })).toBe(false);
    expect(isExportJobsChanged({ kind: "ping" })).toBe(false);
  });

  it("accepts only complete body-free one-shot research events", () => {
    const base = {
      kind: "research:event",
      runId: "run-1",
    };
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "phase",
        seq: 1,
        at: "2026-07-31T12:00:00.000Z",
        phase: "researching",
      },
    }, "run-1")).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "progress",
        seq: 2,
        at: "2026-07-31T12:00:00.000Z",
        graphRevision: 1,
        completed: 3,
        maximum: 8,
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "capability",
        seq: 3,
        at: "2026-07-31T12:00:00.000Z",
        callId: "wiki.search:1",
        toolId: "wiki.search",
        inputKind: "search",
        status: "completed",
        itemCount: 10,
        complete: false,
        termination: "item-limit",
        resultBytes: 2048,
        truncated: false,
        durationMs: 42,
        inputKeys: ["query"],
        queryKeys: ["text"],
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "subagent",
        seq: 4,
        at: "2026-07-31T12:00:00.000Z",
        taskId: "research-task:1",
        roleId: "wiki-retrieval",
        status: "completed",
        durationMs: 84,
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "decision",
        seq: 5,
        at: "2026-07-31T12:00:00.000Z",
        decisionId: "deterministic-evidence-validation",
        status: "started",
        reasonCode: "validate-before-render",
        codeBytes: 400,
        codeHash: "sha256:deadbeef",
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "plan",
        seq: 6,
        at: "2026-07-31T12:00:00.000Z",
        briefRevision: 1,
        revision: 1,
        status: "approved",
        resolvedEffort: "analysis",
        selectedRoleIds: ["focused-researcher", "synthesizer"],
        nodeCount: 3,
        waveCount: 2,
        maxParallelNodes: 3,
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "plan",
        seq: 7,
        at: "2026-07-31T12:00:00.000Z",
        briefRevision: 1,
        revision: 1,
        status: "accepted",
        resolvedEffort: "analysis",
        selectedRoleIds: ["focused-researcher", "synthesizer"],
        nodeCount: 3,
        waveCount: 2,
        maxParallelNodes: 3,
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "task",
        seq: 8,
        at: "2026-07-31T12:00:00.000Z",
        taskId: "research-task:1",
        roleId: "focused-researcher",
        status: "packet-accepted",
        sourceCount: 4,
        findingCount: 2,
        inputTokens: 100,
        outputTokens: 20,
        resultBytes: 2048,
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "reconciliation",
        seq: 8,
        at: "2026-07-31T12:00:00.000Z",
        taskId: "research-task:reconciler",
        status: "completed",
        defectCount: 2,
        proposedFollowUpCount: 1,
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "reconciliation_disposition",
        seq: 9,
        at: "2026-07-31T12:00:00.000Z",
        dispositionId: "reconciliation-disposition:r1:1",
        defectId: "defect:unsupported-finding",
        decision: "abstain",
        reasonCode: "material_defect",
        status: "recorded",
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "repair_group",
        seq: 10,
        at: "2026-07-31T12:00:00.000Z",
        followUpId: "follow-up:coverage",
        taskId: "research-task:r1:reconciliation-repair:a1",
        status: "authorized",
        reasonCode: "accepted_follow_up",
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "budget",
        seq: 11,
        at: "2026-07-31T12:00:00.000Z",
        metric: "tokens",
        consumed: 120,
        maximum: 1000,
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "artifact",
        seq: 12,
        at: "2026-07-31T12:00:00.000Z",
        path: "/artifacts/report.md",
      },
    })).toBe(true);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "phase",
        seq: 1,
        at: "2026-07-31T12:00:00.000Z",
        phase: "researching",
        sourceBody: "must not cross the event bus",
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "task",
        seq: 11,
        at: "2026-07-31T12:00:00.000Z",
        taskId: "research-task:1",
        status: "planned",
        prompt: "must not cross the event bus",
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "capability",
        seq: 12,
        at: "2026-07-31T12:00:00.000Z",
        callId: "wiki.search:1",
        toolId: "wiki.search",
        inputKind: "search",
        status: "completed",
        result: { sourceBody: "must not cross the event bus" },
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "decision",
        seq: 13,
        at: "2026-07-31T12:00:00.000Z",
        decisionId: "central-supervisor-run",
        status: "completed",
        reasonCode: "workflow-returned-for-validation",
        chainOfThought: "must not cross the event bus",
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "progress",
        seq: 2,
        at: "2026-07-31T12:00:00.000Z",
        graphRevision: 1,
        completed: 9,
        maximum: 8,
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "capability",
        seq: 3,
        at: "2026-07-31T12:00:00.000Z",
        callId: "wiki.search:1",
        toolId: "wiki.search",
        inputKind: "search",
        status: "completed",
        sourceBody: "must not cross the event bus",
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "artifact",
        seq: 3,
        at: "invalid",
        path: "/workspace/private.md",
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      event: {
        kind: "phase",
        seq: 1,
        at: "2026-07-31T12:00:00.000Z",
      },
    })).toBe(false);
    expect(isResearchEvent({
      ...base,
      unexpected: true,
      event: {
        kind: "phase",
        seq: 1,
        at: "2026-07-31T12:00:00.000Z",
        phase: "researching",
      },
    })).toBe(false);
  });

  it("isOffscreenRequest accepts offscreen-bound requests only", () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    expect(isOffscreenRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:research-pause", runId: "run-1" })).toBe(true);
    const offscreenChatRun = {
      kind: "offscreen:research-run",
      runId: "run-chat-1",
      sessionId: "research-session:chat-1",
      turnId: "research-turn:chat-1",
      apiKey: "sk-ant-test-message",
      mode: "chat",
      request: {},
    } as const;
    expect(isOffscreenRequest(offscreenChatRun)).toBe(false);
    expect(isOffscreenRequest({
      kind: "offscreen:research-chat-control",
      runId: "run-chat-control",
      controlId: "chat-control:1",
      control: {
        kind: "enqueue",
        expectedRevision: 1,
        messageId: "chat-message:next",
        content: "Check this next.",
        at: "2026-08-06T10:00:00.000Z",
      },
    })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:research-chat-control",
      runId: "run-chat-control",
      controlId: "chat-control:1",
      control: {
        kind: "enqueue",
        expectedRevision: 1,
        messageId: "chat-message:next",
        content: "Check this next.",
      },
    })).toBe(false);
    expect(isOffscreenRequest({
      ...offscreenChatRun,
      hostIdentity: {
        userId: "browser-principal:synthetic",
        providerCacheIdentity: "provider-cache:synthetic",
      },
    })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:research-pause",
      runId: "run-1",
      sessionId: "must-not-cross",
    })).toBe(false);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-compile", jobId })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-cancel", jobId })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:docx-prepare-runtime",
      codeTheme: "github-light",
    })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:docx-prepare-runtime",
      codeTheme: "remote-theme",
    })).toBe(false);
    expect(isOffscreenRequest({ kind: "offscreen:jobs-wake", jobIds: [jobId] })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:jobs-wake",
      jobIds: [jobId],
      resumeWaiting: true,
    })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:jobs-wake",
      resumeWaiting: true,
    })).toBe(false);
    expect(isOffscreenRequest({
      kind: "offscreen:research-run",
      runId: "run-1",
      sessionId: "research-session:run-1",
      turnId: "research-turn:run-1",
      apiKey: "sk-ant-test-message",
      mode: "research",
      request: {},
    })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:research-run",
      runId: "run-1",
      request: {},
    })).toBe(false);
    expect(isOffscreenRequest({
      kind: "offscreen:research-resume",
      runId: "run-1",
      sessionId: "research-session:run-1",
      turnId: "research-turn:run-1",
      apiKey: "sk-ant-test-message",
    })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:research-resume",
      runId: "run-1",
      sessionId: "research-session:run-1",
      turnId: "research-turn:run-1",
      apiKey: "sk-ant-test-message",
      policy: { mustNotCross: true },
    })).toBe(false);
    expect(isOffscreenRequest({
      kind: "offscreen:research-run",
      runId: "run-1",
      apiKey: "sk-ant-test message",
      request: {},
    })).toBe(false);
    expect(isOffscreenRequest({ kind: "offscreen:jobs-wake", jobIds: ["job-1"] })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:jobs-wake", bytes: new Uint8Array([1]) })).toBe(false);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-compile", jobId: "bad" })).toBe(false);
    expect(isOffscreenRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(false);
    expect(isOffscreenRequest(undefined)).toBe(false);
  });
});
