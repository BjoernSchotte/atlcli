import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type {
  ResearchCapabilityBroker,
  ResearchDetailEvidenceV1,
} from "../broker.js";
import { ChatContractError } from "./contracts.js";
import {
  buildChatLocalDirectEvidenceProjectionV1,
  buildChatTerminalEvidenceBatchesV1,
  createChatLocalTerminalContextMessagesV1,
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
      "base",
      "fee",
      "2027",
    ]));
    expect(projection?.snippets.map((snippet) => snippet.text).join("\n"))
      .toContain("60,000-85,000 EUR");
    expect(projection?.snippets.map((snippet) => snippet.text).join("\n"))
      .toContain("30,000 EUR");
    expect(projection!.snippets.reduce((total, snippet) => total + snippet.text.length, 0))
      .toBeLessThanOrEqual(5_200);
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
      evidenceProjection: { snippets: Array<{ text: string }> };
    };
    expect(terminal).toMatchObject({
      schema: "atlcli.chat-terminal-context/v1",
      question: "State the budget and deadline.",
    });
    expect(terminal.evidenceProjection.snippets.map((snippet) => snippet.text).join("\n"))
      .toContain("BUDGET");
    expect(terminal.evidenceProjection.snippets.map((snippet) => snippet.text).join("\n"))
      .toContain("DEADLINE");
    expect(terminal.instruction).toContain(
      "Address each substantive request in the user's original question",
    );
    expect(terminal.instruction).toContain("Judge coverage by meaning, not wording");
    expect(messages[0]!.text).not.toContain("explicitRequestChecklist");
    expect(messages[0]).toBeInstanceOf(HumanMessage);
  });
});
