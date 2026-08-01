import { ResearchContractError } from "./contracts.js";
import type { ResearchGraphProposalV1, ResearchGraphV1 } from "./graph.js";
import type { ResearchSessionStoreV1 } from "./session-store.js";
import type {
  ResearchSessionTurnV1,
  ResearchSessionUpdateV1,
  ResearchSessionV1,
} from "./session.js";
import type {
  ResearchAcceptedPacketV1,
  ResearchReconciliationDispositionV1,
  ResearchTaskAttemptV1,
  ResearchTaskUsageV1,
} from "./workflow-contracts.js";

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function activeTurn(session: ResearchSessionV1, turnId: string): ResearchSessionTurnV1 {
  if (session.activeTurnId !== turnId) {
    invalid("Research durable dispatch does not own the active session turn.");
  }
  const turn = session.turns.find((candidate) => candidate.id === turnId);
  if (!turn?.graph) invalid("Research durable dispatch has no active graph.");
  return turn;
}

function graphFor(turn: ResearchSessionTurnV1, graphRevision: number): ResearchGraphV1 {
  if (turn.graph?.revision !== graphRevision) {
    invalid("Research durable dispatch graph revision is stale.");
  }
  return turn.graph;
}

function matchingAdmission(
  stored: ResearchTaskAttemptV1,
  requested: ResearchTaskAttemptV1,
): boolean {
  return stored.taskId === requested.taskId &&
    stored.nodeId === requested.nodeId &&
    stored.graphRevision === requested.graphRevision &&
    stored.attempt === requested.attempt &&
    stored.executor === requested.executor &&
    stored.roleId === requested.roleId &&
    stored.expectedOutputSchema === requested.expectedOutputSchema &&
    JSON.stringify(stored.grantedCapabilityIds) === JSON.stringify(requested.grantedCapabilityIds) &&
    JSON.stringify(stored.typedIntentRefs) === JSON.stringify(requested.typedIntentRefs) &&
    JSON.stringify(stored.budget) === JSON.stringify(requested.budget);
}

type ResearchSessionUnfencedUpdateV1 = ResearchSessionUpdateV1 extends infer Update
  ? Update extends ResearchSessionUpdateV1
    ? Omit<Update, "expectedRevision" | "expectedLeaseEpoch" | "at">
    : never
  : never;

export interface ResearchSessionDispatchJournalV1Options {
  store: ResearchSessionStoreV1;
  sessionId: string;
  turnId: string;
  now?: () => string;
}

/**
 * Host-neutral serial journal for the one durable aggregate that owns a
 * selected graph's task lifecycle. It serializes local concurrent workers so
 * independent `task()` calls retain the session revision/lease CAS fence.
 * Cross-process ownership remains guarded by the store's CAS and must recover
 * the lease before creating a second journal instance.
 */
export class ResearchSessionDispatchJournalV1 {
  readonly #store: ResearchSessionStoreV1;
  readonly #sessionId: string;
  readonly #turnId: string;
  readonly #now: () => string;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ResearchSessionDispatchJournalV1Options) {
    if (!/^research-session:[A-Za-z0-9._-]{1,120}$/.test(options.sessionId) ||
        !/^research-turn:[A-Za-z0-9._-]{1,120}$/.test(options.turnId)) {
      invalid("Research durable dispatch identity is invalid.");
    }
    this.#store = options.store;
    this.#sessionId = options.sessionId;
    this.#turnId = options.turnId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #read(): Promise<ResearchSessionV1> {
    const session = await this.#store.read(this.#sessionId);
    if (!session) invalid("Research durable dispatch session is not found.");
    activeTurn(session, this.#turnId);
    return session;
  }

  async #commit<T>(
    session: ResearchSessionV1,
    update: ResearchSessionUnfencedUpdateV1,
    project: (next: ResearchSessionV1) => T,
  ): Promise<T> {
    const committed = await this.#store.commit(this.#sessionId, {
      ...update,
      expectedRevision: session.revision,
      expectedLeaseEpoch: session.lease.epoch,
      at: this.#now(),
    } as ResearchSessionUpdateV1);
    return project(committed.session);
  }

  /** Commit the selected executable subset before the first task admission. */
  commitGraphSelection(proposal: ResearchGraphProposalV1): Promise<ResearchGraphV1> {
    return this.#enqueue(async () => {
      const session = await this.#read();
      return this.#commit(session, { kind: "commit_graph_selection", proposal }, (next) =>
        activeTurn(next, this.#turnId).graph!,
      );
    });
  }

  /** Persist an exact ready attempt and its dispatch start before provider work. */
  admitAndStart(input: ResearchTaskAttemptV1 & { providerRequestId?: string }): Promise<ResearchTaskAttemptV1> {
    return this.#enqueue(async () => {
      let session = await this.#read();
      let turn = activeTurn(session, this.#turnId);
      graphFor(turn, input.graphRevision);
      const existing = turn.tasks.find((candidate) => candidate.taskId === input.taskId);
      if (existing && !matchingAdmission(existing, input)) {
        invalid("Research durable dispatch task admission does not match the stored attempt.");
      }
      if (!existing) {
        await this.#commit(session, {
          kind: "admit_tasks",
          graphRevision: input.graphRevision,
          tasks: [input],
        }, () => undefined);
        session = await this.#read();
        turn = activeTurn(session, this.#turnId);
      }
      const admitted = turn.tasks.find((candidate) => candidate.taskId === input.taskId);
      if (!admitted) invalid("Research durable dispatch did not retain its admitted task.");
      if (admitted.status !== "ready" || admitted.dispatchState !== "not_started") {
        invalid("Research durable dispatch task is already active or terminal.");
      }
      return this.#commit(session, {
        kind: "dispatch_started",
        taskId: input.taskId,
        graphRevision: input.graphRevision,
        ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      }, (next) => {
        const task = activeTurn(next, this.#turnId).tasks.find((candidate) =>
          candidate.taskId === input.taskId,
        );
        if (!task) invalid("Research durable dispatch lost its started task.");
        return task;
      });
    });
  }

  acceptPacket(input: {
    taskId: string;
    graphRevision: number;
    body: unknown;
    usage: ResearchTaskUsageV1;
    availableSourceIds: string[];
    maximumResultBytes: number;
  }): Promise<ResearchAcceptedPacketV1> {
    return this.#enqueue(async () => {
      const session = await this.#read();
      const turn = activeTurn(session, this.#turnId);
      graphFor(turn, input.graphRevision);
      return this.#commit(session, {
        kind: "accept_packet",
        taskId: input.taskId,
        graphRevision: input.graphRevision,
        body: input.body,
        usage: input.usage,
        availableSourceIds: [...input.availableSourceIds],
        maximumResultBytes: input.maximumResultBytes,
      }, (next) => {
        const packet = activeTurn(next, this.#turnId).acceptedPackets.find((candidate) =>
          candidate.taskId === input.taskId,
        );
        if (!packet) invalid("Research durable dispatch did not retain its accepted packet.");
        return packet;
      });
    });
  }

  markOutcomeUnknown(taskId: string, graphRevision: number): Promise<ResearchTaskAttemptV1> {
    return this.#transitionTask("outcome_unknown", taskId, graphRevision);
  }

  quarantine(taskId: string, graphRevision: number, reason: string): Promise<ResearchTaskAttemptV1> {
    return this.#enqueue(async () => {
      const session = await this.#read();
      const turn = activeTurn(session, this.#turnId);
      graphFor(turn, graphRevision);
      return this.#commit(session, {
        kind: "quarantine_packet",
        taskId,
        graphRevision,
        reason,
      }, (next) => {
        const task = activeTurn(next, this.#turnId).tasks.find((candidate) => candidate.taskId === taskId);
        if (!task) invalid("Research durable dispatch lost its quarantined task.");
        return task;
      });
    });
  }

  recordReconciliation(
    dispositions: readonly ResearchReconciliationDispositionV1[],
  ): Promise<ResearchReconciliationDispositionV1[]> {
    return this.#enqueue(async () => {
      let session = await this.#read();
      const recorded: ResearchReconciliationDispositionV1[] = [];
      for (const disposition of dispositions) {
        const next = await this.#commit(session, {
          kind: "record_reconciliation",
          disposition,
        }, (value) => value);
        const stored = activeTurn(next, this.#turnId).reconciliationDispositions.find((candidate) =>
          candidate.id === disposition.id,
        );
        if (!stored) invalid("Research durable dispatch did not retain its reconciliation disposition.");
        recorded.push(stored);
        session = next;
      }
      return recorded;
    });
  }

  #transitionTask(
    kind: "outcome_unknown",
    taskId: string,
    graphRevision: number,
  ): Promise<ResearchTaskAttemptV1> {
    return this.#enqueue(async () => {
      const session = await this.#read();
      const turn = activeTurn(session, this.#turnId);
      graphFor(turn, graphRevision);
      return this.#commit(session, { kind, taskId, graphRevision }, (next) => {
        const task = activeTurn(next, this.#turnId).tasks.find((candidate) => candidate.taskId === taskId);
        if (!task) invalid("Research durable dispatch lost its task transition.");
        return task;
      });
    });
  }
}
