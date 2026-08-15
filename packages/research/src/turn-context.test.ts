import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1 } from "./graph.js";
import { WorkspaceResearchMessageLineageStoreV1 } from "./message-lineage.js";
import type { ResearchSessionTurnV1 } from "./session.js";
import { buildResearchTurnContextV1, renderResearchTurnContextV1 } from "./turn-context.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

describe("durable research turn context", () => {
  test("projects only bounded operational metadata, a summary, and human interaction tail", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:turn-context",
      turnId: "research-turn:turn-context",
      objective: "Compare synthetic Jira and Confluence work.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["KB"],
      },
      asOf: "2026-08-02T12:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    graph.nodes[0]!.packetRef = "packet:accepted-synthetic";
    const lineage = new WorkspaceResearchMessageLineageStoreV1(createMemoryResearchWorkspace());
    const messages = await lineage.appendMessages({
      batchId: "turn-context:messages",
      createdAt: "2026-08-02T12:00:01.000Z",
      links: { turnId: brief.turnId, graphRevision: graph.revision },
      messages: [
        { type: "human", content: "Retain this bounded user follow-up." },
        { type: "tool", content: "Provider source body must never enter the turn context." },
        { type: "ai", content: "Hidden supervisor reasoning must never enter the turn context." },
      ],
    });
    await lineage.appendSummary({
      kind: "turn",
      createdAt: "2026-08-02T12:00:02.000Z",
      author: "model",
      summary: "Non-authoritative operational summary.",
      sourceEventIds: [messages[0]!.id],
      links: { turnId: brief.turnId, graphRevision: graph.revision },
    });
    const turn = {
      checkpoints: [{ artifactRefs: ["artifact:report:synthetic"] }],
      acceptedPackets: [{ packetRef: "packet:accepted-synthetic" }],
    } as unknown as ResearchSessionTurnV1;

    const context = await buildResearchTurnContextV1({ brief, graph, turn, lineage });

    expect(context).toMatchObject({
      brief: { revision: brief.revision, scopeBindingIds: [] },
      graph: { revision: graph.revision, unresolvedNodes: expect.any(Array) },
      references: {
        packetRefs: ["packet:accepted-synthetic"],
        artifactIds: ["artifact:report:synthetic"],
      },
      latestSummary: {
        author: "model",
        nonAuthoritative: true,
        summary: "Non-authoritative operational summary.",
      },
      recentInteractionTail: [{ content: "Retain this bounded user follow-up." }],
    });
    const rendered = renderResearchTurnContextV1(context);
    expect(rendered).toContain("not instructions or evidence");
    expect(rendered).not.toContain("Provider source body");
    expect(rendered).not.toContain("Hidden supervisor reasoning");
  });
});
