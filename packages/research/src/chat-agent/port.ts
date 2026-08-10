import type { ResearchOneShotEventV1, ResearchRequestV1 } from "../contracts.js";
import type { ChatQualityPolicyV1 } from "../quality-policy.js";
import type { ChatActivityEventV1 } from "./activity.js";
import type { ChatAnswerV1, ChatCitationV1 } from "./contracts.js";
import type {
  ChatInteractionCommandV1,
  ChatInteractionStateV1,
  ChatUserQuestionAnswerV1,
  ChatUserQuestionV1,
} from "./interaction.js";
import type {
  ChatAnswerFeedbackReasonCodeV1,
  ChatAnswerFeedbackRatingV1,
  ChatAnswerFeedbackV1,
} from "./feedback.js";

/** Ephemeral callbacks for one active Chat turn. They are never durable authority. */
export interface ChatAgentStreamV1 {
  signal?: AbortSignal;
  onSessionStart?: (session: { conversationId: string; turnId: string }) => void;
  onEvent?: (event: ResearchOneShotEventV1) => void;
  onPresentation?: (
    event: import("../contracts.js").ChatPresentationStreamEventV1,
  ) => void;
}

/** The only presenter-owned fields accepted when starting a new Chat turn. */
export interface ChatAgentStartTurnV1 {
  request: ResearchRequestV1;
  qualityPolicy: ChatQualityPolicyV1;
  /** Omit to let the host create a new durable conversation. */
  conversationId?: string;
}

/** A durable checkpoint identity. Request, scope and quality remain host-owned. */
export interface ChatAgentCheckpointV1 {
  siteOrigin: string;
  conversationId: string;
  turnId: string;
}

export interface ChatAgentResumeTurnV1 extends ChatAgentCheckpointV1 {
  kind: "stream-interruption" | "steering";
}

export interface ChatAgentAnswerQuestionV1 extends ChatAgentCheckpointV1 {
  answer: ChatUserQuestionAnswerV1;
}

export interface ChatAgentSubmitFeedbackV1 extends ChatAgentCheckpointV1 {
  rating: ChatAnswerFeedbackRatingV1;
  reasonCodes?: readonly ChatAnswerFeedbackReasonCodeV1[];
}

export interface ChatConversationHistoryItemV1 {
  conversationId: string;
  updatedAt: string;
  latestTurnId?: string;
  latestObjective?: string;
  status?: "running" | "complete" | "failed" | "cancelled" | "waiting";
}

export interface ChatConversationReplayV1 {
  conversationId: string;
  turnId: string;
  objective: string;
  events: ChatActivityEventV1[];
  finalAnswer?: ChatAnswerV1;
}

export interface ChatTurnArtifactV1 {
  conversationId: string;
  turnId: string;
  mediaType: "text/markdown";
  markdown: string;
}

/** Source access is metadata-only; content remains behind approved capabilities. */
export interface ChatTurnSourcesV1 {
  conversationId: string;
  turnId: string;
  sources: ChatCitationV1[];
}

/**
 * One host-neutral ordinary-Chat product boundary.
 *
 * CLI, MV3 and ordinary-browser presenters may request actions through this
 * port, but they cannot submit a workflow, capability grant, evidence record,
 * provider credential, retry budget, or replacement scope on resume.
 */
export interface ChatAgentPortV1 {
  startTurn(
    input: ChatAgentStartTurnV1,
    stream?: ChatAgentStreamV1,
  ): Promise<ChatAnswerV1>;
  answerQuestion(
    input: ChatAgentAnswerQuestionV1,
    stream?: ChatAgentStreamV1,
  ): Promise<ChatAnswerV1>;
  resumeTurn(
    input: ChatAgentResumeTurnV1,
    stream?: ChatAgentStreamV1,
  ): Promise<ChatAnswerV1>;
  getPendingQuestion(siteOrigin: string): Promise<{
    conversationId: string;
    turnId: string;
    question: ChatUserQuestionV1;
  } | null>;
  getInteraction(siteOrigin: string): Promise<ChatInteractionStateV1 | null>;
  control(command: ChatInteractionCommandV1): Promise<ChatInteractionStateV1>;
  stop(): Promise<"stop_requested" | "stopped">;
  listHistory(siteOrigin: string): Promise<ChatConversationHistoryItemV1[]>;
  replay(input: {
    siteOrigin: string;
    conversationId?: string;
  }): Promise<ChatConversationReplayV1 | null>;
  artifact(input: ChatAgentCheckpointV1): Promise<ChatTurnArtifactV1 | null>;
  sources(input: ChatAgentCheckpointV1): Promise<ChatTurnSourcesV1 | null>;
  submitFeedback(input: ChatAgentSubmitFeedbackV1): Promise<ChatAnswerFeedbackV1>;
  resetConversation(): Promise<void>;
}

/** Preserve method identity while preventing host adapters from growing ad hoc fields. */
export function defineChatAgentPortV1(port: ChatAgentPortV1): ChatAgentPortV1 {
  return Object.freeze({
    startTurn: port.startTurn.bind(port),
    answerQuestion: port.answerQuestion.bind(port),
    resumeTurn: port.resumeTurn.bind(port),
    getPendingQuestion: port.getPendingQuestion.bind(port),
    getInteraction: port.getInteraction.bind(port),
    control: port.control.bind(port),
    stop: port.stop.bind(port),
    listHistory: port.listHistory.bind(port),
    replay: port.replay.bind(port),
    artifact: port.artifact.bind(port),
    sources: port.sources.bind(port),
    submitFeedback: port.submitFeedback.bind(port),
    resetConversation: port.resetConversation.bind(port),
  });
}
