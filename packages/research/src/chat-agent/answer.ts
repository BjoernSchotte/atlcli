import type { ResearchDetailEvidenceV1 } from "../broker.js";
import type { ResearchSourceReferenceV1 } from "../contracts.js";
import type { ChatQualityPolicyV1 } from "../quality-policy.js";
import {
  CHAT_ANSWER_SCHEMA_V1,
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  ChatContractError,
  type ChatAgentDraftV1,
  type ChatAnswerV1,
  type ChatRunSummaryV1,
} from "./contracts.js";

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\[\]]/gu, "\\$&");
}

export function finalizeChatAnswerV1(input: {
  draft: unknown;
  sources: readonly ResearchSourceReferenceV1[];
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  qualityPolicy: ChatQualityPolicyV1;
  run: ChatRunSummaryV1;
}): ChatAnswerV1 {
  const parsed = CHAT_AGENT_DRAFT_SCHEMA_V1.safeParse(input.draft);
  if (!parsed.success) {
    throw new ChatContractError("invalid-report", "The Chat answer did not match the required contract.");
  }
  const draft: ChatAgentDraftV1 = parsed.data;
  const detailedIds = new Set(input.detailEvidence.map((entry) => entry.source.id));
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const citationIds = [...new Set(draft.citationSourceIds)];
  for (const sourceId of citationIds) {
    if (!detailedIds.has(sourceId) || !sourceById.has(sourceId)) {
      throw new ChatContractError("invalid-report", "The Chat answer cites a source that was not read in detail.");
    }
  }
  for (const gap of draft.gaps) {
    if (gap.sourceIds.some((sourceId) => !sourceById.has(sourceId))) {
      throw new ChatContractError("invalid-report", "The Chat answer gap references unknown evidence.");
    }
  }
  let messageMarkdown = draft.messageMarkdown.trim();
  const placeholderIds = [...messageMarkdown.matchAll(/\[\[source:([^\]]+)\]\]/gu)]
    .map((match) => match[1]!);
  if (placeholderIds.some((sourceId) => !citationIds.includes(sourceId))) {
    throw new ChatContractError("invalid-report", "The Chat answer contains an unsupported citation placeholder.");
  }
  if (citationIds.some((sourceId) => !placeholderIds.includes(sourceId))) {
    throw new ChatContractError("invalid-report", "The Chat answer omitted a declared citation placeholder.");
  }
  for (const sourceId of citationIds) {
    const source = sourceById.get(sourceId)!;
    const placeholder = `[[source:${sourceId}]]`;
    const canonical = `[${escapeMarkdownLabel(source.title)}](${source.url})`;
    messageMarkdown = messageMarkdown.split(placeholder).join(canonical);
  }
  if (messageMarkdown.length === 0 || messageMarkdown.length > 24_000) {
    throw new ChatContractError("limit-exceeded", "The Chat answer exceeds its bounded Markdown size.");
  }
  const reasonCode = input.qualityPolicy.mode === "quick"
    ? "quick-direct"
    : input.qualityPolicy.mode === "deep"
      ? "deep-direct"
      : "auto-direct";
  return {
    schema: CHAT_ANSWER_SCHEMA_V1,
    messageMarkdown,
    citations: citationIds.map((sourceId) => {
      const source = sourceById.get(sourceId)!;
      return {
        sourceId,
        title: source.title,
        url: source.url,
        product: source.product,
      };
    }),
    evidenceRefs: citationIds,
    gaps: draft.gaps.map((gap) => ({ ...gap, sourceIds: [...gap.sourceIds] })),
    strategy: {
      qualityMode: input.qualityPolicy.mode,
      path: "direct",
      delegated: false,
      reasonCode,
    },
    ...(draft.continuation ? { continuation: { ...draft.continuation } } : {}),
    run: structuredClone(input.run),
  };
}
