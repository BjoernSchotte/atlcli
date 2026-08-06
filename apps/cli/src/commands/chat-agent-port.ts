import {
  CHAT_INTERACTION_STATE_PATH_V1,
  CHAT_SESSION_PATH_V1,
  ChatContractError,
  WorkspaceChatActivityJournalV1,
  WorkspaceChatInteractionControllerV1,
  applyChatInteractionControlV1,
  assertChatInteractionBindingV1,
  assertChatSessionBindingV1,
  bindChatSteeringResumeV1,
  defineChatAgentPortV1,
  parseChatInteractionStateV1,
  parseChatSessionV1,
  stampChatInteractionCommandV1,
  type ChatAgentPortV1,
  type ChatAgentStreamV1,
  type ChatAnswerV1,
  type ChatHostIdentityV1,
  type ChatQualityPolicyV1,
  type ChatResumeEnvelopeV1,
  type ChatUserQuestionAnswerV1,
  type ResearchRequestV1,
  type ResearchSessionStoreV1,
  type ResearchWorkspace,
} from "@atlcli/research/node";

export interface CliChatAgentExecutionV1 {
  request: ResearchRequestV1;
  qualityPolicy: ChatQualityPolicyV1;
  conversationId: string;
  turnId: string;
  resumeAnswer?: ChatUserQuestionAnswerV1;
  resumeCheckpoint?: { kind: "stream-interruption" | "steering" };
  signal: AbortSignal;
  stream?: ChatAgentStreamV1;
  onInteractionReady?(controller: WorkspaceChatInteractionControllerV1): void;
  onResumeEnvelopeReady?(resume: ChatResumeEnvelopeV1): void;
}

export interface CliChatAgentPortBindingsV1 {
  store: ResearchSessionStoreV1;
  workspace: ResearchWorkspace;
  conversationId: string;
  siteOrigin: string;
  hostIdentity: ChatHostIdentityV1;
  createTurnId(): string;
  execute(input: CliChatAgentExecutionV1): Promise<ChatAnswerV1>;
  now?(): Date;
}

function binding(input: CliChatAgentPortBindingsV1) {
  return {
    ...input.hostIdentity,
    threadId: input.conversationId,
    tenantOrigin: input.siteOrigin,
  };
}

async function readInteraction(
  input: CliChatAgentPortBindingsV1,
): Promise<ReturnType<typeof parseChatInteractionStateV1> | null> {
  const raw = await input.workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1);
  if (raw === undefined) return null;
  const state = parseChatInteractionStateV1(JSON.parse(raw));
  assertChatInteractionBindingV1({
    state,
    conversationId: input.conversationId,
    binding: binding(input),
  });
  return state;
}

async function readConversation(input: {
  store: ResearchSessionStoreV1;
  conversationId: string;
  siteOrigin: string;
  hostIdentity: ChatHostIdentityV1;
}) {
  const workspace = await input.store.workspace(input.conversationId);
  const raw = await workspace.readFile(CHAT_SESSION_PATH_V1);
  if (raw === undefined) return null;
  const session = parseChatSessionV1(JSON.parse(raw));
  assertChatSessionBindingV1({
    session,
    conversationId: input.conversationId,
    identity: input.hostIdentity,
    tenantOrigin: input.siteOrigin,
  });
  return { session, workspace };
}

/**
 * CLI adapter for the same ordinary-Chat product port used by browser shapes.
 * Provider credentials, scope authority and durable resume envelopes stay in
 * this host binding; a CLI presenter can submit only the portable port inputs.
 */
export function createCliChatAgentPortV1(
  input: CliChatAgentPortBindingsV1,
): ChatAgentPortV1 {
  let activeController: AbortController | null = null;
  let activeInteractions: WorkspaceChatInteractionControllerV1 | null = null;
  let activeResume: { turnId: string; resume: ChatResumeEnvelopeV1 } | null = null;

  const execute = async (
    execution: Omit<CliChatAgentExecutionV1, "signal" | "stream">,
    stream?: ChatAgentStreamV1,
  ): Promise<ChatAnswerV1> => {
    if (activeController) throw new Error("A Chat turn is already active.");
    const controller = new AbortController();
    activeController = controller;
    const forwardAbort = (): void => controller.abort(stream?.signal?.reason);
    stream?.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (stream?.signal?.aborted) forwardAbort();
    stream?.onSessionStart?.({
      conversationId: execution.conversationId,
      turnId: execution.turnId,
    });
    try {
      return await input.execute({
        ...execution,
        signal: controller.signal,
        ...(stream ? { stream } : {}),
        onInteractionReady(interactions) {
          if (activeController === controller) activeInteractions = interactions;
        },
        onResumeEnvelopeReady(resume) {
          if (activeController === controller) {
            activeResume = { turnId: execution.turnId, resume };
          }
        },
      });
    } finally {
      stream?.signal?.removeEventListener("abort", forwardAbort);
      if (activeController === controller) {
        activeController = null;
        activeInteractions = null;
        activeResume = null;
      }
    }
  };

  const assertCheckpoint = (checkpoint: {
    siteOrigin: string;
    conversationId: string;
  }): void => {
    if (
      checkpoint.siteOrigin !== input.siteOrigin ||
      checkpoint.conversationId !== input.conversationId
    ) {
      throw new Error("The Chat checkpoint belongs to a different conversation or tenant.");
    }
  };

  return defineChatAgentPortV1({
    startTurn(start, stream) {
      const conversationId = start.conversationId ?? input.conversationId;
      if (conversationId !== input.conversationId) {
        throw new Error("The CLI Chat port cannot replace its durable conversation.");
      }
      return execute({
        request: start.request,
        qualityPolicy: start.qualityPolicy,
        conversationId,
        turnId: input.createTurnId(),
      }, stream);
    },
    async answerQuestion(answer, stream) {
      assertCheckpoint(answer);
      const interaction = await readInteraction(input);
      const pending = interaction?.pendingQuestion;
      if (!pending || pending.turnId !== answer.turnId) {
        throw new Error("The Chat question checkpoint is stale.");
      }
      return execute({
        request: pending.resume.request,
        qualityPolicy: pending.resume.qualityPolicy,
        conversationId: input.conversationId,
        turnId: pending.turnId,
        resumeAnswer: answer.answer,
      }, stream);
    },
    async resumeTurn(resume, stream) {
      assertCheckpoint(resume);
      const interaction = await readInteraction(input);
      const checkpoint = resume.kind === "stream-interruption"
        ? interaction?.streamInterruption
        : interaction?.acceptedSteering;
      if (!checkpoint || checkpoint.turnId !== resume.turnId) {
        throw new Error("The Chat continuation checkpoint is stale.");
      }
      return execute({
        request: checkpoint.resume.request,
        qualityPolicy: checkpoint.resume.qualityPolicy,
        conversationId: input.conversationId,
        turnId: checkpoint.turnId,
        resumeCheckpoint: { kind: resume.kind },
      }, stream);
    },
    async getPendingQuestion(siteOrigin) {
      if (siteOrigin !== input.siteOrigin) return null;
      const pending = (await readInteraction(input))?.pendingQuestion;
      return pending
        ? {
            conversationId: input.conversationId,
            turnId: pending.turnId,
            question: pending.question,
          }
        : null;
    },
    async getInteraction(siteOrigin) {
      return siteOrigin === input.siteOrigin ? readInteraction(input) : null;
    },
    async control(command) {
      const at = (input.now?.() ?? new Date()).toISOString();
      const controller = activeInteractions ??
        await WorkspaceChatInteractionControllerV1.bind({
          workspace: input.workspace,
          conversationId: input.conversationId,
          binding: binding(input),
          at,
        });
      let steeringRequested = false;
      const next = await controller.update((state) => {
        const controlled = applyChatInteractionControlV1(
          state,
          stampChatInteractionCommandV1(command, at),
        );
        if (command.kind !== "steer") return controlled;
        if (!activeResume) {
          throw new ChatContractError(
            "invalid-request",
            "The active Chat turn cannot bind a steering checkpoint.",
          );
        }
        steeringRequested = true;
        return bindChatSteeringResumeV1({
          state: controlled,
          expectedRevision: controlled.revision,
          steeringId: command.steeringId,
          expectedSteeringRevision: controlled.pendingSteering!.revision,
          turnId: activeResume.turnId,
          resume: activeResume.resume,
          at,
        });
      });
      if (steeringRequested && activeController && !activeController.signal.aborted) {
        activeController.abort(new ChatContractError(
          "paused",
          "The Chat turn reached its durable steering checkpoint.",
        ));
      }
      return next;
    },
    async stop() {
      if (!activeController) return "stopped";
      activeController.abort(new DOMException("The Chat turn was stopped.", "AbortError"));
      return "stop_requested";
    },
    async listHistory(siteOrigin) {
      if (siteOrigin !== input.siteOrigin) return [];
      const result = [];
      let cursor: string | undefined;
      do {
        const page = await input.store.list({ limit: 100, ...(cursor ? { cursor } : {}) });
        for (const candidate of page.sessions) {
          try {
            const projection = await readConversation({
              store: input.store,
              conversationId: candidate.sessionId,
              siteOrigin,
              hostIdentity: input.hostIdentity,
            });
            const latest = projection?.session.conversation.recentTurns.at(-1);
            if (!projection) continue;
            result.push({
              conversationId: candidate.sessionId,
              updatedAt: projection.session.updatedAt,
              ...(latest
                ? {
                    latestTurnId: latest.id,
                    latestObjective: latest.objective,
                    status: latest.status,
                  }
                : {}),
            });
          } catch {
            // Foreign principals, tenants and non-Chat sessions stay invisible.
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async replay(replay) {
      if (replay.siteOrigin !== input.siteOrigin) return null;
      const conversationId = replay.conversationId ?? input.conversationId;
      let projection;
      try {
        projection = await readConversation({
          store: input.store,
          conversationId,
          siteOrigin: replay.siteOrigin,
          hostIdentity: input.hostIdentity,
        });
      } catch {
        return null;
      }
      const turn = projection?.session.conversation.recentTurns.at(-1);
      if (!projection || !turn) return null;
      const journal = await WorkspaceChatActivityJournalV1.open({
        workspace: projection.workspace,
        conversationId,
        persistIfMissing: false,
      });
      return {
        conversationId,
        turnId: turn.id,
        objective: turn.objective,
        events: journal.eventsForReferences(turn.activityRefs),
        ...(turn.finalAnswer ? { finalAnswer: turn.finalAnswer } : {}),
      };
    },
    async artifact(checkpoint) {
      assertCheckpoint(checkpoint);
      const projection = await readConversation({
        store: input.store,
        conversationId: checkpoint.conversationId,
        siteOrigin: checkpoint.siteOrigin,
        hostIdentity: input.hostIdentity,
      });
      const answer = projection?.session.conversation.recentTurns.find((turn) =>
        turn.id === checkpoint.turnId
      )?.finalAnswer;
      return answer
        ? {
            conversationId: checkpoint.conversationId,
            turnId: checkpoint.turnId,
            mediaType: "text/markdown",
            markdown: answer.messageMarkdown,
          }
        : null;
    },
    async sources(checkpoint) {
      assertCheckpoint(checkpoint);
      const projection = await readConversation({
        store: input.store,
        conversationId: checkpoint.conversationId,
        siteOrigin: checkpoint.siteOrigin,
        hostIdentity: input.hostIdentity,
      });
      const answer = projection?.session.conversation.recentTurns.find((turn) =>
        turn.id === checkpoint.turnId
      )?.finalAnswer;
      return answer
        ? {
            conversationId: checkpoint.conversationId,
            turnId: checkpoint.turnId,
            sources: structuredClone(answer.citations),
          }
        : null;
    },
    async resetConversation() {
      // The one-shot CLI has no mutable active-conversation pointer.
    },
  });
}
