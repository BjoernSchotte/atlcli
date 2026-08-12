import {
  ResearchContractError,
  type ChatAgentPortV1,
  type ChatAnswerV1,
  type ChatUserQuestionAnswerV1,
  type ResearchPort,
  type ResearchRequestV1,
  type ChatQualityPolicyV1,
} from "@atlcli/research";

export interface BrowserChatTurnInputV1 {
  request: ResearchRequestV1;
  qualityPolicy: ChatQualityPolicyV1;
  conversationId?: string;
  resumeAnswer?: ChatUserQuestionAnswerV1;
  resumeCheckpoint?: { turnId: string; kind: "stream-interruption" | "steering" };
}

export interface BrowserChatTurnPortV1 extends Pick<ChatAgentPortV1, "startTurn" | "stop"> {
  execute(
    input: BrowserChatTurnInputV1,
    stream?: Parameters<ChatAgentPortV1["startTurn"]>[1],
  ): Promise<ChatAnswerV1>;
}

/** Shared ordinary-Chat start/stop adapter for sidebar and background hosts. */
export function createBrowserChatTurnPortV1(
  run: ResearchPort["run"],
): BrowserChatTurnPortV1 {
  let activeController: AbortController | null = null;

  const execute = async (
    input: BrowserChatTurnInputV1,
    stream?: Parameters<ChatAgentPortV1["startTurn"]>[1],
  ): Promise<ChatAnswerV1> => {
    if (activeController) {
      throw new ResearchContractError("invalid-request", "A Chat turn is already active.");
    }
    const controller = new AbortController();
    activeController = controller;
    const forwardAbort = (): void => controller.abort(stream?.signal?.reason);
    stream?.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (stream?.signal?.aborted) forwardAbort();
    try {
      const result = await run(input.request, {
        mode: "chat",
        signal: controller.signal,
        qualityPolicy: input.qualityPolicy,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.resumeAnswer && input.resumeCheckpoint
          ? { chatResume: { turnId: input.resumeCheckpoint.turnId, answer: input.resumeAnswer } }
          : {}),
        ...(!input.resumeAnswer && input.resumeCheckpoint
          ? { chatCheckpointResume: input.resumeCheckpoint }
          : {}),
        onSessionStart: (session) => {
          if (!session.turnId) return;
          stream?.onSessionStart?.({
            conversationId: session.sessionId,
            turnId: session.turnId,
          });
        },
        onEvent: stream?.onEvent,
        onChatPresentation: stream?.onPresentation,
      });
      if (result.schema !== "atlcli.chat-answer/v1") {
        throw new ResearchContractError("invalid-report", "The Chat host returned a Research report.");
      }
      return result;
    } finally {
      stream?.signal?.removeEventListener("abort", forwardAbort);
      if (activeController === controller) activeController = null;
    }
  };

  return {
    execute,
    startTurn: (input, stream) => execute(input, stream),
    async stop() {
      if (!activeController) return "stopped";
      activeController.abort(new DOMException("The Chat turn was stopped.", "AbortError"));
      return "stop_requested";
    },
  };
}
