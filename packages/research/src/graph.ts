import {
  DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  type ResearchLimitsV1,
  type ResearchOneShotPolicyV1,
  type ResearchScopeBindingV1,
  type ResearchScopeV1,
} from "./contracts.js";
import {
  DEFAULT_RESEARCH_SCOPE_DISCOVERY_POLICY_V1,
  RESEARCH_BRIEF_SCHEMA_V1,
  briefRequiresClarificationV1,
  createResearchBriefV1,
  type ResearchBriefV1,
  type ResearchRequestedReconciliationV1,
  type ResearchResolvedEffortV1,
} from "./brief.js";
import {
  RESEARCH_APPROVAL_ENVELOPE_SCHEMA_V1,
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2,
  RESEARCH_SUBAGENT_ROLE_IDS_V1,
  RESEARCH_SUBAGENT_ROLE_REGISTRY_V1,
  type ResearchApprovalEnvelopeV1,
  type ResearchGraphReconciliationPolicyV1,
  type ResearchNodeBudgetV1,
  type ResearchSubagentRoleIdV1,
  type ResearchTaskOutputSchemaV1,
} from "./workflow-contracts.js";

export { RESEARCH_BRIEF_SCHEMA_V1 } from "./brief.js";
export type { ResearchBriefV1 } from "./brief.js";

export const RESEARCH_GRAPH_SCHEMA_V1 = "atlcli.research-graph/v1" as const;
export const RESEARCH_GRAPH_PROPOSAL_SCHEMA_V1 =
  "atlcli.research-graph-proposal/v1" as const;
export const RESEARCH_PLAN_APPROVAL_REQUIRED_SCHEMA_V1 =
  "atlcli.research-plan-approval-required/v1" as const;

/** Typed T3 stop returned before credentials, storage, providers, or models. */
export interface ResearchPlanApprovalRequiredV1 {
  schema: typeof RESEARCH_PLAN_APPROVAL_REQUIRED_SCHEMA_V1;
  kind: "plan_approval_required";
  briefRevision: number;
  graphRevision: number;
  resolvedEffort: ResearchResolvedEffortV1;
  resolvedPlanApproval: "required";
  selectedRoleIds: ResearchSubagentRoleIdV1[];
  scopeExpansionMode: ResearchOneShotPolicyV1["scopeExpansionMode"];
  reconciliationMode: ResearchRequestedReconciliationV1;
  rerunGuidance: string[];
}

export const RESEARCH_GRAPH_CAPABILITIES = [
  "jira.issue.search",
  "jira.issue.get",
  "wiki.search",
  "wiki.page.get",
  "research.candidate.rank",
  "jira.project.search",
  "wiki.space.search",
  "atlassian.reference.resolve",
] as const;
export type ResearchGraphCapabilityV1 =
  (typeof RESEARCH_GRAPH_CAPABILITIES)[number];

export const RESEARCH_GRAPH_ROLES = RESEARCH_SUBAGENT_ROLE_IDS_V1;
export const RESEARCH_T3_GRAPH_ROLES = RESEARCH_SUBAGENT_ROLE_IDS_V1.filter(
  (roleId) => RESEARCH_SUBAGENT_ROLE_REGISTRY_V1[roleId].availableFromPhase === "T3",
);
export const RESEARCH_T5_GRAPH_ROLES = RESEARCH_SUBAGENT_ROLE_IDS_V1.filter(
  (roleId) => RESEARCH_SUBAGENT_ROLE_REGISTRY_V1[roleId].availableFromPhase === "T3" ||
    roleId === "outline-planner",
);
export type ResearchGraphRoleV1 = ResearchSubagentRoleIdV1;
/** @deprecated Use ResearchResolvedEffortV1 from the brief contract. */
export type ResearchEffortV1 = ResearchResolvedEffortV1;
/** @deprecated Use ResearchRequestedReconciliationV1 from the brief contract. */
export type ResearchReconciliationModeV1 = ResearchRequestedReconciliationV1;

export type ResearchNodeStatusV1 =
  | "proposed"
  | "ready"
  | "running"
  | "complete"
  | "failed"
  | "blocked"
  | "pruned"
  | "quarantined";

export const RESEARCH_COMPOSITION_REASONS_V1 = [
  "simple_lookup",
  "independent_branch",
  "cross_product_join",
  "scope_resolution",
  "related_scope_discovery",
  "exact_reference_follow",
  "large_document_set",
  "hierarchy_traversal",
  "coverage_gap",
  "contradiction",
  "negative_claim",
  "high_impact_claim",
  "user_requested",
  "budget_pruned",
  "not_applicable",
] as const;
export type ResearchCompositionReasonV1 =
  (typeof RESEARCH_COMPOSITION_REASONS_V1)[number];

/** Body-free supervisor proposal. Objectives, grants, and budgets remain host-owned. */
export interface ResearchGraphProposalNodeV1 {
  nodeId: string;
  dependencies: string[];
  reasonCodes: ResearchCompositionReasonV1[];
}

export interface ResearchGraphProposalV1 {
  schema: typeof RESEARCH_GRAPH_PROPOSAL_SCHEMA_V1;
  basedOnBriefRevision: number;
  basedOnGraphRevision: number;
  nodes: ResearchGraphProposalNodeV1[];
}

export const RESEARCH_GRAPH_REVISION_PROPOSAL_SCHEMA_V1 =
  "atlcli.research-graph-revision-proposal/v1" as const;

/**
 * A later supervisor selection may only draw from the original approved
 * catalog. It can add unselected catalog nodes, reprioritize undispatched
 * nodes, and close undispatched optional work. It never grants a capability,
 * alters a completed task, or constructs a free-form node.
 */
export interface ResearchGraphRevisionProposalNodeV1 extends ResearchGraphProposalNodeV1 {
  priority: number;
}

export interface ResearchGraphRevisionPruneV1 {
  nodeId: string;
  reasonCode: ResearchCompositionReasonV1;
}

export interface ResearchGraphRevisionProposalV1 {
  schema: typeof RESEARCH_GRAPH_REVISION_PROPOSAL_SCHEMA_V1;
  basedOnBriefRevision: number;
  basedOnGraphRevision: number;
  nodes: ResearchGraphRevisionProposalNodeV1[];
  prune: ResearchGraphRevisionPruneV1[];
}

export interface ResearchNodeCompletionPolicyV1 {
  requiredCoverageTargetIds: string[];
  allowAbstention: boolean;
  stopOnFirstSupportedAnswer: boolean;
}

export interface ResearchGraphNodeV1 {
  id: string;
  kind: "resolve_scope" | "search" | "expand" | "distill" | "verify" | "moderate" | "outline" | "reconcile" | "repair";
  executor: "ptc" | "subagent";
  roleId?: ResearchSubagentRoleIdV1;
  /** Host-selected schema; the supervisor may not change this per dispatch. */
  outputSchema: ResearchTaskOutputSchemaV1;
  objective: string;
  requestedCapabilityIds: ResearchGraphCapabilityV1[];
  grantedCapabilityIds: ResearchGraphCapabilityV1[];
  typedIntentRefs: string[];
  dependencies: string[];
  parentNodeId?: string;
  createdFromEvidenceIds: string[];
  reasonCodes: ResearchCompositionReasonV1[];
  status: ResearchNodeStatusV1;
  depth: 0 | 1;
  priority: number;
  attempt: number;
  /**
   * Graph revision that admitted the currently observed task attempt. It is
   * host-assigned when a ready node starts and stays fixed across later graph
   * revisions so completed dependency task IDs remain stable.
   */
  taskGraphRevision?: number;
  maxAttempts: number;
  budget: ResearchNodeBudgetV1;
  completion: ResearchNodeCompletionPolicyV1;
  packetRef?: string;
  stopReason?: string;
}

export interface ResearchGraphRoleDecisionV1 {
  roleId: ResearchSubagentRoleIdV1;
  decision: "selected" | "omitted";
  reasonCodes: ResearchCompositionReasonV1[];
}

export interface ResearchGraphV1 {
  schema: typeof RESEARCH_GRAPH_SCHEMA_V1;
  sessionId: string;
  turnId: string;
  revision: number;
  basedOnBriefRevision: number;
  status: "proposed" | "approved" | "running" | "revising" | "complete";
  resolvedEffort: ResearchResolvedEffortV1;
  nodes: ResearchGraphNodeV1[];
  roleDecisions: ResearchGraphRoleDecisionV1[];
  maxParallelNodes: number;
  maxResearchWaves: number;
  maxReconciliationWaves: number;
  researchWavesCompleted: number;
  reconciliationWavesCompleted: number;
  reconciliationPolicy: ResearchGraphReconciliationPolicyV1;
  totalBudget: ResearchNodeBudgetV1;
  approvalEnvelope: ResearchApprovalEnvelopeV1;
  createdAt: string;
  approvedAt?: string;
}

export interface ResearchGraphCompositionOptionsV1 {
  graphRevision?: number;
  grants?: Partial<Record<string, readonly ResearchGraphCapabilityV1[]>>;
  createdAt?: string;
  /** New durable turns may choose V2; legacy/T3 graphs retain V1 by default. */
  packetOutputSchema?: typeof RESEARCH_PACKET_BODY_SCHEMA_V1 | typeof RESEARCH_PACKET_BODY_SCHEMA_V2;
}

const DEFAULT_NODE_BUDGET: ResearchNodeBudgetV1 = {
  maxCapabilityCalls: 8,
  maxInputTokens: 20_000,
  maxOutputTokens: 3_000,
  maxResultBytes: 64_000,
  maxDurationMs: 180_000,
  maxCostMicros: 2_000_000,
};

const PTC_CAPABILITIES = new Set<ResearchGraphCapabilityV1>(RESEARCH_GRAPH_CAPABILITIES);

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function normalizedObjective(objective: string): string {
  if (typeof objective !== "string" || objective.trim() === "") invalid("Research brief objective is required.");
  if (objective.length > 4_000) invalid("Research brief objective is too long.");
  return objective.toLocaleLowerCase("en-US");
}

function hasAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function fingerprint(value: unknown): string {
  const canonicalJson = (candidate: unknown): string => {
    if (Array.isArray(candidate)) return `[${candidate.map(canonicalJson).join(",")}]`;
    if (candidate && typeof candidate === "object") {
      return `{${Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
        .join(",")}}`;
    }
    const serialized = JSON.stringify(candidate);
    return serialized === undefined ? "null" : serialized;
  };
  const canonical = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function nodeBudget(
  brief: ResearchBriefV1,
  roleId?: ResearchSubagentRoleIdV1,
): ResearchNodeBudgetV1 {
  const roleBudget = roleId
    ? RESEARCH_SUBAGENT_ROLE_REGISTRY_V1[roleId].maxBudget
    : DEFAULT_NODE_BUDGET;
  return {
    maxCapabilityCalls: Math.min(roleBudget.maxCapabilityCalls, brief.limits.maxPtcCalls),
    maxInputTokens: Math.min(roleBudget.maxInputTokens, brief.limits.maxModelInputTokens),
    maxOutputTokens: Math.min(roleBudget.maxOutputTokens, brief.limits.maxModelOutputTokens),
    maxResultBytes: Math.min(roleBudget.maxResultBytes, brief.limits.maxTotalResponseBytes),
    maxDurationMs: Math.min(roleBudget.maxDurationMs, brief.limits.maxRunMs),
    maxCostMicros: roleBudget.maxCostMicros,
  };
}

function aggregateBudget(nodes: readonly ResearchGraphNodeV1[]): ResearchNodeBudgetV1 {
  return nodes.reduce<ResearchNodeBudgetV1>((total, node) => ({
    maxCapabilityCalls: total.maxCapabilityCalls + node.budget.maxCapabilityCalls,
    maxInputTokens: total.maxInputTokens + node.budget.maxInputTokens,
    maxOutputTokens: total.maxOutputTokens + node.budget.maxOutputTokens,
    maxResultBytes: total.maxResultBytes + node.budget.maxResultBytes,
    maxDurationMs: Math.max(total.maxDurationMs, node.budget.maxDurationMs),
    maxCostMicros: total.maxCostMicros + node.budget.maxCostMicros,
  }), {
    maxCapabilityCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxResultBytes: 0,
    maxDurationMs: 0,
    maxCostMicros: 0,
  });
}

function reconciliationPolicy(brief: ResearchBriefV1, relation: boolean): ResearchGraphReconciliationPolicyV1 {
  const mode = brief.requestedReconciliation;
  const triggers: ResearchGraphReconciliationPolicyV1["triggers"] = [];
  if (relation) triggers.push("multi_branch");
  if (brief.resolvedEffort === "deep") triggers.push("low_coverage", "contradiction", "stale_or_truncated");
  if (mode === "required") triggers.push("user_requested");
  return {
    mode,
    triggers: [...new Set(triggers)],
    maxPasses: mode === "off" ? 0 : 1,
    minimumRemainingBudget: {
      maxCapabilityCalls: 0,
      maxInputTokens: 4_000,
      maxOutputTokens: 1_000,
      maxResultBytes: 16_000,
      maxDurationMs: 30_000,
      maxCostMicros: 100_000,
    },
  };
}

interface NodeSeed {
  id: string;
  kind: ResearchGraphNodeV1["kind"];
  executor: ResearchGraphNodeV1["executor"];
  roleId?: ResearchSubagentRoleIdV1;
  objective: string;
  requestedCapabilityIds: ResearchGraphCapabilityV1[];
  dependencies: string[];
  reasonCodes: ResearchCompositionReasonV1[];
  priority: number;
}

function outputSchemaForNode(
  roleId: ResearchSubagentRoleIdV1 | undefined,
  requestedCapabilityIds: readonly ResearchGraphCapabilityV1[],
  packetOutputSchema: ResearchGraphCompositionOptionsV1["packetOutputSchema"],
): ResearchTaskOutputSchemaV1 {
  // PTC-only graph nodes have no role-bound response contract. Keep them on
  // the original packet shape even when a productive subagent graph uses V2.
  if (!roleId) return RESEARCH_PACKET_BODY_SCHEMA_V1;
  if (roleId === "synthesizer") return "atlcli.research-agent-draft/v1";
  if (roleId === "reconciler") return "atlcli.reconciliation-body/v1";
  if (packetOutputSchema !== RESEARCH_PACKET_BODY_SCHEMA_V2) {
    return RESEARCH_PACKET_BODY_SCHEMA_V1;
  }
  // Detail-reading nodes create quote-bearing candidates. Analysis-only nodes
  // receive only host-projected claims and must use the reference-only model
  // schema, which cannot introduce a new factual claim.
  const hasDetailRead = requestedCapabilityIds.includes("jira.issue.get") ||
    requestedCapabilityIds.includes("wiki.page.get");
  return hasDetailRead
    ? RESEARCH_PACKET_BODY_SCHEMA_V2
    : RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2;
}

function grantFor(
  seed: NodeSeed,
  grants: ResearchGraphCompositionOptionsV1["grants"],
): ResearchGraphCapabilityV1[] {
  const allowedByRole = seed.roleId
    ? RESEARCH_SUBAGENT_ROLE_REGISTRY_V1[seed.roleId].allowedCapabilityIds
    : RESEARCH_GRAPH_CAPABILITIES;
  const hostGrant = grants?.[seed.id] ?? (seed.roleId ? grants?.[seed.roleId] : undefined);
  return seed.requestedCapabilityIds.filter((capability) =>
    allowedByRole.includes(capability) && (!hostGrant || hostGrant.includes(capability)),
  );
}

function nodeFromSeed(
  seed: NodeSeed,
  brief: ResearchBriefV1,
  graphApproved: boolean,
  grants: ResearchGraphCompositionOptionsV1["grants"],
  packetOutputSchema: ResearchGraphCompositionOptionsV1["packetOutputSchema"],
): ResearchGraphNodeV1 {
  return {
    ...seed,
    ...(seed.roleId ? { roleId: seed.roleId } : {}),
    outputSchema: outputSchemaForNode(
      seed.roleId,
      seed.requestedCapabilityIds,
      packetOutputSchema,
    ),
    grantedCapabilityIds: grantFor(seed, grants),
    typedIntentRefs: seed.requestedCapabilityIds.length > 0 ? [`intent:${seed.id}`] : [],
    createdFromEvidenceIds: [],
    status: graphApproved && seed.dependencies.length === 0 ? "ready" : graphApproved ? "blocked" : "proposed",
    depth: 0,
    attempt: 0,
    maxAttempts: seed.roleId === "synthesizer" ? 2 : 1,
    budget: nodeBudget(brief, seed.roleId),
    completion: {
      requiredCoverageTargetIds: brief.coverageTargets.filter((target) => target.required).map((target) => target.id),
      allowAbstention: true,
      stopOnFirstSupportedAnswer: brief.resolvedEffort === "lookup",
    },
  };
}

function composeSeeds(brief: ResearchBriefV1, includeOutlinePlanner: boolean): NodeSeed[] {
  const objective = normalizedObjective(brief.objective);
  const jira = brief.sourceClasses.includes("jira");
  const wiki = brief.sourceClasses.includes("confluence");
  const relation = jira && wiki && hasAny(objective, [
    "relate", "related", "belong", "join", "link", "between", "correspond", "match",
    "mapping", "map", "funnel", "pipeline", "stage", "opportunit", "zuord", "gehören", "zusammenhang",
  ]);
  const contradiction = hasAny(objective, [
    "verify contradiction",
    "verify conflict",
    "contradict",
    "conflict",
    "widerspruch",
    "widerspricht",
    "konflikt",
  ]);
  const deep = brief.resolvedEffort === "deep";
  const seeds: NodeSeed[] = [];

  if (brief.resolvedEffort === "lookup") {
    if (jira) seeds.push({ id: "research-node:jira-lookup", kind: "search", executor: "subagent", roleId: "focused-researcher", objective: "Acquire detail-backed Jira evidence for the exact bounded lookup intent.", requestedCapabilityIds: ["jira.issue.search", "research.candidate.rank", "jira.issue.get"], dependencies: [], reasonCodes: ["simple_lookup"], priority: 100 });
    if (wiki) seeds.push({ id: "research-node:wiki-lookup", kind: "search", executor: "subagent", roleId: "focused-researcher", objective: "Acquire detail-backed Confluence evidence for the exact bounded lookup intent.", requestedCapabilityIds: ["wiki.search", "research.candidate.rank", "wiki.page.get"], dependencies: [], reasonCodes: ["simple_lookup"], priority: 100 });
  } else {
    if (jira) seeds.push({ id: "research-node:jira-research", kind: "search", executor: "subagent", roleId: "focused-researcher", objective: "Acquire detail-backed Jira evidence for the accepted objective.", requestedCapabilityIds: ["jira.issue.search", "research.candidate.rank", "jira.issue.get"], dependencies: [], reasonCodes: ["independent_branch"], priority: 100 });
    if (wiki) seeds.push({ id: "research-node:wiki-research", kind: "search", executor: "subagent", roleId: "focused-researcher", objective: "Acquire detail-backed Confluence evidence for the accepted objective.", requestedCapabilityIds: ["wiki.search", "research.candidate.rank", "wiki.page.get"], dependencies: [], reasonCodes: ["independent_branch"], priority: 100 });
  }

  const researchIds = seeds.map((seed) => seed.id);
  if (relation) {
    seeds.push({ id: "research-node:cross-product-join", kind: "distill", executor: "subagent", roleId: "document-distiller", objective: "Join accepted Jira and Confluence packets without new reads.", requestedCapabilityIds: [], dependencies: [...researchIds], reasonCodes: ["cross_product_join"], priority: 80 });
  }
  const joinId = seeds.some((seed) => seed.id === "research-node:cross-product-join")
    ? "research-node:cross-product-join"
    : undefined;
  if (contradiction) {
    seeds.push({ id: "research-node:contradiction-verification", kind: "verify", executor: "subagent", roleId: "contradiction-verifier", objective: "Challenge contradiction candidates against accepted packets.", requestedCapabilityIds: [], dependencies: joinId ? [joinId] : [...researchIds], reasonCodes: ["contradiction"], priority: 70 });
  }
  if (deep) {
    seeds.push({ id: "research-node:coverage-moderation", kind: "moderate", executor: "subagent", roleId: "coverage-moderator", objective: "Assess whether accepted packets cover every required target.", requestedCapabilityIds: [], dependencies: [...seeds.filter((seed) => seed.executor !== "ptc" || seed.kind === "search").map((seed) => seed.id)], reasonCodes: ["coverage_gap"], priority: 60 });
  }
  if (includeOutlinePlanner) {
    seeds.push({
      id: "research-node:outline-planning",
      kind: "outline",
      executor: "subagent",
      roleId: "outline-planner",
      objective: "Propose a bounded claim-linked report outline from host-projected current claims only.",
      requestedCapabilityIds: [],
      dependencies: seeds.map((seed) => seed.id),
      reasonCodes: ["user_requested"],
      priority: 50,
    });
  }
  const beforeReconciliation = seeds.map((seed) => seed.id);
  const shouldReconcile = brief.requestedReconciliation === "required" ||
    (brief.requestedReconciliation === "auto" && (relation || deep || contradiction));
  if (shouldReconcile) {
    seeds.push({ id: "research-node:reconciler", kind: "reconcile", executor: "subagent", roleId: "reconciler", objective: "Critique accepted packets in fresh context and return typed defects.", requestedCapabilityIds: [], dependencies: beforeReconciliation, reasonCodes: contradiction ? ["contradiction"] : ["coverage_gap"], priority: 40 });
    seeds.push({
      id: "research-node:reconciliation-repair",
      kind: "repair",
      executor: "subagent",
      roleId: "contradiction-verifier",
      objective: "Execute at most one host-authorized reconciliation follow-up inside the approved Jira and Confluence scope.",
      requestedCapabilityIds: [
        ...(jira ? ["jira.issue.search", "research.candidate.rank", "jira.issue.get"] as const : []),
        ...(wiki ? ["wiki.search", "research.candidate.rank", "wiki.page.get"] as const : []),
      ],
      dependencies: ["research-node:reconciler"],
      reasonCodes: ["coverage_gap"],
      priority: 30,
    });
  }
  seeds.push({
    id: "research-node:synthesizer",
    kind: "distill",
    executor: "subagent",
    roleId: "synthesizer",
    objective: "Write exactly one typed final report draft from accepted packets and dispositions.",
    requestedCapabilityIds: [],
    dependencies: seeds.map((seed) => seed.id),
    reasonCodes: ["user_requested"],
    priority: 10,
  });
  return seeds;
}

export function projectSelectedResearchRolesV1(graph: Pick<ResearchGraphV1, "nodes">): ResearchSubagentRoleIdV1[] {
  const selected = new Set(
    graph.nodes
      .filter((node) =>
        node.executor === "subagent" && node.kind !== "repair" &&
        node.status !== "pruned" && node.roleId
      )
      .map((node) => node.roleId!),
  );
  return graphRolesForNodes(graph.nodes).filter((roleId) => selected.has(roleId));
}

function graphUsesV2Packets(nodes: readonly Pick<ResearchGraphNodeV1, "outputSchema">[]): boolean {
  return nodes.some((node) => node.outputSchema === RESEARCH_PACKET_BODY_SCHEMA_V2 ||
    node.outputSchema === RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2);
}

function graphRolesForNodes(nodes: readonly Pick<ResearchGraphNodeV1, "outputSchema">[]): readonly ResearchSubagentRoleIdV1[] {
  return graphUsesV2Packets(nodes) ? RESEARCH_T5_GRAPH_ROLES : RESEARCH_T3_GRAPH_ROLES;
}

function roleDecisions(nodes: ResearchGraphNodeV1[]): ResearchGraphRoleDecisionV1[] {
  const selected = new Set(projectSelectedResearchRolesV1({ nodes }));
  return graphRolesForNodes(nodes).map((roleId) => ({
    roleId,
    decision: selected.has(roleId) ? "selected" : "omitted",
    reasonCodes: selected.has(roleId)
      ? [...new Set(nodes.filter((node) => node.roleId === roleId).flatMap((node) => node.reasonCodes))]
      : ["not_applicable"],
  }));
}

function approvalEnvelope(
  brief: ResearchBriefV1,
  revision: number,
  nodes: ResearchGraphNodeV1[],
  policy: ResearchGraphReconciliationPolicyV1,
  budget: ResearchNodeBudgetV1,
  maxResearchWaves: number,
  createdAt: string,
): ResearchApprovalEnvelopeV1 {
  const automatic = brief.resolvedPlanApproval === "automatic";
  const approvedBindings = brief.scopeBindings.filter((binding) => binding.authority === "approved" || binding.authority === "locked");
  return {
    schema: RESEARCH_APPROVAL_ENVELOPE_SCHEMA_V1,
    id: `research-approval:${brief.turnId}:${revision}`,
    status: automatic ? "approved" : "proposed",
    basedOnGraphRevision: revision,
    basedOnBriefRevision: brief.revision,
    scopeFingerprint: fingerprint(brief.scope),
    scopeBindingFingerprint: fingerprint(approvedBindings.map((binding) => binding.id)),
    allowedScopeBindingIds: approvedBindings.map((binding) => binding.id),
    scopeDiscoveryPolicy: structuredClone(brief.scopeDiscoveryPolicy),
    coverageTargetFingerprint: fingerprint(brief.coverageTargets.map((target) => ({ id: target.id, question: target.question }))),
    allowedCoverageTargetIds: brief.coverageTargets.map((target) => target.id),
    resolvedEffort: brief.resolvedEffort,
    allowedRoleIds: [...new Set([
      ...projectSelectedResearchRolesV1({ nodes }),
      ...nodes.filter((node) => node.kind === "repair" && node.roleId).map((node) => node.roleId!),
    ])],
    allowedCapabilityIds: [...new Set(nodes.flatMap((node) => node.grantedCapabilityIds))],
    totalBudgetCeiling: budget,
    maxParallelNodes: 3,
    maxResearchWaves,
    maxReconciliationWaves: 1,
    maxDepth: 0,
    reconciliationPolicy: structuredClone(policy),
    ...(automatic ? { approvedAt: createdAt } : {}),
  };
}

/**
 * The host owns the maximum number of sequential pre-reconciliation research
 * waves. It is derived from the admitted DAG rather than from a broad effort
 * label: a V2 outline can legitimately follow a cross-product join, coverage
 * review, and verification. Reconciliation, repair, and synthesis remain
 * separately bounded execution phases.
 */
function researchWaveCeiling(nodes: readonly ResearchGraphNodeV1[]): number {
  const researchNodes = new Map(nodes
    .filter((node) =>
      node.executor === "subagent" &&
      node.roleId !== undefined &&
      node.roleId !== "reconciler" &&
      node.roleId !== "synthesizer" &&
      node.kind !== "repair" &&
      node.status !== "pruned"
    )
    .map((node) => [node.id, node]));
  const waves = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (nodeId: string): number => {
    const known = waves.get(nodeId);
    if (known !== undefined) return known;
    if (visiting.has(nodeId)) invalid("Research graph dependencies must be acyclic.");
    const node = researchNodes.get(nodeId);
    if (!node) return 0;
    visiting.add(nodeId);
    const dependencies = node.dependencies
      .filter((dependency) => researchNodes.has(dependency))
      .map(visit);
    visiting.delete(nodeId);
    const wave = dependencies.length === 0 ? 1 : Math.max(...dependencies) + 1;
    waves.set(nodeId, wave);
    return wave;
  };
  researchNodes.forEach((_, nodeId) => visit(nodeId));
  // Retain one bounded reconciliation-repair slot for simple graphs while
  // increasing the ceiling only when the host-composed topology requires it.
  return Math.max(2, ...waves.values());
}

export interface ComposeStandardResearchGraphOptionsV1 {
  sessionId?: string;
  turnId?: string;
  scope?: ResearchScopeV1;
  scopeBindings?: readonly ResearchScopeBindingV1[];
  limits?: ResearchLimitsV1;
  asOf?: string;
  timezone?: string;
  policy?: ResearchOneShotPolicyV1;
}

/**
 * Construct the common host-owned one-shot brief before any graph/model work.
 * Callers that need to surface clarification must run the brief preflight
 * before passing this value to `composeResearchGraphV1`.
 */
export function createStandardResearchBriefV1(
  question: string,
  options: ComposeStandardResearchGraphOptionsV1 = {},
): ResearchBriefV1 {
  const policy = normalizeResearchOneShotPolicyV1(
    options.policy ?? DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
  );
  return createResearchBriefV1({
    sessionId: options.sessionId ?? "research-session:standard",
    turnId: options.turnId ?? "research-turn:standard",
    objective: question,
    scope: options.scope ?? {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["DOCS"],
    },
    asOf: options.asOf ?? "2026-01-01T00:00:00.000Z",
    timezone: options.timezone ?? "UTC",
    ...(options.scopeBindings ? { scopeBindings: [...options.scopeBindings] } : {}),
    scopeDiscoveryPolicy: {
      ...DEFAULT_RESEARCH_SCOPE_DISCOVERY_POLICY_V1,
      expansionMode: policy.scopeExpansionMode,
    },
    requestedEffort: policy.requestedEffort,
    requestedPlanApproval: policy.requestedPlanApproval,
    requestedReconciliation: policy.requestedReconciliation,
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

/**
 * Record an automatically approved graph as a durable proposal first, so the
 * session journal has an exact plan snapshot before its host approval boundary.
 */
export function stageResearchGraphForDurableSessionV1(graph: ResearchGraphV1): ResearchGraphV1 {
  validateResearchGraphV1(graph);
  if (graph.status === "proposed") return structuredClone(graph);
  const staged: ResearchGraphV1 = {
    ...structuredClone(graph),
    status: "proposed",
    nodes: graph.nodes.map((node) => ({ ...node, status: "proposed", packetRef: undefined, stopReason: undefined })),
    approvalEnvelope: { ...graph.approvalEnvelope, status: "proposed", approvedAt: undefined },
    approvedAt: undefined,
  };
  validateResearchGraphV1(staged);
  return staged;
}

/**
 * Compose the one-shot graph used by both productive hosts. Callers must pass
 * their normalized request scope and limits; the defaults remain only for
 * deterministic characterization tests and backwards-compatible fixtures.
 */
export function composeStandardResearchGraphV1(
  question: string,
  options: ComposeStandardResearchGraphOptionsV1 = {},
): ResearchGraphV1 {
  if (
    options.scope &&
    options.scope.jiraProjectKeys.length === 0 &&
    options.scope.confluenceSpaceKeys.length === 0
  ) {
    throw new ResearchContractError(
      "clarification-required",
      "Research scope must be resolved before graph composition.",
    );
  }
  return composeResearchGraphV1(createStandardResearchBriefV1(question, options));
}

export function composeResearchGraphV1(
  brief: ResearchBriefV1,
  options: ResearchGraphCompositionOptionsV1 = {},
): ResearchGraphV1 {
  if (brief.schema !== RESEARCH_BRIEF_SCHEMA_V1) invalid("Unsupported research brief schema.");
  if (briefRequiresClarificationV1(brief)) {
    throw new ResearchContractError(
      "clarification-required",
      "The research brief requires clarification before a graph can be proposed.",
    );
  }
  const revision = options.graphRevision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) invalid("Research graph revision is invalid.");
  const createdAt = options.createdAt ?? brief.asOf;
  const automatic = brief.resolvedPlanApproval === "automatic";
  const seeds = composeSeeds(
    brief,
    options.packetOutputSchema === RESEARCH_PACKET_BODY_SCHEMA_V2,
  );
  const nodes = seeds.map((seed) => nodeFromSeed(
    seed,
    brief,
    automatic,
    options.grants,
    options.packetOutputSchema,
  ));
  const relation = brief.sourceClasses.includes("jira") && brief.sourceClasses.includes("confluence");
  const policy = reconciliationPolicy(brief, relation);
  const totalBudget = aggregateBudget(nodes);
  const maxResearchWaves = researchWaveCeiling(nodes);
  const graph: ResearchGraphV1 = {
    schema: RESEARCH_GRAPH_SCHEMA_V1,
    sessionId: brief.sessionId,
    turnId: brief.turnId,
    revision,
    basedOnBriefRevision: brief.revision,
    status: automatic ? "approved" : "proposed",
    resolvedEffort: brief.resolvedEffort,
    nodes,
    roleDecisions: roleDecisions(nodes),
    maxParallelNodes: 3,
    maxResearchWaves,
    maxReconciliationWaves: 1,
    researchWavesCompleted: 0,
    reconciliationWavesCompleted: 0,
    reconciliationPolicy: policy,
    totalBudget,
    approvalEnvelope: approvalEnvelope(
      brief,
      revision,
      nodes,
      policy,
      totalBudget,
      maxResearchWaves,
      createdAt,
    ),
    createdAt,
    ...(automatic ? { approvedAt: createdAt } : {}),
  };
  validateResearchGraphV1(graph);
  return graph;
}

/** Project the visible, body-free reason why a T3 one-shot cannot execute. */
export function researchPlanApprovalRequiredV1(
  graph: ResearchGraphV1,
): ResearchPlanApprovalRequiredV1 | undefined {
  validateResearchGraphV1(graph);
  if (graph.status !== "proposed" || graph.approvalEnvelope.status !== "proposed") {
    return undefined;
  }
  return {
    schema: RESEARCH_PLAN_APPROVAL_REQUIRED_SCHEMA_V1,
    kind: "plan_approval_required",
    briefRevision: graph.basedOnBriefRevision,
    graphRevision: graph.revision,
    resolvedEffort: graph.resolvedEffort,
    resolvedPlanApproval: "required",
    selectedRoleIds: projectSelectedResearchRolesV1(graph),
    scopeExpansionMode: graph.approvalEnvelope.scopeDiscoveryPolicy.expansionMode,
    reconciliationMode: graph.reconciliationPolicy.mode,
    rerunGuidance: [
      "Review the proposed effort, roles, scope policy, and reconciliation mode.",
      "For the T3 one-shot path, rerun with explicit automatic plan approval.",
    ],
  };
}

/** Enforce approval before any productive host creates provider/model effects. */
export function assertResearchGraphExecutableV1(graph: ResearchGraphV1): void {
  validateResearchGraphV1(graph);
  const stop = researchPlanApprovalRequiredV1(graph);
  if (stop) {
    throw new ResearchContractError(
      "plan-approval-required",
      "This research plan requires approval. Review it and rerun with explicit automatic plan approval.",
    );
  }
  if (graph.status !== "approved" || graph.approvalEnvelope.status !== "approved") {
    throw new ResearchContractError(
      "invalid-request",
      "Only an approved research graph can start a one-shot run.",
    );
  }
}

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function validateBudget(budget: ResearchNodeBudgetV1, label: string): void {
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} ${key} is invalid.`);
  }
}

function equalBudget(left: ResearchNodeBudgetV1, right: ResearchNodeBudgetV1): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof ResearchNodeBudgetV1] === right[key as keyof ResearchNodeBudgetV1]
  );
}

function budgetWithinCeiling(
  budget: ResearchNodeBudgetV1,
  ceiling: ResearchNodeBudgetV1,
): boolean {
  return Object.keys(budget).every((key) =>
    budget[key as keyof ResearchNodeBudgetV1] <=
      ceiling[key as keyof ResearchNodeBudgetV1]
  );
}

function executionRank(node: ResearchGraphNodeV1): number {
  if (node.executor === "ptc") return 0;
  if (node.kind === "repair") return 6;
  switch (node.roleId) {
    case "focused-researcher": return 0;
    case "document-distiller": return 1;
    case "contradiction-verifier": return 2;
    case "coverage-moderator": return 3;
    case "outline-planner": return 4;
    case "reconciler": return 5;
    case "synthesizer": return 7;
    case undefined: return 8;
  }
}

export function validateResearchGraphV1(graph: ResearchGraphV1): void {
  if (graph.schema !== RESEARCH_GRAPH_SCHEMA_V1) invalid("Unsupported research graph schema.");
  if (!/^research-session:[A-Za-z0-9._-]{1,120}$/.test(graph.sessionId) || !/^research-turn:[A-Za-z0-9._-]{1,120}$/.test(graph.turnId)) invalid("Research graph identity is invalid.");
  if (!Number.isSafeInteger(graph.revision) || graph.revision < 1 || !Number.isSafeInteger(graph.basedOnBriefRevision) || graph.basedOnBriefRevision < 1) invalid("Research graph revisions are invalid.");
  if (graph.maxParallelNodes < 1 || graph.maxParallelNodes > 3 ||
      graph.maxResearchWaves !== researchWaveCeiling(graph.nodes) ||
      graph.maxReconciliationWaves !== 1) invalid("Research graph concurrency or wave limits are invalid.");
  if (graph.nodes.length === 0 || graph.nodes.length > 9) invalid("Research graph node count is invalid.");
  if (graph.researchWavesCompleted < 0 || graph.researchWavesCompleted > graph.maxResearchWaves || graph.reconciliationWavesCompleted < 0 || graph.reconciliationWavesCompleted > graph.maxReconciliationWaves) invalid("Research graph completed-wave count is invalid.");
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!/^research-node:[A-Za-z0-9._-]{1,120}$/.test(node.id) || ids.has(node.id)) invalid("Research graph node IDs must be valid and unique.");
    ids.add(node.id);
    if (node.depth !== 0) invalid("Research graph depth is unavailable before T6.");
    if (node.kind === "expand") invalid("Research graph content-scope expansion is unavailable before T6.");
    if (node.executor === "subagent") {
      if (!node.roleId || !graphRolesForNodes(graph.nodes).includes(node.roleId)) invalid("Research graph subagent role is unknown or unavailable.");
      const role = RESEARCH_SUBAGENT_ROLE_REGISTRY_V1[node.roleId];
      if (node.grantedCapabilityIds.some((capability) => !role.allowedCapabilityIds.includes(capability))) invalid("Research graph grants a capability outside the selected role.");
      if (!role.supportedOutputSchemas.includes(node.outputSchema)) invalid("Research graph output schema is not allowed for the selected role.");
    } else if (node.roleId) {
      invalid("Research graph PTC nodes cannot carry subagent roles.");
    } else if (node.outputSchema !== RESEARCH_PACKET_BODY_SCHEMA_V1) {
      invalid("Research graph PTC nodes must use the V1 packet schema.");
    }
    if (node.requestedCapabilityIds.some((capability) => !PTC_CAPABILITIES.has(capability))) invalid("Research graph requests an unknown capability.");
    if (node.grantedCapabilityIds.some((capability) => !node.requestedCapabilityIds.includes(capability))) invalid("Research graph grants an unrequested capability.");
    if (node.requestedCapabilityIds.length > 0 && node.typedIntentRefs.length === 0) invalid("Research graph capability nodes require typed intent references.");
    if (node.dependencies.includes(node.id)) invalid("Research graph dependencies must be acyclic.");
    if (node.dependencies.some((dependency) => !graph.nodes.some((candidate) => candidate.id === dependency))) invalid("Research graph dependency is invalid.");
    if (node.dependencies.some((dependency) => executionRank(graph.nodes.find((candidate) => candidate.id === dependency)!) >= executionRank(node))) invalid("Research graph dependency is incompatible with the execution phase.");
    if (!Number.isSafeInteger(node.priority) || node.priority < 0 || !Number.isSafeInteger(node.attempt) || node.attempt < 0 || !Number.isSafeInteger(node.maxAttempts) || node.maxAttempts < 1 || node.attempt > node.maxAttempts ||
        (node.taskGraphRevision !== undefined && (!Number.isSafeInteger(node.taskGraphRevision) || node.taskGraphRevision < 1 || node.taskGraphRevision > graph.revision))) invalid("Research graph node scheduling fields are invalid.");
    validateBudget(node.budget, `Research graph node ${node.id} budget`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid("Research graph dependencies must be acyclic.");
    if (visited.has(id)) return;
    visiting.add(id);
    graph.nodes.find((node) => node.id === id)!.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  graph.nodes.forEach((node) => visit(node.id));
  const synthesizers = graph.nodes.filter((node) => node.roleId === "synthesizer" && node.executor === "subagent" && node.status !== "pruned");
  if (synthesizers.length !== 1) invalid("Research graph requires exactly one final synthesizer.");
  const availableRoles = graphRolesForNodes(graph.nodes);
  const decisions = new Map<ResearchSubagentRoleIdV1, ResearchGraphRoleDecisionV1>();
  for (const decision of graph.roleDecisions) {
    if (!availableRoles.includes(decision.roleId) || decisions.has(decision.roleId)) invalid("Research graph role decisions are missing, duplicated, or unavailable.");
    decisions.set(decision.roleId, decision);
  }
  if (decisions.size !== availableRoles.length) invalid("Research graph role decisions are missing, duplicated, or unavailable.");
  const projected = new Set(projectSelectedResearchRolesV1(graph));
  for (const roleId of availableRoles) {
    const decision = decisions.get(roleId)!;
    if ((decision.decision === "selected") !== projected.has(roleId)) invalid("Research graph role decisions must derive from executable nodes.");
  }
  if (graph.approvalEnvelope.schema !== RESEARCH_APPROVAL_ENVELOPE_SCHEMA_V1 || graph.approvalEnvelope.basedOnGraphRevision !== graph.revision || graph.approvalEnvelope.basedOnBriefRevision !== graph.basedOnBriefRevision) invalid("Research graph approval envelope revision is invalid.");
  if ([...projected].some((roleId) => !graph.approvalEnvelope.allowedRoleIds.includes(roleId))) invalid("Research graph executable roles exceed the approval envelope.");
  const granted = [...new Set(graph.nodes.flatMap((node) => node.grantedCapabilityIds))];
  if (granted.some((capabilityId) => !graph.approvalEnvelope.allowedCapabilityIds.includes(capabilityId))) invalid("Research graph executable capabilities exceed the approval envelope.");
  if (graph.approvalEnvelope.maxParallelNodes !== graph.maxParallelNodes || graph.approvalEnvelope.maxResearchWaves !== graph.maxResearchWaves || graph.approvalEnvelope.maxReconciliationWaves !== graph.maxReconciliationWaves || graph.approvalEnvelope.maxDepth !== 0) invalid("Research graph approval execution limits are inconsistent.");
  validateBudget(graph.totalBudget, "Research graph total budget");
  const derivedBudget = aggregateBudget(graph.nodes);
  if (!equalBudget(graph.totalBudget, derivedBudget)) invalid("Research graph total budget must derive from executable nodes.");
  if (!budgetWithinCeiling(derivedBudget, graph.approvalEnvelope.totalBudgetCeiling)) invalid("Research graph total budget exceeds the approval envelope.");
  if ((graph.status === "proposed") !== (graph.approvalEnvelope.status === "proposed")) invalid("Research graph approval status is inconsistent.");
}

function parseResearchGraphProposalNodeV1(
  value: unknown,
): ResearchGraphProposalNodeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Research graph proposal node is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (!equalSet(Object.keys(record), ["nodeId", "dependencies", "reasonCodes"])) {
    invalid("Research graph proposal node contains unsupported fields.");
  }
  if (typeof record.nodeId !== "string" || !/^research-node:[A-Za-z0-9._-]{1,120}$/.test(record.nodeId)) {
    invalid("Research graph proposal node ID is invalid.");
  }
  if (!Array.isArray(record.dependencies) || record.dependencies.length > 9 ||
      record.dependencies.some((dependency) => typeof dependency !== "string") ||
      new Set(record.dependencies).size !== record.dependencies.length) {
    invalid("Research graph proposal dependencies are invalid.");
  }
  if (!Array.isArray(record.reasonCodes) || record.reasonCodes.length < 1 ||
      record.reasonCodes.length > 4 ||
      record.reasonCodes.some((reason) =>
        typeof reason !== "string" ||
        !RESEARCH_COMPOSITION_REASONS_V1.includes(reason as ResearchCompositionReasonV1)
      ) || new Set(record.reasonCodes).size !== record.reasonCodes.length) {
    invalid("Research graph proposal reason codes are invalid.");
  }
  return {
    nodeId: record.nodeId,
    dependencies: [...record.dependencies] as string[],
    reasonCodes: [...record.reasonCodes] as ResearchCompositionReasonV1[],
  };
}

/** Parse the only model-authored graph shape accepted by the T3 host. */
export function parseResearchGraphProposalV1(
  value: unknown,
): ResearchGraphProposalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Research graph proposal is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (!equalSet(Object.keys(record), [
    "schema",
    "basedOnBriefRevision",
    "basedOnGraphRevision",
    "nodes",
  ])) {
    invalid("Research graph proposal contains unsupported fields.");
  }
  if (record.schema !== RESEARCH_GRAPH_PROPOSAL_SCHEMA_V1 ||
      !Number.isSafeInteger(record.basedOnBriefRevision) ||
      !Number.isSafeInteger(record.basedOnGraphRevision) ||
      !Array.isArray(record.nodes) || record.nodes.length < 2 || record.nodes.length > 9) {
    invalid("Research graph proposal envelope is invalid.");
  }
  const nodes = record.nodes.map(parseResearchGraphProposalNodeV1);
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
    invalid("Research graph proposal node IDs must be unique.");
  }
  return {
    schema: RESEARCH_GRAPH_PROPOSAL_SCHEMA_V1,
    basedOnBriefRevision: record.basedOnBriefRevision as number,
    basedOnGraphRevision: record.basedOnGraphRevision as number,
    nodes,
  };
}

/**
 * Accept a supervisor selection only inside a previously validated host graph.
 * The proposal controls composition and dependencies, never scope, objectives,
 * capability grants, schemas, or budgets.
 */
export function acceptResearchGraphProposalV1(
  catalogGraph: ResearchGraphV1,
  value: unknown,
): ResearchGraphV1 {
  validateResearchGraphV1(catalogGraph);
  const proposal = parseResearchGraphProposalV1(value);
  if (proposal.basedOnBriefRevision !== catalogGraph.basedOnBriefRevision ||
      proposal.basedOnGraphRevision !== catalogGraph.revision) {
    invalid("Research graph proposal revision is stale.");
  }
  if (catalogGraph.status !== "approved" || catalogGraph.approvalEnvelope.status !== "approved") {
    invalid("Research graph proposal requires an approved host envelope.");
  }

  const catalogById = new Map(catalogGraph.nodes.map((node) => [node.id, node]));
  const selectedIds = new Set(proposal.nodes.map((node) => node.nodeId));
  if ([...selectedIds].some((nodeId) => !catalogById.has(nodeId))) {
    invalid("Research graph proposal references a node outside the host catalog.");
  }
  if (catalogGraph.nodes.some((node) => node.kind === "repair" && selectedIds.has(node.id))) {
    invalid("Conditional reconciliation repair cannot be selected before critique.");
  }
  const requiredAcquisitionIds = catalogGraph.nodes
    .filter((node) => node.kind === "search" || node.kind === "resolve_scope")
    .map((node) => node.id);
  if (requiredAcquisitionIds.some((nodeId) => !selectedIds.has(nodeId))) {
    invalid("Research graph proposal must retain every host-required acquisition node.");
  }
  const selectedSynthesizers = catalogGraph.nodes.filter((node) =>
    selectedIds.has(node.id) && node.roleId === "synthesizer"
  );
  if (selectedSynthesizers.length !== 1) {
    invalid("Research graph proposal requires exactly one final synthesizer.");
  }
  const reconciler = catalogGraph.nodes.find((node) => node.roleId === "reconciler");
  if (catalogGraph.reconciliationPolicy.mode === "required" &&
      (!reconciler || !selectedIds.has(reconciler.id))) {
    invalid("Research graph proposal must retain required reconciliation.");
  }

  const selectedCatalogNodes = catalogGraph.nodes.filter((node) => selectedIds.has(node.id));
  const proposalById = new Map(proposal.nodes.map((node) => [node.nodeId, node]));
  for (const node of selectedCatalogNodes) {
    const proposed = proposalById.get(node.id)!;
    if (proposed.dependencies.includes(node.id) ||
        proposed.dependencies.some((dependency) => !selectedIds.has(dependency))) {
      invalid("Research graph proposal dependencies leave the selected graph.");
    }
    const acquisitions = requiredAcquisitionIds.filter((id) => id !== node.id);
    const mustDependOn = node.roleId === "synthesizer"
      ? selectedCatalogNodes.filter((candidate) => candidate.id !== node.id).map((candidate) => candidate.id)
      : node.roleId === "reconciler"
        ? selectedCatalogNodes.filter((candidate) =>
            candidate.id !== node.id && candidate.roleId !== "synthesizer"
          ).map((candidate) => candidate.id)
        : node.roleId === "document-distiller" ||
            node.roleId === "contradiction-verifier" ||
            node.roleId === "coverage-moderator"
          ? acquisitions
          : node.roleId === "outline-planner"
            ? selectedCatalogNodes.filter((candidate) =>
                candidate.id !== node.id &&
                candidate.roleId !== "reconciler" &&
                candidate.roleId !== "synthesizer"
              ).map((candidate) => candidate.id)
          : [];
    if (mustDependOn.some((dependency) => !proposed.dependencies.includes(dependency))) {
      invalid(`Research graph proposal omits a required dependency for ${node.id}.`);
    }
    if ((node.kind === "search" || node.kind === "resolve_scope") && proposed.dependencies.length > 0) {
      invalid("Research acquisition nodes cannot depend on later research work.");
    }
  }

  const nodes = selectedCatalogNodes.map((node) => {
    const proposed = proposalById.get(node.id)!;
    return {
      ...node,
      dependencies: [...proposed.dependencies],
      reasonCodes: [...proposed.reasonCodes],
      status: proposed.dependencies.length === 0 ? "ready" as const : "blocked" as const,
    };
  });
  const accepted: ResearchGraphV1 = {
    ...catalogGraph,
    nodes,
    roleDecisions: roleDecisions(nodes),
    totalBudget: aggregateBudget(nodes),
    maxResearchWaves: researchWaveCeiling(nodes),
    approvalEnvelope: {
      ...catalogGraph.approvalEnvelope,
      maxResearchWaves: researchWaveCeiling(nodes),
    },
  };
  validateResearchGraphV1(accepted);
  return accepted;
}

function parseResearchGraphRevisionProposalNodeV1(
  value: unknown,
): ResearchGraphRevisionProposalNodeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !equalSet(Object.keys(value as Record<string, unknown>), [
        "nodeId",
        "dependencies",
        "reasonCodes",
        "priority",
      ]) ||
      !Number.isSafeInteger((value as Record<string, unknown>).priority)) {
    invalid("Research graph revision proposal node is invalid.");
  }
  const record = value as Record<string, unknown>;
  const priority = record.priority as number;
  if (priority < 0 || priority > 100) {
    invalid("Research graph revision proposal node is invalid.");
  }
  const node = parseResearchGraphProposalNodeV1({
    nodeId: record.nodeId,
    dependencies: record.dependencies,
    reasonCodes: record.reasonCodes,
  });
  return { ...node, priority };
}

export function parseResearchGraphRevisionProposalV1(
  value: unknown,
): ResearchGraphRevisionProposalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Research graph revision proposal is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (!equalSet(Object.keys(record), [
    "schema",
    "basedOnBriefRevision",
    "basedOnGraphRevision",
    "nodes",
    "prune",
  ]) ||
      record.schema !== RESEARCH_GRAPH_REVISION_PROPOSAL_SCHEMA_V1 ||
      !Number.isSafeInteger(record.basedOnBriefRevision) ||
      !Number.isSafeInteger(record.basedOnGraphRevision) ||
      !Array.isArray(record.nodes) || record.nodes.length < 2 || record.nodes.length > 9 ||
      !Array.isArray(record.prune) || record.prune.length > 8) {
    invalid("Research graph revision proposal is invalid.");
  }
  const nodes = record.nodes.map(parseResearchGraphRevisionProposalNodeV1);
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
    invalid("Research graph revision proposal node IDs must be unique.");
  }
  const prune = record.prune.map((value): ResearchGraphRevisionPruneV1 => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid("Research graph revision prune is invalid.");
    }
    const entry = value as Record<string, unknown>;
    if (!equalSet(Object.keys(entry), ["nodeId", "reasonCode"]) ||
        typeof entry.nodeId !== "string" ||
        !/^research-node:[A-Za-z0-9._-]{1,120}$/.test(entry.nodeId) ||
        !RESEARCH_COMPOSITION_REASONS_V1.includes(entry.reasonCode as ResearchCompositionReasonV1)) {
      invalid("Research graph revision prune is invalid.");
    }
    return {
      nodeId: entry.nodeId,
      reasonCode: entry.reasonCode as ResearchCompositionReasonV1,
    };
  });
  if (new Set(prune.map((entry) => entry.nodeId)).size !== prune.length) {
    invalid("Research graph revision prune node IDs must be unique.");
  }
  return {
    schema: RESEARCH_GRAPH_REVISION_PROPOSAL_SCHEMA_V1,
    basedOnBriefRevision: record.basedOnBriefRevision as number,
    basedOnGraphRevision: record.basedOnGraphRevision as number,
    nodes,
    prune,
  };
}

function sameGraphDependencies(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((dependency, index) => dependency === right[index]);
}

function observedNodeStatus(status: ResearchNodeStatusV1): boolean {
  return status === "running" || status === "complete" ||
    status === "failed" || status === "quarantined";
}

/**
 * Rebase a new selected subset of the original catalog onto a settled graph.
 * The next graph revision retains every historic node and packet reference,
 * while admitting only never-observed catalog nodes. This is the host boundary
 * that makes a later QuickJS evaluation disposable: it receives a fresh
 * bounded frontier from durable graph state, not from prior guest globals.
 */
export function reviseResearchGraphSelectionV1(
  catalogGraph: ResearchGraphV1,
  currentGraph: ResearchGraphV1,
  value: unknown,
): ResearchGraphV1 {
  validateResearchGraphV1(catalogGraph);
  validateResearchGraphV1(currentGraph);
  const proposal = parseResearchGraphRevisionProposalV1(value);
  if (catalogGraph.sessionId !== currentGraph.sessionId ||
      catalogGraph.turnId !== currentGraph.turnId ||
      catalogGraph.basedOnBriefRevision !== currentGraph.basedOnBriefRevision ||
      currentGraph.status === "complete" ||
      currentGraph.nodes.some((node) => node.status === "running") ||
      proposal.basedOnBriefRevision !== currentGraph.basedOnBriefRevision ||
      proposal.basedOnGraphRevision !== currentGraph.revision) {
    invalid("Research graph revision proposal is stale or the graph is unsettled.");
  }
  const currentById = new Map(currentGraph.nodes.map((node) => [node.id, node]));
  if (currentGraph.nodes.some((node) => !catalogGraph.nodes.some((candidate) => candidate.id === node.id))) {
    invalid("Research graph revision is outside the original approved catalog.");
  }
  const selectedNodeIds = new Set(proposal.nodes.map((node) => node.nodeId));
  if ([...currentById.keys()].some((nodeId) => !selectedNodeIds.has(nodeId))) {
    invalid("Research graph revision cannot discard prior graph history.");
  }
  const catalogSelection = acceptResearchGraphProposalV1(catalogGraph, {
    schema: RESEARCH_GRAPH_PROPOSAL_SCHEMA_V1,
    basedOnBriefRevision: catalogGraph.basedOnBriefRevision,
    basedOnGraphRevision: catalogGraph.revision,
    nodes: proposal.nodes.map(({ priority: _priority, ...node }) => node),
  });
  const proposalById = new Map(proposal.nodes.map((node) => [node.nodeId, node]));
  const prunedById = new Map(proposal.prune.map((entry) => [entry.nodeId, entry]));
  const nodes = catalogSelection.nodes.map((candidate) => {
    const previous = currentById.get(candidate.id);
    const proposed = proposalById.get(candidate.id)!;
    const prune = prunedById.get(candidate.id);
    if (previous && observedNodeStatus(previous.status)) {
      if (!sameGraphDependencies(previous.dependencies, candidate.dependencies) ||
          previous.priority !== proposed.priority || prune) {
        invalid("Research graph revision cannot alter an observed node.");
      }
      return structuredClone(previous);
    }
    if (previous?.status === "pruned") {
      if (prune || !sameGraphDependencies(previous.dependencies, candidate.dependencies) ||
          previous.priority !== proposed.priority) {
        invalid("Research graph revision cannot reopen or alter a closed node.");
      }
      return structuredClone(previous);
    }
    if (prune) {
      if (candidate.roleId === "synthesizer" || candidate.kind === "search" ||
          candidate.kind === "resolve_scope" ||
          (catalogGraph.reconciliationPolicy.mode === "required" && candidate.roleId === "reconciler")) {
        invalid("Research graph revision cannot close required acquisition or synthesis.");
      }
      return {
        ...candidate,
        priority: proposed.priority,
        status: "pruned" as const,
        stopReason: `graph-revision:${prune.reasonCode}`,
      };
    }
    return {
      ...candidate,
      priority: proposed.priority,
      status: "blocked" as const,
      ...(previous ? { attempt: previous.attempt } : {}),
    };
  });
  const unlocked = readyDependents(nodes);
  const revision = currentGraph.revision + 1;
  const synthesizer = unlocked.find((node) => node.roleId === "synthesizer");
  const maxResearchWaves = researchWaveCeiling(unlocked);
  if (currentGraph.researchWavesCompleted > maxResearchWaves) {
    invalid("Research graph revision cannot reduce the completed wave envelope.");
  }
  const next: ResearchGraphV1 = {
    ...catalogSelection,
    revision,
    status: synthesizer?.status === "complete" ? "complete" : "running",
    nodes: unlocked,
    roleDecisions: roleDecisions(unlocked),
    totalBudget: aggregateBudget(unlocked),
    maxResearchWaves,
    researchWavesCompleted: currentGraph.researchWavesCompleted,
    reconciliationWavesCompleted: currentGraph.reconciliationWavesCompleted,
    createdAt: currentGraph.createdAt,
    ...(currentGraph.approvedAt ? { approvedAt: currentGraph.approvedAt } : {}),
    approvalEnvelope: {
      ...catalogSelection.approvalEnvelope,
      id: `research-approval:${currentGraph.turnId}:${revision}`,
      status: "approved",
      basedOnGraphRevision: revision,
      maxResearchWaves,
      ...(currentGraph.approvedAt ? { approvedAt: currentGraph.approvedAt } : {}),
    },
  };
  validateResearchGraphV1(next);
  return next;
}

export type ResearchGraphUpdateV1 =
  | { kind: "approve"; expectedRevision: number; approvedAt: string }
  | {
      /**
       * Reintroduce the one host-retained repair node after a reconciler packet
       * and its host-recorded dispositions authorize it. This does not revise
       * the approved envelope: the repair node was part of that envelope and
       * keeps the same graph revision as the packet/disposition it repairs.
       */
      kind: "activate_repair";
      expectedRevision: number;
      repairNode: ResearchGraphNodeV1;
    }
  /**
   * The durable session records a host-derived retrieval assessment only after
   * all admitted work in that wave has reached a terminal state. This counter
   * is an execution checkpoint, not a graph-plan revision.
   */
  | { kind: "complete_research_wave"; expectedRevision: number; wave: number }
  | { kind: "start_node"; expectedRevision: number; nodeId: string }
  | { kind: "complete_node"; expectedRevision: number; nodeId: string; packetRef: string }
  | { kind: "fail_node"; expectedRevision: number; nodeId: string; stopReason: string }
  | { kind: "quarantine_node"; expectedRevision: number; nodeId: string; stopReason: string }
  | { kind: "prune_node"; expectedRevision: number; nodeId: string; stopReason: string };

function readyDependents(nodes: ResearchGraphNodeV1[]): ResearchGraphNodeV1[] {
  const complete = new Set(nodes.filter((node) => node.status === "complete" || node.status === "pruned").map((node) => node.id));
  return nodes.map((node) => node.status === "blocked" && node.dependencies.every((dependency) => complete.has(dependency))
    ? { ...node, status: "ready" }
    : node);
}

/** Pure revision-fenced T3 graph state reducer. */
export function reduceResearchGraphV1(graph: ResearchGraphV1, update: ResearchGraphUpdateV1): ResearchGraphV1 {
  validateResearchGraphV1(graph);
  if (update.expectedRevision !== graph.revision) invalid("Research graph update revision is stale.");
  if (update.kind === "approve") {
    if (graph.status !== "proposed" || graph.approvalEnvelope.status !== "proposed") invalid("Only a proposed research graph can be approved.");
    const approved: ResearchGraphV1 = {
      ...graph,
      status: "approved",
      nodes: graph.nodes.map((node) => ({ ...node, status: node.dependencies.length === 0 ? "ready" : "blocked" })),
      approvalEnvelope: { ...graph.approvalEnvelope, status: "approved", approvedAt: update.approvedAt },
      approvedAt: update.approvedAt,
    };
    validateResearchGraphV1(approved);
    return approved;
  }
  if (update.kind === "activate_repair") {
    if (graph.status === "complete" || graph.nodes.some((node) => node.kind === "repair")) {
      invalid("Research repair activation is unavailable for this graph state.");
    }
    const reconciler = graph.nodes.find((node) => node.roleId === "reconciler");
    const synthesizer = graph.nodes.find((node) => node.roleId === "synthesizer");
    if (!reconciler || reconciler.status !== "complete" || !synthesizer ||
        (synthesizer.status !== "ready" && synthesizer.status !== "blocked")) {
      invalid("Research repair activation requires a completed reconciler before synthesis.");
    }
    const retained = structuredClone(update.repairNode);
    if (retained.kind !== "repair" || retained.executor !== "subagent" ||
        retained.roleId !== "contradiction-verifier" ||
        retained.dependencies.length !== 1 || retained.dependencies[0] !== reconciler.id ||
        retained.status === "complete" || retained.status === "running" ||
        retained.status === "failed" || retained.status === "quarantined") {
      invalid("Research repair activation does not match the host-retained repair node.");
    }
    const { packetRef: _packetRef, stopReason: _stopReason, ...repairDescriptor } = retained;
    const repairNode: ResearchGraphNodeV1 = {
      ...repairDescriptor,
      dependencies: [reconciler.id],
      status: "ready",
      attempt: 0,
    };
    const nodes = graph.nodes.map((node) => node.id === synthesizer.id
      ? {
          ...node,
          dependencies: [...node.dependencies, repairNode.id],
          status: "blocked" as const,
        }
      : node,
    );
    nodes.push(repairNode);
    const activated: ResearchGraphV1 = {
      ...graph,
      status: "running",
      nodes,
      roleDecisions: roleDecisions(nodes),
      totalBudget: aggregateBudget(nodes),
    };
    validateResearchGraphV1(activated);
    return activated;
  }
  if (update.kind === "complete_research_wave") {
    if (!Number.isSafeInteger(update.wave) ||
        update.wave <= graph.researchWavesCompleted ||
        update.wave > graph.maxResearchWaves) {
      invalid("Research wave completion is stale or exceeds the approved envelope.");
    }
    const completed: ResearchGraphV1 = {
      ...graph,
      researchWavesCompleted: update.wave,
    };
    validateResearchGraphV1(completed);
    return completed;
  }
  const index = graph.nodes.findIndex((node) => node.id === update.nodeId);
  if (index < 0) invalid("Research graph update references an unknown node.");
  const node = graph.nodes[index]!;
  const nodes = graph.nodes.map((candidate) => ({ ...candidate }));
  if (update.kind === "start_node") {
    if (node.status !== "ready") invalid("Only a ready research node can start.");
    nodes[index] = {
      ...node,
      status: "running",
      attempt: node.attempt + 1,
      taskGraphRevision: graph.revision,
    };
  } else if (update.kind === "complete_node") {
    if (node.status !== "running" || !/^packet:[A-Za-z0-9:._-]{1,200}$/.test(update.packetRef)) invalid("Only a running research node can accept a packet.");
    nodes[index] = { ...node, status: "complete", packetRef: update.packetRef };
  } else if (update.kind === "fail_node") {
    if (node.status !== "running") invalid("Only a running research node can fail.");
    nodes[index] = { ...node, status: "failed", stopReason: update.stopReason.slice(0, 200) };
  } else if (update.kind === "quarantine_node") {
    if (node.status !== "running") invalid("Only a running research node can be quarantined.");
    nodes[index] = { ...node, status: "quarantined", stopReason: update.stopReason.slice(0, 200) };
  } else {
    if (node.status !== "proposed" && node.status !== "ready" && node.status !== "blocked") invalid("Only an undispatched research node can be pruned.");
    nodes[index] = { ...node, status: "pruned", stopReason: update.stopReason.slice(0, 200) };
  }
  const unlocked = readyDependents(nodes);
  const synth = unlocked.find((candidate) => candidate.roleId === "synthesizer");
  const next: ResearchGraphV1 = {
    ...graph,
    status: synth?.status === "complete" ? "complete" : "running",
    nodes: unlocked,
  };
  validateResearchGraphV1(next);
  return next;
}
