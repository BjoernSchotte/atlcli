import {
  createResearchSessionV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import type {
  ResearchSessionStoreFailureInjectionV1,
  ResearchSessionStoreV1,
} from "./session-store.js";

export interface ResearchSessionStoreConformanceFactoryV1 {
  create(options?: { failureInjection?: ResearchSessionStoreFailureInjectionV1 }): ResearchSessionStoreV1;
}

export interface ResearchSessionStoreConformanceResultV1 {
  aggregateCommit: "passed";
  staleCas: "passed";
  failureAtomicity: "passed";
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Research session store conformance failed: ${message}`);
}

function session(id: string): ResearchSessionV1 {
  return createResearchSessionV1({
    sessionId: id,
    ownerId: "owner:conformance",
    createdAt: "2026-08-01T11:00:00.000Z",
    leaseExpiresAt: "2026-08-01T11:10:00.000Z",
  });
}

function createTurnUpdate(current: ResearchSessionV1, at: string): ResearchSessionUpdateV1 {
  return {
    kind: "create_turn",
    turnId: "research-turn:conformance",
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at,
  };
}

/**
 * Run the portable T4 contract checks. Physical adapters call this exact
 * function with their test-only failure injector instead of duplicating an
 * approximation of the CAS/journal boundary in every host test suite.
 */
export async function verifyResearchSessionStoreConformanceV1(
  factory: ResearchSessionStoreConformanceFactoryV1,
  prefix = "research-session:conformance",
): Promise<ResearchSessionStoreConformanceResultV1> {
  const store = factory.create();
  const initial = await store.create(session(`${prefix}-commit`));
  const committed = await store.commit(initial.sessionId, createTurnUpdate(initial, "2026-08-01T11:00:01.000Z"));
  assert(committed.session.revision === 2 && committed.session.status === "planning", "committed snapshot is missing");
  const events = await store.events(initial.sessionId);
  assert(events.length === 1 && events[0]?.sessionRevision === 2 && events[0]?.kind === "create_turn", "journal event does not match committed state");

  let staleRejected = false;
  try {
    await store.commit(initial.sessionId, createTurnUpdate(initial, "2026-08-01T11:00:02.000Z"));
  } catch {
    staleRejected = true;
  }
  assert(staleRejected, "stale compare-and-swap write was accepted");
  const afterStale = await store.read(initial.sessionId);
  assert(afterStale?.revision === 2 && (await store.events(initial.sessionId)).length === 1, "stale write mutated session or journal");

  const failing = factory.create({
    failureInjection: {
      onStage(stage) {
        if (stage === "before_event_append") throw new Error("conformance injected journal failure");
      },
    },
  });
  const failureInitial = await failing.create(session(`${prefix}-failure`));
  let failureRaised = false;
  try {
    await failing.commit(failureInitial.sessionId, createTurnUpdate(failureInitial, "2026-08-01T11:00:01.000Z"));
  } catch {
    failureRaised = true;
  }
  assert(failureRaised, "failure injector was not observed");
  const afterFailure = await failing.read(failureInitial.sessionId);
  assert(afterFailure?.revision === 1 && (await failing.events(failureInitial.sessionId)).length === 0, "failed aggregate commit leaked partial state");
  return { aggregateCommit: "passed", staleCas: "passed", failureAtomicity: "passed" };
}
