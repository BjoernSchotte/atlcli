import { DEFAULT_RESEARCH_LIMITS_V1 } from "../contracts.js";
import type { ResearchWorkspace } from "../workspace.js";
import {
  CHAT_CANDIDATE_LEDGER_PATH_V1,
  CHAT_RETRIEVAL_ASSESSMENT_PATH_V1,
  CHAT_RETRIEVAL_PLAN_PATH_V1,
  ChatCandidateLedgerControllerV1,
  createChatRetrievalPlanV1,
} from "./retrieval-plan.js";

export interface ChatRetrievalTraceConformanceV1 {
  plan: string;
  candidateLedger: string;
  assessment: string;
}

/**
 * Exercise the exact shared Chat retrieval trace against a host workspace.
 * CLI/SQLite and browser/IndexedDB tests compare these byte-for-byte so host
 * adapters cannot silently fork the plan, ledger, or assessment contract.
 */
export async function verifyChatRetrievalTraceConformanceV1(
  workspace: ResearchWorkspace,
): Promise<ChatRetrievalTraceConformanceV1> {
  const now = () => Date.parse("2026-08-06T12:00:00.000Z");
  const plan = createChatRetrievalPlanV1({
    conversationId: "conversation:host-parity",
    turnId: "turn:host-parity",
    question: "Summarize the attached synthetic page.",
    anchors: [{
      anchorRef: "research-anchor:host-parity",
      product: "confluence",
      entityKind: "page",
      name: "Synthetic page",
    }],
    scopeBindings: [{
      schema: "atlcli.research-scope-binding/v1",
      id: "scope-binding:host-parity:page",
      tenantOrigin: "https://synthetic.atlassian.net",
      product: "confluence",
      entityKind: "page",
      entityRef: "research-scope-entity:host-parity-page",
      key: "1001",
      name: "Synthetic page",
      source: "current_context",
      authority: "approved",
    }],
    boundProjectKeys: [],
    boundSpaceKeys: ["KB"],
    searchProducts: [],
    exactContextProducts: ["confluence"],
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxRunMs: 60_000,
      maxSearchPagesPerProduct: 1,
      maxItemsPerProduct: 4,
      maxDetailItemsPerProduct: 2,
      maxTotalResponseBytes: 512_000,
      maxPtcCalls: 8,
      maxPtcOutputBytes: 128_000,
      maxReportChars: 24_000,
      maxConcurrentCalls: 2,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 32 * 1024 * 1024,
    },
    agentic: false,
    now,
  });
  const ledger = new ChatCandidateLedgerControllerV1({
    plan,
    workspace,
    siteOrigin: "https://synthetic.atlassian.net",
    now,
  });
  await ledger.initialize();
  await ledger.observe("atlassian.bound.read", {
    schema: "atlcli.ptc/atlassian.bound.read.output/v1",
    source: {
      sourceId: "wiki:1001",
      product: "confluence",
      title: "Synthetic page",
      url: "https://synthetic.atlassian.net/wiki/spaces/KB/pages/1001",
    },
    content: {
      text: "A deterministic host-parity fact.",
      linkTargets: [],
      truncated: false,
      inputBytes: 33,
    },
    relatedAnchors: [],
    budget: {
      ptcRemaining: 7,
      httpAttemptsRemaining: 7,
      responseBytesRemaining: 127_000,
    },
  }, "bound:host-parity");
  await ledger.finalize();
  const [persistedPlan, candidateLedger, assessment] = await Promise.all([
    workspace.readFile(CHAT_RETRIEVAL_PLAN_PATH_V1),
    workspace.readFile(CHAT_CANDIDATE_LEDGER_PATH_V1),
    workspace.readFile(CHAT_RETRIEVAL_ASSESSMENT_PATH_V1),
  ]);
  if (!persistedPlan || !candidateLedger || !assessment) {
    throw new Error("Chat retrieval trace conformance did not persist all required artifacts.");
  }
  return { plan: persistedPlan, candidateLedger, assessment };
}
