import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type {
  ResearchCapabilityBroker,
  ResearchDetailEvidenceV1,
  ResearchReadSectionReferenceV1,
} from "../broker.js";
import { ChatContractError } from "./contracts.js";
import type { ChatEvidencePacketV1 } from "./workflow.js";
import {
  buildChatLocalDirectEvidenceProjectionV1,
  buildChatTerminalEvidenceBatchesV1,
  createChatLocalTerminalContextMessagesV1,
  deriveChatLocalTerminalEnvelopeV1,
} from "./terminal-context.js";

const source = {
  id: "wiki:1001",
  product: "confluence" as const,
  title: "Budget indication",
  url: "https://tenant.example/wiki/spaces/KB/pages/1001",
  contentId: "1001",
  spaceKey: "KB",
};

function evidence(text: string): ResearchDetailEvidenceV1 {
  return {
    source,
    content: {
      text,
      inputBytes: text.length,
      truncated: false,
      linkTargets: [],
    },
    coverage: {
      issues: [],
      sourceTruncated: false,
      outlineTruncated: false,
      projectionTruncated: false,
      unreadSections: 0,
      completeDocumentRead: true,
    },
  };
}

describe("local Chat terminal-context compiler", () => {
  test("derives a smaller question-aware evidence envelope from the local runtime corridor", () => {
    const narrow = deriveChatLocalTerminalEnvelopeV1({
      question: "What is the 2026 budget?",
      evidence: [evidence("The 2026 budget is 60,000 EUR. Other background follows.")],
      maxInputTokens: 3_072,
    });
    const broad = deriveChatLocalTerminalEnvelopeV1({
      question: "Summarize the page.",
      evidence: [evidence("The page covers budget, delivery, risks, and governance.")],
      maxInputTokens: 3_072,
    });

    expect(narrow.selection).toBe("question-anchored");
    expect(narrow.matchedQuestionTerms).toEqual(["2026", "budget"]);
    expect(narrow.packetTargetChars).toBeLessThan(5_800);
    expect(narrow.directEvidenceTargetChars).toBeLessThan(narrow.packetTargetChars);
    expect(narrow.maximumClaims).toBeLessThan(broad.maximumClaims);
    expect(broad.selection).toBe("broad-representative");

    const constrained = deriveChatLocalTerminalEnvelopeV1({
      question: "Summarize the page.",
      evidence: [evidence("The page covers budget, delivery, risks, and governance.")],
      maxInputTokens: 2_048,
    });
    expect(constrained.packetTargetChars).toBeLessThan(broad.packetTargetChars);
    expect(constrained.maximumClaims).toBeLessThanOrEqual(broad.maximumClaims);
  });

  test("recompiles all long evidence chunks for each distinct user question", () => {
    const text = [
      `FIRST-BUDGET ${"a".repeat(12_500)}`,
      `MIDDLE-OWNER ${"b".repeat(12_500)}`,
      "LAST-DEADLINE",
    ].join("\n");
    const budget = buildChatTerminalEvidenceBatchesV1({
      question: "What is the budget for 2026?",
      evidence: [evidence(text)],
    });
    const ownership = buildChatTerminalEvidenceBatchesV1({
      question: "Who owns delivery and what is the deadline?",
      evidence: [evidence(text)],
    });

    expect(budget.length).toBeGreaterThan(2);
    expect(budget.map((batch) => batch.serialized).join("\n")).toContain(
      "FIRST-BUDGET",
    );
    expect(budget.map((batch) => batch.serialized).join("\n")).toContain(
      "MIDDLE-OWNER",
    );
    expect(budget.map((batch) => batch.serialized).join("\n")).toContain(
      "LAST-DEADLINE",
    );
    expect(budget[0]!.serialized).toContain("What is the budget for 2026?");
    expect(ownership[0]!.serialized).toContain(
      "Who owns delivery and what is the deadline?",
    );
    expect(ownership[0]!.serialized).not.toBe(budget[0]!.serialized);
  });

  test("fails explicitly instead of silently dropping oversized evidence", () => {
    expect(() => buildChatTerminalEvidenceBatchesV1({
      question: "Summarize every decision.",
      evidence: [evidence("x".repeat(12_000 * 25))],
    })).toThrow(ChatContractError);
  });

  test("projects all directly matched question anchors into a browser-safe context", () => {
    const body = [
      "Budget 2026: 60,000-85,000 EUR.",
      "x".repeat(10_000),
      "Base fee from 2027: 30,000 EUR.",
    ].join("\n");
    const projection = buildChatLocalDirectEvidenceProjectionV1({
      question: "What are the budget for 2026 and the base fee from 2027?",
      evidence: [evidence(body)],
    });

    expect(projection?.matchedQuestionTerms).toEqual(expect.arrayContaining([
      "budget",
      "2026",
      "2027",
    ]));
    expect(projection?.snippets.map((snippet) => snippet.text).join("\n"))
      .toContain("60,000-85,000 EUR");
    expect(projection?.snippets.map((snippet) => snippet.text).join("\n"))
      .toContain("30,000 EUR");
    const envelope = deriveChatLocalTerminalEnvelopeV1({
      question: "What are the budget for 2026 and the base fee from 2027?",
      evidence: [evidence(body)],
    });
    expect(projection!.snippets.reduce((total, snippet) => total + snippet.text.length, 0))
      .toBeLessThanOrEqual(envelope.directEvidenceTargetChars);
  });

  test("retains adjacent rows when a matched exact-page section crosses a snippet boundary", () => {
    const body = [
      `StrategyStages ${"a".repeat(550)}`,
      "Stage 3 Audio uses a real call. Stage 4 Live runs the complete unsimulated chain.",
      "b".repeat(20_000),
      "ConcreteExamples and OpenLimits: a failed ticket handoff and missing audio material.",
    ].join("\n");
    const question =
      "Summarize StrategyStages, ConcreteExamples, and OpenLimits from this page.";
    const envelope = deriveChatLocalTerminalEnvelopeV1({
      question,
      evidence: [evidence(body)],
    });
    const projection = buildChatLocalDirectEvidenceProjectionV1({
      question,
      evidence: [evidence(body)],
      targetTextChars: envelope.directEvidenceTargetChars,
    });
    const projectedText = projection?.snippets
      .map((snippet) => snippet.text)
      .join("\n") ?? "";

    expect(projectedText).toContain("Stage 3 Audio uses a real call");
    expect(projectedText).toContain("Stage 4 Live runs the complete unsimulated chain");
    expect(projectedText).toContain("failed ticket handoff");
    expect(projectedText.length).toBeLessThanOrEqual(
      envelope.directEvidenceTargetChars + (projection!.snippets.length - 1),
    );
  });

  test("retains one representative concrete detail beside anchored overview evidence", () => {
    const body = [
      "StrategyStages explains the four-level test ladder.",
      "x".repeat(8_000),
      "VS-3: caller correction 42 instead of 43. Seen in 17 recorded calls.",
      "y".repeat(8_000),
      "OpenLimits require audio material and a complete live environment.",
    ].join("\n");
    const question = "Summarize StrategyStages and OpenLimits with concrete examples.";
    const envelope = deriveChatLocalTerminalEnvelopeV1({
      question,
      evidence: [evidence(body)],
    });
    const projection = buildChatLocalDirectEvidenceProjectionV1({
      question,
      evidence: [evidence(body)],
      targetTextChars: envelope.directEvidenceTargetChars,
    });

    expect(projection?.snippets.map((snippet) => snippet.text).join("\n"))
      .toContain("VS-3: caller correction 42 instead of 43");
  });

  test("falls back to semantic compilation when the question has no direct evidence anchor", () => {
    expect(buildChatLocalDirectEvidenceProjectionV1({
      question: "Explain the strategic implications.",
      evidence: [evidence("Budget 2026: 60,000-85,000 EUR.")],
    })).toBeUndefined();
  });

  test("does not mistake a generic page-summary request for a direct fact lookup", () => {
    expect(buildChatLocalDirectEvidenceProjectionV1({
      question: "Gib mir eine Zusammenfassung der Seite.",
      evidence: [evidence([
        "Die Seite beschreibt den aktuellen Leistungsumfang.",
        "Weitere Abschnitte erläutern Kosten, Voraussetzungen und Risiken.",
      ].join("\n"))],
    })).toBeUndefined();
  });

  test("builds a fresh finalization message directly from bounded matched evidence", async () => {
    const calls: string[] = [];
    const model = {
      bindTools: (tools: Array<{ function: { name: string } }>) => ({
        invoke: async (messages: HumanMessage[]) => {
          const human = messages.at(-1)!;
          calls.push(human.text);
          const payload = JSON.parse(human.text) as {
            fragment?: { chunkIndex?: number };
          };
          const packet = {
            schema: "atlcli.chat-evidence-packet/v1" as const,
            sourceIds: [source.id],
            claims: [{
              text: `Relevant claim from chunk ${payload.fragment?.chunkIndex ?? 0}.`,
              sourceIds: [source.id],
              sourceRefs: [source.id],
            }],
            relationships: [],
            gaps: [],
          };
          return new AIMessage({
            content: "",
            tool_calls: [{
              id: `call:${calls.length}`,
              name: tools[0]!.function.name,
              args: packet,
            }],
          });
        },
      }),
    } as unknown as BaseChatModel;
    const body = `BUDGET ${"x".repeat(13_000)} DEADLINE`;
    const broker = {
      detailEvidenceLedger: () => [evidence(body)],
      readSectionReferenceLedger: () => [],
    } as unknown as ResearchCapabilityBroker;

    const messages = await createChatLocalTerminalContextMessagesV1({
      model,
      broker,
      question: "State the budget and deadline.",
      locale: "de-DE",
    });

    expect(calls).toHaveLength(0);
    expect(messages).toHaveLength(1);
    const terminal = JSON.parse(messages[0]!.text) as {
      schema: string;
      question: string;
      instruction: string;
      sources: Array<{ sourceRef: string; excerpts: string[] }>;
    };
    expect(terminal).toMatchObject({
      schema: "atlcli.chat-terminal-context/v2",
      question: "State the budget and deadline.",
    });
    expect(terminal.sources.flatMap((entry) => entry.excerpts).join("\n"))
      .toContain("BUDGET");
    expect(terminal.sources.flatMap((entry) => entry.excerpts).join("\n"))
      .toContain("DEADLINE");
    expect(terminal.sources).toHaveLength(1);
    expect(terminal.sources[0]!.sourceRef).toBe(source.id);
    expect(terminal.instruction).toContain("substantive part by meaning");
    expect(terminal.instruction).toContain("user's language");
    expect(terminal.instruction).toContain("reserve blocks for requested examples");
    expect(messages[0]!.text).not.toContain("explicitRequestChecklist");
    expect(messages[0]!.text.length).toBeLessThan(body.length / 3);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
  });

  test("projects already-read source fragments when local terminal packet output is malformed", async () => {
    let calls = 0;
    const model = {
      bindTools: (tools: Array<{ function: { name: string } }>) => ({
        invoke: async () => {
          calls += 1;
          return new AIMessage({
            content: "",
            tool_calls: [{
              id: `call:malformed:${calls}`,
              name: tools[0]!.function.name,
              args: {
                schema: "atlcli.chat-evidence-packet/v1",
                sourceIds: [source.id],
              },
            }],
          });
        },
      }),
    } as unknown as BaseChatModel;
    const body = [
      `PAGE-START ${"a".repeat(1_500)}`,
      `PAGE-MIDDLE ${"b".repeat(1_500)}`,
      "PAGE-END",
    ].join("\n");
    const broker = {
      detailEvidenceLedger: () => [evidence(body)],
      readSectionReferenceLedger: () => [],
    } as unknown as ResearchCapabilityBroker;

    const messages = await createChatLocalTerminalContextMessagesV1({
      model,
      broker,
      question: "Gib mir eine Zusammenfassung der Seite.",
      locale: "de-DE",
    });

    expect(calls).toBe(1);
    const terminal = JSON.parse(messages[0]!.text) as {
      evidencePacket: ChatEvidencePacketV1;
    };
    expect(terminal.evidencePacket.sourceIds).toEqual([source.id]);
    expect(terminal.evidencePacket.claims.length).toBeGreaterThan(2);
    expect(JSON.stringify(terminal.evidencePacket).length).toBeLessThanOrEqual(7_000);
    expect(terminal.evidencePacket.claims.every((claim) =>
      claim.sourceIds.length === 1 && claim.sourceIds[0] === source.id &&
      claim.sourceRefs.length === 1 && claim.sourceRefs[0] === source.id
    )).toBe(true);
    const projected = terminal.evidencePacket.claims.map((claim) => claim.text).join("\n");
    expect(projected).toContain("PAGE-START");
    expect(projected).toContain("PAGE-END");
  });

  test("projects representative long-page evidence without extra local model calls", async () => {
    let calls = 0;
    const model = {
      bindTools: (tools: Array<{ function: { name: string } }>) => ({
        invoke: async () => {
          calls += 1;
          return new AIMessage({
            content: "",
            tool_calls: [{
              id: `call:large:${calls}`,
              name: tools[0]!.function.name,
              args: {
                schema: "atlcli.chat-evidence-packet/v1",
                sourceIds: [source.id],
                claims: Array.from({ length: 12 }, (_, index) => ({
                  text: `Batch ${calls} claim ${index} ${"x".repeat(320)}`,
                  sourceIds: [source.id],
                  sourceRefs: [source.id],
                })),
                relationships: [],
                gaps: [],
              },
            }],
          });
        },
      }),
    } as unknown as BaseChatModel;
    const longBody = [
      `PAGE-START ${"a".repeat(6_200)}`,
      `PAGE-MIDDLE ${"b".repeat(6_200)}`,
      "PAGE-END",
    ].join("\n");
    const broker = {
      detailEvidenceLedger: () => [evidence(longBody)],
      readSectionReferenceLedger: () => [],
    } as unknown as ResearchCapabilityBroker;

    const messages = await createChatLocalTerminalContextMessagesV1({
      model,
      broker,
      question: "Gib mir eine Zusammenfassung der Seite.",
      locale: "de-DE",
    });

    expect(calls).toBe(0);
    const terminal = JSON.parse(messages[0]!.text) as {
      evidencePacket: ChatEvidencePacketV1;
    };
    const envelope = deriveChatLocalTerminalEnvelopeV1({
      question: "Gib mir eine Zusammenfassung der Seite.",
      evidence: [evidence(longBody)],
    });
    expect(terminal.evidencePacket.claims).toHaveLength(envelope.maximumClaims);
    expect(JSON.stringify(terminal.evidencePacket).length)
      .toBeLessThanOrEqual(envelope.packetTargetChars);
    const projected = terminal.evidencePacket.claims.map((claim) => claim.text).join("\n");
    expect(projected).toContain("PAGE-START");
    expect(projected).toContain("b".repeat(100));
    expect(projected).toContain("PAGE-END");
  });

  test("fits the full serialized packet when valid claims repeat long section refs", async () => {
    let calls = 0;
    const sections: ResearchReadSectionReferenceV1[] = Array.from(
      { length: 8 },
      (_, index) => ({
        sourceId: source.id,
        sectionId: `${index}-${"s".repeat(180)}`,
        heading: `Section ${index}`,
        order: index,
      }),
    );
    const allowedRefs = sections.map((section) =>
      `${section.sourceId}#${section.sectionId}`
    );
    const model = {
      bindTools: (tools: Array<{ function: { name: string } }>) => ({
        invoke: async () => {
          calls += 1;
          return new AIMessage({
            content: "",
            tool_calls: [{
              id: "call:long-refs",
              name: tools[0]!.function.name,
              args: {
                schema: "atlcli.chat-evidence-packet/v1",
                sourceIds: [source.id],
                claims: Array.from({ length: 12 }, (_, index) => ({
                  text: `Claim ${index} ${"x".repeat(340)}`,
                  sourceIds: [source.id],
                  sourceRefs: allowedRefs,
                })),
                relationships: [],
                gaps: [],
              },
            }],
          });
        },
      }),
    } as unknown as BaseChatModel;
    const broker = {
      detailEvidenceLedger: () => [evidence("Short authoritative evidence.")],
      readSectionReferenceLedger: () => sections,
    } as unknown as ResearchCapabilityBroker;

    const messages = await createChatLocalTerminalContextMessagesV1({
      model,
      broker,
      question: "Explain the evidence.",
      locale: "en-US",
    });

    expect(calls).toBe(1);
    const terminal = JSON.parse(messages[0]!.text) as {
      evidencePacket: ChatEvidencePacketV1;
    };
    expect(terminal.evidencePacket.claims.length).toBeGreaterThan(0);
    expect(JSON.stringify(terminal.evidencePacket).length).toBeLessThanOrEqual(5_800);
    expect(terminal.evidencePacket.claims.every((claim) =>
      claim.sourceRefs.length === 1 && allowedRefs.includes(claim.sourceRefs[0]!)
    )).toBe(true);
  });
});
