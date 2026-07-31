import { ResearchContractError } from "./contracts.js";
import {
  RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
  RESEARCH_TASK_ATTEMPT_SCHEMA_V1,
  parseResearchTaskBodyV1,
  validateResearchTaskAdmissionV1,
  type ResearchAcceptedPacketV1,
  type ReconciliationBodyV1,
  type ResearchPacketBodyV1,
  type ResearchTaskAttemptV1,
  type ResearchTaskUsageV1,
} from "./workflow-contracts.js";

export type ResearchTaskAttemptEventV1 =
  | { kind: "dispatch_started"; at: string; providerRequestId?: string }
  | { kind: "outcome_unknown"; at: string }
  | { kind: "failed"; at: string }
  | { kind: "cancelled"; at: string }
  | { kind: "quarantined"; at: string }
  | {
      kind: "result_committed";
      at: string;
      packetRef: string;
      usage: ResearchTaskUsageV1;
    };

function invalid(message: string): never {
  throw new ResearchContractError("invalid-report", message);
}

export function reduceResearchTaskAttemptV1(
  current: ResearchTaskAttemptV1,
  event: ResearchTaskAttemptEventV1,
): ResearchTaskAttemptV1 {
  if (current.schema !== RESEARCH_TASK_ATTEMPT_SCHEMA_V1) invalid("Unsupported research task attempt schema.");
  if (event.kind === "dispatch_started") {
    if (current.status !== "ready" || current.dispatchState !== "not_started") invalid("Research task can be dispatched only once from ready state.");
    return {
      ...current,
      status: "running",
      dispatchState: "dispatch_started",
      startedAt: event.at,
      ...(event.providerRequestId ? { providerRequestId: event.providerRequestId } : {}),
    };
  }
  if (event.kind === "outcome_unknown") {
    if (current.status !== "running" || current.dispatchState !== "dispatch_started") invalid("Only a running task can have an unknown outcome.");
    return { ...current, status: "outcome_unknown", dispatchState: "outcome_unknown", finishedAt: event.at };
  }
  if (event.kind === "result_committed") {
    if (current.status !== "running" || current.dispatchState !== "dispatch_started") invalid("Only a running task can commit a result.");
    return {
      ...current,
      status: "complete",
      dispatchState: "result_committed",
      acceptedPacketRef: event.packetRef,
      hostObservedUsage: event.usage,
      finishedAt: event.at,
    };
  }
  if (current.status !== "running" && current.status !== "outcome_unknown") invalid("Only an active task can enter a terminal failure state.");
  return {
    ...current,
    status: event.kind,
    finishedAt: event.at,
  };
}

export interface ResearchSubagentDispatchPort {
  admit(attempt: ResearchTaskAttemptV1): void;
  start(taskId: string, graphRevision: number, at: string): ResearchTaskAttemptV1;
  accept(input: {
    taskId: string;
    graphRevision: number;
    body: unknown;
    usage: ResearchTaskUsageV1;
    acceptedAt: string;
    availableSourceIds: readonly string[];
  }): ResearchAcceptedPacketV1;
  fail(taskId: string, graphRevision: number, at: string): ResearchTaskAttemptV1;
  quarantine(taskId: string, graphRevision: number, at: string): ResearchTaskAttemptV1;
  attempt(taskId: string): ResearchTaskAttemptV1 | undefined;
  packet(packetRef: string): ResearchAcceptedPacketV1 | undefined;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryResearchSubagentDispatchPort implements ResearchSubagentDispatchPort {
  readonly #attempts = new Map<string, ResearchTaskAttemptV1>();
  readonly #packets = new Map<string, ResearchAcceptedPacketV1>();
  readonly #acceptedNodeIds = new Set<string>();
  readonly #maxResultBytes: number;

  constructor(options: { maxResultBytes: number }) {
    if (!Number.isSafeInteger(options.maxResultBytes) || options.maxResultBytes < 1) invalid("Research task result byte limit is invalid.");
    this.#maxResultBytes = options.maxResultBytes;
  }

  admit(attempt: ResearchTaskAttemptV1): void {
    if (attempt.schema !== RESEARCH_TASK_ATTEMPT_SCHEMA_V1 || attempt.status !== "ready" || attempt.dispatchState !== "not_started") invalid("Research task admission must be a fresh ready attempt.");
    if (!Number.isSafeInteger(attempt.graphRevision) || attempt.graphRevision < 1 || !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) invalid("Research task admission revision or attempt is invalid.");
    if (this.#attempts.has(attempt.taskId)) invalid("Research task ID is already admitted.");
    validateResearchTaskAdmissionV1(attempt);
    this.#attempts.set(attempt.taskId, clone(attempt));
  }

  #current(taskId: string, graphRevision: number): ResearchTaskAttemptV1 {
    const attempt = this.#attempts.get(taskId) ?? invalid("Research task is not admitted.");
    if (attempt.graphRevision !== graphRevision) invalid("Research task graph revision is stale.");
    return attempt;
  }

  start(taskId: string, graphRevision: number, at: string): ResearchTaskAttemptV1 {
    const next = reduceResearchTaskAttemptV1(this.#current(taskId, graphRevision), { kind: "dispatch_started", at });
    this.#attempts.set(taskId, next);
    return clone(next);
  }

  accept(input: {
    taskId: string;
    graphRevision: number;
    body: unknown;
    usage: ResearchTaskUsageV1;
    acceptedAt: string;
    availableSourceIds: readonly string[];
  }): ResearchAcceptedPacketV1 {
    const current = this.#current(input.taskId, input.graphRevision);
    if (current.status !== "running" || current.dispatchState !== "dispatch_started") invalid("Research task result arrived outside its active dispatch.");
    if (this.#acceptedNodeIds.has(current.nodeId)) invalid("A research graph node already accepted a packet.");
    const bytes = encodedBytes(input.body);
    if (bytes > this.#maxResultBytes || bytes > input.usage.resultBytes) invalid("Research task result exceeds its host-observed byte envelope.");
    const body = parseResearchTaskBodyV1(current.expectedOutputSchema, input.body);
    const available = new Set(input.availableSourceIds);
    const sourceIds = current.expectedOutputSchema === "atlcli.research-packet-body/v1"
      ? (body as ResearchPacketBodyV1).sourceIds
      : current.expectedOutputSchema === "atlcli.reconciliation-body/v1"
        ? (body as ReconciliationBodyV1).defects.flatMap((defect) => defect.references.filter((reference) => reference.kind === "source").map((reference) => reference.id))
        : [
            ...(body as { findings: Array<{ sourceIds: string[] }> }).findings.flatMap((finding) => finding.sourceIds),
            ...(body as { relationships: Array<{ sourceIds: string[] }> }).relationships.flatMap((relationship) => relationship.sourceIds),
          ];
    for (const sourceId of sourceIds) if (!available.has(sourceId)) invalid("Research task result references unknown evidence.");
    const packetRef = `packet:${current.taskId}:${current.attempt}`;
    if (this.#packets.has(packetRef)) invalid("Research packet reference already exists.");
    const packet: ResearchAcceptedPacketV1 = {
      schema: RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
      packetRef,
      taskId: current.taskId,
      graphRevision: current.graphRevision,
      attempt: current.attempt,
      executor: current.executor,
      ...(current.roleId ? { roleId: current.roleId } : {}),
      grantedCapabilityIds: [...current.grantedCapabilityIds],
      typedIntentRefs: [...current.typedIntentRefs],
      expectedOutputSchema: current.expectedOutputSchema,
      body,
      hostObservedUsage: clone(input.usage),
      acceptedAt: input.acceptedAt,
    };
    const next = reduceResearchTaskAttemptV1(current, {
      kind: "result_committed",
      at: input.acceptedAt,
      packetRef,
      usage: input.usage,
    });
    this.#packets.set(packetRef, clone(packet));
    this.#attempts.set(current.taskId, next);
    this.#acceptedNodeIds.add(current.nodeId);
    return clone(packet);
  }

  fail(taskId: string, graphRevision: number, at: string): ResearchTaskAttemptV1 {
    const next = reduceResearchTaskAttemptV1(this.#current(taskId, graphRevision), { kind: "failed", at });
    this.#attempts.set(taskId, next);
    return clone(next);
  }

  quarantine(taskId: string, graphRevision: number, at: string): ResearchTaskAttemptV1 {
    const next = reduceResearchTaskAttemptV1(this.#current(taskId, graphRevision), { kind: "quarantined", at });
    this.#attempts.set(taskId, next);
    return clone(next);
  }

  attempt(taskId: string): ResearchTaskAttemptV1 | undefined {
    const value = this.#attempts.get(taskId);
    return value ? clone(value) : undefined;
  }

  packet(packetRef: string): ResearchAcceptedPacketV1 | undefined {
    const value = this.#packets.get(packetRef);
    return value ? clone(value) : undefined;
  }
}
