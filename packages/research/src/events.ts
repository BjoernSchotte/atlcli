import {
  RESEARCH_REPORT_ARTIFACT_PATH_V1,
  RESEARCH_CAPABILITY_EVENT_TOOL_IDS_V1,
  RESEARCH_REQUESTED_EFFORTS_V1,
  type ResearchOneShotEventV1,
} from "./contracts.js";

const boundedToken = (value: unknown, maximum = 200): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  /^[A-Za-z0-9._:-]+$/.test(value);

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const optionalNonNegativeInteger = (value: unknown): boolean =>
  value === undefined || nonNegativeInteger(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const RESEARCH_PLAN_EVENT_STATUSES_V1 = [
  "proposed",
  "approved",
  "approved-envelope",
  "accepted",
] as const;

const tokenArray = (value: unknown, maximumItems = 32): value is string[] =>
  Array.isArray(value) &&
  value.length <= maximumItems &&
  value.every((entry) => boundedToken(entry));

/**
 * Validate the body-free, bounded event payload at every CLI/browser realm
 * boundary. Source bodies, prompts, provider payloads, workflow code and
 * hidden model reasoning are deliberately not representable in this union.
 */
export function isResearchOneShotEventV1(value: unknown): value is ResearchOneShotEventV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!positiveInteger(event.seq) ||
    typeof event.at !== "string" ||
    event.at.length > 64 ||
    !Number.isFinite(Date.parse(event.at))) return false;

  if (event.kind === "phase") {
    return hasOnlyKeys(event, ["kind", "seq", "at", "phase"]) && boundedToken(event.phase, 64);
  }
  if (event.kind === "progress") {
    return hasOnlyKeys(event, ["kind", "seq", "at", "graphRevision", "completed", "maximum"]) &&
      positiveInteger(event.graphRevision) &&
      nonNegativeInteger(event.completed) &&
      nonNegativeInteger(event.maximum) &&
      Number(event.maximum) >= Number(event.completed);
  }
  if (event.kind === "brief") {
    return hasOnlyKeys(event, ["kind", "seq", "at", "revision"]) && positiveInteger(event.revision);
  }
  if (event.kind === "plan") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "briefRevision", "revision", "status",
      "resolvedEffort", "selectedRoleIds", "nodeCount", "waveCount", "maxParallelNodes",
    ]) &&
      positiveInteger(event.briefRevision) &&
      positiveInteger(event.revision) &&
      RESEARCH_PLAN_EVENT_STATUSES_V1.includes(
        event.status as (typeof RESEARCH_PLAN_EVENT_STATUSES_V1)[number],
      ) &&
      RESEARCH_REQUESTED_EFFORTS_V1.includes(
        event.resolvedEffort as (typeof RESEARCH_REQUESTED_EFFORTS_V1)[number],
      ) &&
      event.resolvedEffort !== "auto" &&
      tokenArray(event.selectedRoleIds, 16) &&
      nonNegativeInteger(event.nodeCount) &&
      nonNegativeInteger(event.waveCount) &&
      positiveInteger(event.maxParallelNodes);
  }
  if (event.kind === "task") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "taskId", "status", "roleId", "wave",
      "dependencyTaskIds", "grantedCapabilityIds", "resultBytes", "capabilityCalls",
      "inputTokens", "outputTokens", "sourceCount", "findingCount",
      "relationshipCount", "gapCount", "defectCount",
    ]) &&
      boundedToken(event.taskId) &&
      ["planned", "packet-accepted"].includes(String(event.status)) &&
      (event.roleId === undefined || boundedToken(event.roleId)) &&
      (event.wave === undefined || positiveInteger(event.wave)) &&
      (event.dependencyTaskIds === undefined || tokenArray(event.dependencyTaskIds, 16)) &&
      (event.grantedCapabilityIds === undefined || tokenArray(event.grantedCapabilityIds, 12)) &&
      optionalNonNegativeInteger(event.resultBytes) &&
      optionalNonNegativeInteger(event.capabilityCalls) &&
      optionalNonNegativeInteger(event.inputTokens) &&
      optionalNonNegativeInteger(event.outputTokens) &&
      optionalNonNegativeInteger(event.sourceCount) &&
      optionalNonNegativeInteger(event.findingCount) &&
      optionalNonNegativeInteger(event.relationshipCount) &&
      optionalNonNegativeInteger(event.gapCount) &&
      optionalNonNegativeInteger(event.defectCount);
  }
  if (event.kind === "subagent") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "taskId", "roleId", "status", "attempt",
      "durationMs", "errorCode",
    ]) &&
      boundedToken(event.taskId) &&
      boundedToken(event.roleId) &&
      ["started", "repairing", "completed", "failed", "cancelled", "quarantined", "rejected"]
        .includes(String(event.status)) &&
      (event.attempt === undefined || positiveInteger(event.attempt)) &&
      optionalNonNegativeInteger(event.durationMs) &&
      (event.errorCode === undefined || boundedToken(event.errorCode));
  }
  if (event.kind === "capability") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "callId", "toolId", "inputKind", "status",
      "itemCount", "complete", "termination", "resultBytes", "truncated",
      "durationMs", "errorCode", "inputKeys", "queryKeys",
    ]) &&
      boundedToken(event.callId) &&
      RESEARCH_CAPABILITY_EVENT_TOOL_IDS_V1.includes(
        event.toolId as (typeof RESEARCH_CAPABILITY_EVENT_TOOL_IDS_V1)[number],
      ) &&
      ["search", "continuation", "detail", "reference", "ranking"].includes(String(event.inputKind)) &&
      ["started", "completed", "failed"].includes(String(event.status)) &&
      optionalNonNegativeInteger(event.itemCount) &&
      (event.complete === undefined || typeof event.complete === "boolean") &&
      (event.termination === undefined || boundedToken(event.termination)) &&
      optionalNonNegativeInteger(event.resultBytes) &&
      (event.truncated === undefined || typeof event.truncated === "boolean") &&
      optionalNonNegativeInteger(event.durationMs) &&
      (event.errorCode === undefined || boundedToken(event.errorCode)) &&
      (event.inputKeys === undefined || tokenArray(event.inputKeys, 12)) &&
      (event.queryKeys === undefined || tokenArray(event.queryKeys, 12));
  }
  if (event.kind === "decision") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "decisionId", "status", "reasonCode", "taskId",
      "errorCode", "codeBytes", "codeHash",
    ]) &&
      boundedToken(event.decisionId) &&
      ["started", "completed", "failed"].includes(String(event.status)) &&
      boundedToken(event.reasonCode) &&
      (event.taskId === undefined || boundedToken(event.taskId)) &&
      (event.errorCode === undefined || boundedToken(event.errorCode)) &&
      optionalNonNegativeInteger(event.codeBytes) &&
      (event.codeHash === undefined || boundedToken(event.codeHash));
  }
  if (event.kind === "reconciliation") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "taskId", "status", "defectCount", "proposedFollowUpCount",
    ]) &&
      boundedToken(event.taskId) &&
      ["started", "completed", "failed"].includes(String(event.status)) &&
      optionalNonNegativeInteger(event.defectCount) &&
      optionalNonNegativeInteger(event.proposedFollowUpCount);
  }
  if (event.kind === "reconciliation_disposition") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "dispositionId", "defectId", "decision", "reasonCode", "status",
    ]) &&
      boundedToken(event.dispositionId) &&
      boundedToken(event.defectId) &&
      ["reject_defect", "revise", "downgrade", "add_follow_up", "abstain", "no_change"]
        .includes(String(event.decision)) &&
      [
        "invalid_reference", "already_resolved", "supported_by_evidence",
        "material_defect", "insufficient_budget", "outside_approval_envelope",
      ].includes(String(event.reasonCode)) &&
      event.status === "recorded";
  }
  if (event.kind === "repair_group") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "followUpId", "taskId", "status", "reasonCode",
    ]) &&
      boundedToken(event.followUpId) &&
      (event.taskId === undefined || boundedToken(event.taskId)) &&
      ["authorized", "retained_without_execution", "completed"].includes(String(event.status)) &&
      ["accepted_follow_up", "wave_or_budget_exhausted", "packet_accepted"]
        .includes(String(event.reasonCode));
  }
  if (event.kind === "retrieval") {
    return hasOnlyKeys(event, [
      "kind", "seq", "at", "graphRevision", "action", "reason",
      "rankedCandidateCount", "detailReadCount", "newDetailSourceCount",
      "duplicateDetailReadCount", "unresolvedCoverageTargetCount",
      "unresolvedContradictionCount",
    ]) &&
      positiveInteger(event.graphRevision) &&
      ["continue", "replan", "stop"].includes(String(event.action)) &&
      boundedToken(event.reason) &&
      nonNegativeInteger(event.rankedCandidateCount) &&
      nonNegativeInteger(event.detailReadCount) &&
      nonNegativeInteger(event.newDetailSourceCount) &&
      nonNegativeInteger(event.duplicateDetailReadCount) &&
      nonNegativeInteger(event.unresolvedCoverageTargetCount) &&
      nonNegativeInteger(event.unresolvedContradictionCount);
  }
  if (event.kind === "steering") {
    return hasOnlyKeys(event, ["kind", "seq", "at", "revision", "status"]) &&
      positiveInteger(event.revision) &&
      event.status === "applied";
  }
  if (event.kind === "budget") {
    return hasOnlyKeys(event, ["kind", "seq", "at", "metric", "consumed", "maximum"]) &&
      ["capability_calls", "tokens", "bytes", "duration_ms", "cost_micros"]
        .includes(String(event.metric)) &&
      nonNegativeInteger(event.consumed) &&
      nonNegativeInteger(event.maximum);
  }
  return event.kind === "artifact" &&
    hasOnlyKeys(event, ["kind", "seq", "at", "path"]) &&
    event.path === RESEARCH_REPORT_ARTIFACT_PATH_V1;
}

const decisionSummary = (reasonCode: string): string => {
  switch (reasonCode) {
    case "generate-and-orchestrate-workflow": return "supervisor is composing the accepted workflow";
    case "workflow-returned-for-validation": return "workflow returned; host validation begins";
    case "validate-before-render": return "host is validating evidence before rendering";
    case "validated-before-render": return "evidence validation passed";
    case "supervisor-eval": return "supervisor workflow evaluation";
    case "supervisor-eval-completed": return "supervisor workflow evaluation completed";
    case "pre-dispatch-eval-repair": return "workflow code repair before any task dispatch";
    case "pre-dispatch-eval-repaired": return "workflow code repair completed";
    case "authoritative-schema-rejected": return "typed result rejected; bounded format repair started";
    default: return reasonCode.replaceAll("-", " ");
  }
};

/** Render a detailed operator trace without source bodies or hidden reasoning. */
export function formatResearchOneShotEventV1(event: ResearchOneShotEventV1): string {
  switch (event.kind) {
    case "phase": return `phase · ${event.phase}`;
    case "progress": return `progress · graph ${event.graphRevision} · calls ${event.completed}/${event.maximum}`;
    case "brief": return `brief · revision ${event.revision}`;
    case "plan": return [
      `plan · graph ${event.revision}`,
      event.status,
      `effort ${event.resolvedEffort}`,
      `${event.nodeCount} nodes in ${event.waveCount} waves`,
      `parallel ≤ ${event.maxParallelNodes}`,
      `roles ${event.selectedRoleIds.join(", ") || "none"}`,
    ].join(" · ");
    case "task": return [
      `task · ${event.taskId}`,
      event.roleId ?? "host",
      event.status,
      event.wave === undefined ? "" : `wave ${event.wave}`,
      event.dependencyTaskIds === undefined ? "" : `deps ${event.dependencyTaskIds.length}`,
      event.grantedCapabilityIds === undefined ? "" : `tools ${event.grantedCapabilityIds.join(", ") || "none"}`,
      event.sourceCount === undefined ? "" : `${event.sourceCount} sources`,
      event.findingCount === undefined ? "" : `${event.findingCount} findings`,
      event.relationshipCount === undefined ? "" : `${event.relationshipCount} relationships`,
      event.gapCount === undefined ? "" : `${event.gapCount} gaps`,
      event.defectCount === undefined ? "" : `${event.defectCount} defects`,
      event.inputTokens === undefined ? "" : `${event.inputTokens} input tokens`,
      event.outputTokens === undefined ? "" : `${event.outputTokens} output tokens`,
      event.resultBytes === undefined ? "" : `${event.resultBytes} bytes`,
    ].filter(Boolean).join(" · ");
    case "subagent": return [
      `agent · ${event.roleId}`,
      event.taskId,
      event.status,
      event.attempt === undefined ? "" : `attempt ${event.attempt}`,
      event.durationMs === undefined ? "" : `${event.durationMs} ms`,
      event.errorCode ?? "",
    ].filter(Boolean).join(" · ");
    case "capability": return [
      `tool · ${event.toolId}`,
      event.callId,
      event.inputKind,
      event.status,
      event.inputKeys === undefined ? "" : `input {${event.inputKeys.join(", ")}}`,
      event.queryKeys === undefined ? "" : `query {${event.queryKeys.join(", ")}}`,
      event.itemCount === undefined ? "" : `${event.itemCount} items`,
      event.complete === undefined ? "" : `complete ${event.complete}`,
      event.termination ?? "",
      event.resultBytes === undefined ? "" : `${event.resultBytes} bytes`,
      event.truncated === undefined ? "" : `truncated ${event.truncated}`,
      event.durationMs === undefined ? "" : `${event.durationMs} ms`,
      event.errorCode ?? "",
    ].filter(Boolean).join(" · ");
    case "decision": return [
      `decision · ${event.decisionId}`,
      event.status,
      decisionSummary(event.reasonCode),
      event.codeBytes === undefined ? "" : `${event.codeBytes} code bytes`,
      event.codeHash ?? "",
      event.errorCode ?? "",
    ].filter(Boolean).join(" · ");
    case "reconciliation": return [
      `critique · ${event.taskId}`,
      event.status,
      event.defectCount === undefined ? "" : `${event.defectCount} defects`,
      event.proposedFollowUpCount === undefined ? "" : `${event.proposedFollowUpCount} follow-ups`,
    ].filter(Boolean).join(" · ");
    case "reconciliation_disposition": return [
      `disposition · ${event.defectId}`,
      event.decision,
      event.reasonCode,
      event.status,
    ].join(" · ");
    case "repair_group": return [
      `repair · ${event.followUpId}`,
      event.status,
      event.reasonCode,
      event.taskId ?? "",
    ].filter(Boolean).join(" · ");
    case "retrieval": return [
      `retrieval · graph ${event.graphRevision}`,
      event.action,
      event.reason.replaceAll("_", " "),
      `${event.rankedCandidateCount} ranked`,
      `${event.detailReadCount} detail reads`,
      `${event.newDetailSourceCount} new`,
      event.duplicateDetailReadCount === 0 ? "" : `${event.duplicateDetailReadCount} duplicates`,
      event.unresolvedCoverageTargetCount === 0 ? "" : `${event.unresolvedCoverageTargetCount} coverage gaps`,
      event.unresolvedContradictionCount === 0 ? "" : `${event.unresolvedContradictionCount} contradictions`,
    ].filter(Boolean).join(" · ");
    case "steering": return `steering · graph ${event.revision} · ${event.status}`;
    case "budget": return `budget · ${event.metric} · ${event.consumed}/${event.maximum}`;
    case "artifact": return `artifact · ${event.path}`;
  }
}
