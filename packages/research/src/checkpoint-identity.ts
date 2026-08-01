import { ResearchContractError } from "./contracts.js";

/** Browser-safe representation of LangGraph's configurable checkpoint identity. */
export interface ResearchCheckpointConfigV1 {
  readonly configurable: {
    readonly thread_id: string;
    readonly checkpoint_ns: string;
    readonly checkpoint_id?: string;
  };
}

/** Stable, one-to-one LangGraph thread identity for a durable research session. */
export function researchThreadIdForSessionV1(sessionId: string): string {
  if (!/^research-session:[A-Za-z0-9._-]{1,120}$/.test(sessionId)) {
    throw new ResearchContractError("invalid-request", "Research session ID is invalid for LangGraph checkpointing.");
  }
  return `atlcli:research:${sessionId}`;
}

export function researchCheckpointConfigV1(input: {
  sessionId: string;
  checkpointNamespace?: string;
  checkpointId?: string;
}): ResearchCheckpointConfigV1 {
  const checkpointNamespace = input.checkpointNamespace ?? "";
  if (typeof checkpointNamespace !== "string" || checkpointNamespace.length > 200 || /[\u0000\r\n]/.test(checkpointNamespace)) {
    throw new ResearchContractError("invalid-request", "Research checkpoint namespace is invalid.");
  }
  if (input.checkpointId !== undefined && (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.checkpointId))) {
    throw new ResearchContractError("invalid-request", "Research checkpoint ID is invalid.");
  }
  return {
    configurable: {
      thread_id: researchThreadIdForSessionV1(input.sessionId),
      checkpoint_ns: checkpointNamespace,
      ...(input.checkpointId ? { checkpoint_id: input.checkpointId } : {}),
    },
  };
}
