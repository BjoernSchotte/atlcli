import { ResearchContractError, type ResearchProduct } from "./contracts.js";

export const RESEARCH_GRAPH_SCHEMA_V1 = "atlcli.research-graph/v1" as const;
export const RESEARCH_BRIEF_SCHEMA_V1 = "atlcli.research-brief/v1" as const;

export const RESEARCH_GRAPH_ROLES = [
  "jira-retrieval",
  "wiki-retrieval",
  "cross-product-join",
  "verification",
  "reconciler",
] as const;
export type ResearchGraphRoleV1 = (typeof RESEARCH_GRAPH_ROLES)[number];

export const RESEARCH_GRAPH_CAPABILITIES = [
  "jira.issue.search",
  "jira.issue.get",
  "wiki.search",
  "wiki.page.get",
  "jira.project.search",
  "wiki.space.search",
  "atlassian.reference.resolve",
] as const;
export type ResearchGraphCapabilityV1 = (typeof RESEARCH_GRAPH_CAPABILITIES)[number];

export type ResearchEffortV1 = "shallow" | "standard" | "deep";
export type ResearchReconciliationPolicyV1 = "off" | "auto" | "required";

export interface ResearchBriefV1 {
  schema: typeof RESEARCH_BRIEF_SCHEMA_V1;
  question: string;
  products: ResearchProduct[];
  effort: ResearchEffortV1;
  reconciliation: ResearchReconciliationPolicyV1;
}

export interface ResearchGraphNodeV1 {
  id: string;
  role: ResearchGraphRoleV1;
  dependsOn: string[];
  requestedCapabilityIds: ResearchGraphCapabilityV1[];
  grantedCapabilityIds: ResearchGraphCapabilityV1[];
  depth: 0;
  phase: "research" | "reconciliation";
}

export interface ResearchGraphV1 {
  schema: typeof RESEARCH_GRAPH_SCHEMA_V1;
  briefRevision: number;
  graphRevision: number;
  nodes: ResearchGraphNodeV1[];
  selectedRoleIds: ResearchGraphRoleV1[];
  maxResearchWaves: 2;
  maxReconciliationWaves: 1;
}

export interface ResearchGraphCompositionOptionsV1 {
  briefRevision?: number;
  graphRevision?: number;
  grants?: Partial<Record<ResearchGraphRoleV1, readonly ResearchGraphCapabilityV1[]>>;
}

const ROLE_CAPABILITIES: Record<ResearchGraphRoleV1, readonly ResearchGraphCapabilityV1[]> = {
  "jira-retrieval": ["jira.issue.search", "jira.issue.get"],
  "wiki-retrieval": ["wiki.search", "wiki.page.get"],
  "cross-product-join": [],
  verification: ["jira.issue.get", "wiki.page.get"],
  reconciler: [],
};

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function normalizedQuestion(question: string): string {
  if (typeof question !== "string" || question.trim() === "") invalid("Research brief question is required.");
  if (question.length > 4_000) invalid("Research brief question is too long.");
  return question.toLocaleLowerCase("en-US");
}

function hasAny(question: string, terms: readonly string[]): boolean {
  return terms.some((term) => question.includes(term));
}

function requestedRoles(brief: ResearchBriefV1): ResearchGraphRoleV1[] {
  const question = normalizedQuestion(brief.question);
  const jira = brief.products.includes("jira") || hasAny(question, ["jira", "ticket", "issue", "project"]);
  const wiki = brief.products.includes("confluence") || hasAny(question, ["confluence", "wiki", "space", "page", "content"]);
  const relation = jira && wiki && hasAny(question, [
    "related",
    "belong",
    "join",
    "link",
    "between",
    "correspond",
    "match",
    "mapping",
    "map",
    "funnel",
    "pipeline",
    "stage",
    "opportunit",
    "zuord",
    "gehören",
    "zusammenhang",
  ]);
  const roles: ResearchGraphRoleV1[] = [];
  if (jira || (!jira && !wiki)) roles.push("jira-retrieval");
  if (wiki || (!jira && !wiki)) roles.push("wiki-retrieval");
  if (relation) roles.push("cross-product-join");
  if (relation && hasAny(question, ["verify", "explicit", "contradict", "conflict", "belegt", "widerspruch"])) roles.push("verification");
  if (brief.reconciliation === "required" || (brief.reconciliation === "auto" && (relation || brief.effort === "deep"))) roles.push("reconciler");
  return roles;
}

function nodeId(role: ResearchGraphRoleV1): string {
  return `research-node:${role}`;
}

function grantFor(role: ResearchGraphRoleV1, grants: ResearchGraphCompositionOptionsV1["grants"]): ResearchGraphCapabilityV1[] {
  const requested = ROLE_CAPABILITIES[role];
  const allowed = grants?.[role];
  if (!allowed) return [...requested];
  return requested.filter((capability) => allowed.includes(capability));
}

export function composeResearchGraphV1(
  brief: ResearchBriefV1,
  options: ResearchGraphCompositionOptionsV1 = {},
): ResearchGraphV1 {
  if (brief.schema !== RESEARCH_BRIEF_SCHEMA_V1) invalid("Unsupported research brief schema.");
  const roles = requestedRoles(brief);
  const nodes = roles.map((role): ResearchGraphNodeV1 => {
    const dependsOn: string[] = role === "cross-product-join"
      ? [nodeId("jira-retrieval"), nodeId("wiki-retrieval")]
      : role === "verification"
        ? [nodeId("cross-product-join")]
        : role === "reconciler"
          ? roles.filter((candidate) => candidate !== "reconciler").map(nodeId)
          : [];
    return {
      id: nodeId(role),
      role,
      dependsOn,
      requestedCapabilityIds: [...ROLE_CAPABILITIES[role]],
      grantedCapabilityIds: grantFor(role, options.grants),
      depth: 0,
      phase: role === "reconciler" ? "reconciliation" : "research",
    };
  });
  const graph: ResearchGraphV1 = {
    schema: RESEARCH_GRAPH_SCHEMA_V1,
    briefRevision: options.briefRevision ?? 1,
    graphRevision: options.graphRevision ?? 1,
    nodes,
    selectedRoleIds: roles,
    maxResearchWaves: 2,
    maxReconciliationWaves: 1,
  };
  validateResearchGraphV1(graph);
  return graph;
}

export function validateResearchGraphV1(graph: ResearchGraphV1): void {
  if (graph.schema !== RESEARCH_GRAPH_SCHEMA_V1) invalid("Unsupported research graph schema.");
  if (!Number.isSafeInteger(graph.briefRevision) || graph.briefRevision < 1 || !Number.isSafeInteger(graph.graphRevision) || graph.graphRevision < 1) invalid("Research graph revisions are invalid.");
  if (graph.maxResearchWaves !== 2 || graph.maxReconciliationWaves !== 1) invalid("Research graph wave limits are invalid.");
  if (graph.nodes.length === 0 || graph.nodes.length > 8) invalid("Research graph node count is invalid.");
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) invalid("Research graph node IDs must be unique.");
    ids.add(node.id);
    if (!RESEARCH_GRAPH_ROLES.includes(node.role) || node.depth !== 0) invalid("Research graph role or depth is invalid.");
    if (node.dependsOn.includes(node.id)) invalid("Research graph dependencies must be acyclic.");
    if (node.dependsOn.some((dependency) => !graph.nodes.some((candidate) => candidate.id === dependency))) invalid("Research graph dependency is invalid.");
    for (const capability of node.requestedCapabilityIds) if (!RESEARCH_GRAPH_CAPABILITIES.includes(capability)) invalid("Research graph requests an unknown capability.");
    for (const capability of node.grantedCapabilityIds) if (!node.requestedCapabilityIds.includes(capability)) invalid("Research graph grants an unrequested capability.");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid("Research graph dependencies must be acyclic.");
    if (visited.has(id)) return;
    visiting.add(id);
    const node = graph.nodes.find((candidate) => candidate.id === id)!;
    node.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  graph.nodes.forEach((node) => visit(node.id));
  const derived = graph.nodes.map((node) => node.role);
  if (derived.length !== graph.selectedRoleIds.length || derived.some((role, index) => role !== graph.selectedRoleIds[index])) invalid("Selected roles must derive from executable graph nodes.");
}
