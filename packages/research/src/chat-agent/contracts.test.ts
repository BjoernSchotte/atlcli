import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ChatPresentationStreamEventV1,
  type ResearchRequestV1,
} from "../contracts.js";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  chatQualityPolicyV1,
} from "../quality-policy.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import {
  chatMarkdownIntegrityIssuesV1,
  chatDraftForFinalizationAfterHostRepairV1,
  chatDraftMissingRequestFacetsV1,
  chatDraftNeedsHostRepairV1,
  finalizeChatAnswerV1,
  inspectChatDraftAfterHostRepairV1,
} from "./answer.js";
import {
  CHAT_AGENT_DRAFT_SCHEMA_V2,
  CHAT_SESSION_STATE_PATH_V1,
  ChatContractError,
  normalizeChatAgentDraftV2,
  normalizeChatGapCodeV1,
  providerCompatibleChatAnswerSchemaV1,
  providerCompatibleChatAnswerSchemaV2,
  type ChatTurnRequestV1,
} from "./contracts.js";
import {
  chatRecursionLimitV1,
  createChatDirectToolSurfaceMiddlewareV1,
  createKiteweaveChatAgent,
  projectChatAgentDiagnosticActivityV1,
  projectChatReasoningSummaryDeltaV1,
  streamedJsonStringFieldV1,
  streamedJsonStringFieldsV1,
  type ChatAgentRuntimeBindings,
} from "./runtime.js";
import {
  CHAT_CANDIDATE_LEDGER_PATH_V1,
  CHAT_RETRIEVAL_ASSESSMENT_PATH_V1,
  CHAT_RETRIEVAL_PLAN_PATH_V1,
} from "./retrieval-plan.js";
import { createKiteweaveResearchAgent } from "../agent-runtime-core.js";

const turn: ChatTurnRequestV1 = {
  schema: "atlcli.chat-turn-request/v1",
  conversationId: "chat-conversation:synthetic",
  turnId: "chat-turn:synthetic",
  question: "What does the attached page establish?",
  scope: {
    siteOrigin: "https://tenant-a.atlassian.net",
    jiraProjectKeys: [],
    confluenceSpaceKeys: ["SPACE"],
  },
  limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxRunMs: 30_000 },
  wikiProvider: "rest",
};

const brokerRequest: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: turn.question,
  scope: turn.scope,
  limits: turn.limits,
  wikiProvider: "rest",
};

const hostIdentity = {
  userId: "principal:synthetic-user",
  providerCacheIdentity: "provider-cache:synthetic-user",
} as const;

const run = {
  model: "synthetic-model",
  startedAt: "2026-08-05T08:00:00.000Z",
  completedAt: "2026-08-05T08:00:01.000Z",
  durationMs: 1_000,
  counts: { ptcCalls: 1, httpCalls: 1, jiraItems: 0, confluenceItems: 1 },
};

const syntheticPageSource = {
  id: "wiki:1001",
  product: "confluence" as const,
  title: "Synthetic page",
  url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
  contentId: "1001",
  spaceKey: "SPACE",
};

const syntheticCompleteContent = {
  text: "Die Seite beschreibt eine belegte Maßnahme.",
  inputBytes: 43,
  truncated: false,
  linkTargets: [] as string[],
};

describe("Chat answer contract", () => {
  test("requests a terminal host repair for malformed or ungrounded factual drafts", () => {
    expect(chatDraftNeedsHostRepairV1({
      draft: {
        blocks: [{
          markdown: "An abandoned **alternative",
          assertion: "positive",
          scope: "none",
          sourceRefs: [syntheticPageSource.id],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(true);

    expect(chatDraftNeedsHostRepairV1({
      draft: {
        blocks: [{
          markdown: "A supported first facet.",
          assertion: "positive",
          scope: "none",
          sourceRefs: [syntheticPageSource.id],
        }, {
          markdown: "A second requested facet without an evidence classification.",
          assertion: "positive",
          scope: "none",
          sourceRefs: [],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(true);

    expect(chatDraftNeedsHostRepairV1({
      draft: {
        blocks: [{
          markdown: "A factual answer without accepted evidence.",
          assertion: "positive",
          scope: "none",
          sourceRefs: [],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(true);

    expect(chatDraftNeedsHostRepairV1({
      draft: {
        blocks: [{
          markdown: "A complete evidence-bound answer.",
          assertion: "positive",
          scope: "none",
          sourceRefs: [syntheticPageSource.id],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(false);

    expect(chatDraftNeedsHostRepairV1({
      draft: {
        blocks: [{
          markdown: "## Recommended configuration",
          assertion: "none",
          scope: "none",
          sourceRefs: [],
        }, {
          markdown: "The author calls this the **lossless profile",
          assertion: "none",
          scope: "none",
          sourceRefs: [],
        }, {
          markdown: "The accepted setting preserves stable quality.",
          assertion: "positive",
          scope: "none",
          sourceRefs: [syntheticPageSource.id],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(true);
  });

  test("requires every explicit user-authored facet before and after terminal repair", () => {
    const incomplete = {
      blocks: [{
        markdown: "**Modellgröße:** klein.\n\n**Endgeschwindigkeit:** schnell.",
        assertion: "positive",
        scope: "none",
        sourceRefs: [syntheticPageSource.id],
      }],
      gaps: [],
    };
    const requestFacets = ["Modellgröße", "Endgeschwindigkeit", "die Einsatzempfehlung"];

    expect(chatDraftMissingRequestFacetsV1({ draft: incomplete, requestFacets })).toEqual([
      "die Einsatzempfehlung",
    ]);
    expect(chatDraftNeedsHostRepairV1({
      draft: incomplete,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      requestFacets,
    })).toBe(true);
    expect(chatDraftForFinalizationAfterHostRepairV1({
      draft: incomplete,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      requestFacets,
    })).toBeUndefined();

    const complete = {
      ...incomplete,
      blocks: [{
        ...incomplete.blocks[0],
        markdown: `${incomplete.blocks[0]!.markdown}\n\n**Einsatzempfehlung:** einsetzen.`,
      }],
    };
    expect(chatDraftMissingRequestFacetsV1({ draft: complete, requestFacets })).toEqual([]);
    expect(chatDraftForFinalizationAfterHostRepairV1({
      draft: complete,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      requestFacets,
    })).toBeDefined();
  });

  test("classifies terminal repair rejection without retaining draft content", () => {
    expect(inspectChatDraftAfterHostRepairV1({
      draft: {
        blocks: [{
          markdown: "## First facet",
          assertion: "none",
          scope: "none",
          sourceRefs: [],
        }],
        gaps: [],
      },
      detailEvidence: [],
      requestFacets: ["First facet", "Second facet"],
    })).toEqual({ rejectionReasons: ["orphan-heading"] });
  });

  test("repairs and rejects incomplete factual prose instead of publishing a dangling clause", () => {
    const draft = {
      blocks: [{
        markdown: "Die Quelle bezeichnet die gemessene Einstellung selbst als",
        assertion: "positive" as const,
        scope: "none" as const,
        sourceRefs: [syntheticPageSource.id],
      }],
      gaps: [],
    };

    expect(chatMarkdownIntegrityIssuesV1(draft.blocks[0]!.markdown)).toEqual([
      "incomplete-prose",
    ]);
    expect(chatDraftNeedsHostRepairV1({
      draft,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(true);
    expect(inspectChatDraftAfterHostRepairV1({
      draft,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toEqual({ rejectionReasons: ["incomplete-prose"] });
    expect(() => finalizeChatAnswerV1({
      draft,
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    })).toThrow("incomplete or contradictory prose");
  });

  test("rejects an explicit measured-versus-conjectural self-contradiction", () => {
    const markdown = [
      "Die drei Werte wurden direkt gemessen.",
      "Diese Werte sind daher eine Vermutung.",
    ].join(" ");
    const draft = {
      blocks: [{
        markdown,
        assertion: "positive" as const,
        scope: "none" as const,
        sourceRefs: [syntheticPageSource.id],
      }],
      gaps: [],
    };

    expect(chatMarkdownIntegrityIssuesV1(markdown)).toEqual([
      "observation-classification-conflict",
    ]);
    expect(chatDraftNeedsHostRepairV1({
      draft,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(true);
    expect(inspectChatDraftAfterHostRepairV1({
      draft,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toEqual({ rejectionReasons: ["observation-classification-conflict"] });
  });

  test("allows measured observations and separately labelled interpretation", () => {
    const markdown = [
      "Der Durchsatz wurde direkt gemessen.",
      "Die vermutete Ursache der Abweichung bleibt hingegen eine Hypothese.",
    ].join(" ");

    expect(chatMarkdownIntegrityIssuesV1(markdown)).toEqual([]);
    expect(chatDraftNeedsHostRepairV1({
      draft: {
        blocks: [{
          markdown,
          assertion: "positive",
          scope: "none",
          sourceRefs: [syntheticPageSource.id],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBe(false);
  });

  test("drops a trailing orphan heading only when the remaining answer stays complete", () => {
    const inspected = inspectChatDraftAfterHostRepairV1({
      draft: {
        blocks: [
          {
            markdown: "The supported finding remains publishable.",
            assertion: "positive",
            scope: "none",
            sourceRefs: [syntheticPageSource.id],
          },
          {
            markdown: "## Abandoned alternative",
            assertion: "none",
            scope: "none",
            sourceRefs: [],
          },
        ],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    });
    expect(inspected.rejectionReasons).toEqual([]);
    expect(inspected.draft?.blocks.map((block) => block.markdown)).toEqual([
      "The supported finding remains publishable.",
    ]);
  });

  test("accepts a repaired abstention only when its gap is bound to detail evidence", () => {
    const draft = {
      blocks: [{
        markdown: "The requested owner cannot be supported from the page that was read.",
        assertion: "none" as const,
        scope: "none" as const,
        sourceRefs: [],
      }],
      gaps: [{
        code: "no-detail-evidence" as const,
        message: "The detailed page does not identify the requested owner.",
        sourceIds: [syntheticPageSource.id],
      }],
    };

    expect(inspectChatDraftAfterHostRepairV1({
      draft,
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    }).draft).toBeDefined();
    expect(inspectChatDraftAfterHostRepairV1({
      draft: {
        ...draft,
        gaps: [{ ...draft.gaps[0], sourceIds: ["wiki:invented"] }],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toEqual({ rejectionReasons: ["missing-detailed-factual-block"] });
  });

  test("accepts a repaired draft only after dropping safe prose and preserving non-empty evidence sections", () => {
    const repaired = chatDraftForFinalizationAfterHostRepairV1({
      draft: {
        blocks: [{
          markdown: "## Recommended configuration",
          assertion: "none",
          scope: "none",
          sourceRefs: [],
        }, {
          markdown: "The author calls this the **lossless profile",
          assertion: "none",
          scope: "none",
          sourceRefs: [],
        }, {
          markdown: "The accepted setting preserves stable quality.",
          assertion: "positive",
          scope: "none",
          sourceRefs: [syntheticPageSource.id],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    });
    expect(repaired?.blocks).toHaveLength(2);

    const answer = finalizeChatAnswerV1({
      draft: repaired,
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("deep"),
      run,
    });

    expect(answer.messageMarkdown).toContain("## Recommended configuration");
    expect(answer.messageMarkdown).toContain("The accepted setting preserves stable quality.");
    expect(answer.messageMarkdown).not.toContain("lossless profile");
    expect(answer.citations).toHaveLength(1);

    expect(chatDraftForFinalizationAfterHostRepairV1({
      draft: {
        blocks: [{
          markdown: "## Recommended configuration",
          assertion: "none",
          scope: "none",
          sourceRefs: [],
        }, {
          markdown: "The author calls this the **lossless profile",
          assertion: "none",
          scope: "none",
          sourceRefs: [],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    })).toBeUndefined();
  });

  test("preserves a supported repaired block after harmless ref whitespace and removes an abandoned trailing quote sentence", () => {
    const repaired = chatDraftForFinalizationAfterHostRepairV1({
      draft: {
        blocks: [{
          markdown: "The source recommends offline workloads. Als Profil gilt „lossless",
          assertion: "positive",
          scope: "none",
          sourceRefs: [` ${syntheticPageSource.id} `],
        }],
        gaps: [],
      },
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
    });

    expect(repaired?.blocks).toEqual([expect.objectContaining({
      markdown: "The source recommends offline workloads.",
      sourceRefs: [syntheticPageSource.id],
    })]);
    const answer = finalizeChatAnswerV1({
      draft: repaired,
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });
    expect(answer.messageMarkdown).toContain("offline workloads");
    expect(answer.messageMarkdown).not.toContain("„lossless");
    expect(answer.gaps).toEqual([]);
  });

  test("keeps recoverable child eval retries out of user-facing activity", () => {
    expect(projectChatAgentDiagnosticActivityV1({
      kind: "eval-step",
      profileId: "exact-context-reader",
      status: "error",
      attempt: 1,
      errorCode: "other",
    })).toBeUndefined();
    expect(projectChatAgentDiagnosticActivityV1({
      kind: "eval-step",
      status: "error",
      errorCode: "syntax",
    })).toEqual({ code: "bounded-workflow-failed", status: "failed" });
  });

  test("projects streamed provider summaries into localized semantic progress", () => {
    const state = { accumulated: "", emittedCodes: new Set<string>() };
    const first = projectChatReasoningSummaryDeltaV1(
      state,
      "The user wants to compare two pages. Call chatStrategyDecide first. ",
      "de-DE",
    );
    const second = projectChatReasoningSummaryDeltaV1(
      state,
      "Then read both sources and check the evidence before drafting the answer.",
      "de-DE",
    );
    const combined = `${first}${second}`;

    expect(first).toContain("Frage und der ausgewählte Kontext");
    expect(first).toContain("Lese- und Prüfschritte");
    expect(combined).toContain("benötigten Quellen");
    expect(combined).toContain("verfügbaren Belegen");
    expect(combined).toContain("belegte Antwort");
    expect(combined).not.toContain("chatStrategyDecide");
  });

  test("keeps strict host validation while removing provider-unsupported schema keywords", () => {
    const serialized = JSON.stringify(providerCompatibleChatAnswerSchemaV1());
    for (const keyword of ["maxItems", "maxLength", "minLength", "pattern"]) {
      expect(serialized).not.toContain(`\"${keyword}\"`);
    }
    expect(serialized).toContain("citationSourceIds");
    expect(serialized).toContain("additionalProperties");
    const current = JSON.stringify(providerCompatibleChatAnswerSchemaV2());
    expect(current).toContain("blocks");
    expect(current).toContain("sourceRefs");
    expect(current).not.toContain("maxItems");
    expect(normalizeChatGapCodeV1("search-incomplete")).toBe("incomplete-coverage");
    expect(normalizeChatGapCodeV1("unverified-relationship")).toBe("unresolved-reference");
  });

  test("normalizes the minimal provider block shape before host evidence validation", () => {
    expect(normalizeChatAgentDraftV2(CHAT_AGENT_DRAFT_SCHEMA_V2.parse({
      blocks: [{
        markdown: "### Result",
        sourceRefs: [],
        assertion: "none",
        scope: "none",
      }],
    }))).toEqual({
      blocks: [{
        id: "answer-block:1",
        markdown: "### Result",
        sourceRefs: [],
        assertion: "none",
        scope: "none",
      }],
      gaps: [],
    });
  });

  test("emits only body-free semantics for structured blocks accepted by the host", () => {
    const projections: unknown[] = [];
    const answer = finalizeChatAnswerV1({
      draft: {
        blocks: [{
          id: "assertion:accepted",
          markdown: "The accepted source establishes the bounded claim.",
          sourceRefs: ["wiki:1001"],
          assertion: "positive",
          scope: "none",
        }, {
          id: "assertion:rejected",
          markdown: "The unread source establishes another claim.",
          sourceRefs: ["wiki:9999"],
          assertion: "positive",
          scope: "none",
        }],
        gaps: [],
      },
      sources: [syntheticPageSource, {
        ...syntheticPageSource,
        id: "wiki:9999",
        title: "Unread page",
        url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/9999",
        contentId: "9999",
      }],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
      onAcceptedProjection: (projection) => projections.push(projection),
    });

    expect(answer.messageMarkdown).toContain("bounded claim");
    expect(answer.messageMarkdown).not.toContain("another claim");
    expect(projections).toEqual([{
      blocks: [{
        id: "assertion:accepted",
        assertion: "positive",
        sourceRefs: ["wiki:1001"],
      }],
    }]);
    expect(JSON.stringify(projections)).not.toContain("bounded claim");
  });

  test("replaces evidence placeholders only with host-owned canonical links", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The page establishes the synthetic claim. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [{
        id: "wiki:1001",
        product: "confluence",
        title: "Synthetic page",
        url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
        contentId: "1001",
        spaceKey: "SPACE",
      }],
      detailEvidence: [{
        source: {
          id: "wiki:1001",
          product: "confluence",
          title: "Synthetic page",
          url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
          contentId: "1001",
          spaceKey: "SPACE",
        },
        content: {
          text: "Synthetic body",
          inputBytes: 14,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.schema).toBe("atlcli.chat-answer/v1");
    expect(answer.messageMarkdown).toContain(
      "[Synthetic page](https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001)",
    );
    expect(answer.messageMarkdown).not.toContain("[[source:");
    expect(answer.strategy).toEqual({
      qualityMode: "quick",
      path: "direct",
      delegated: false,
      reasonCode: "quick-direct",
      reasonCodes: ["quick-direct"],
      ambiguityDisposition: "none",
      requiredCapabilities: ["exact-read", "chat-answer"],
      expectedComplexity: "simple",
      qualityRisks: [],
    });
  });

  test("collapses repeated whole-page citations and balances German closing quotes", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "## Zusammenfassung: „Synthetische Seite",
          "",
          "Die Seite belegt die erste Aussage. [[source:wiki:1001]]",
          "",
          "Eine zweite Aussage nennt einen Wert von „zwei Einheiten. [[source:wiki:1001]]",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("deep"),
      run,
    });

    const canonical = "[Synthetic page](https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001)";
    expect(answer.messageMarkdown.split(canonical)).toHaveLength(2);
    expect(answer.messageMarkdown).toContain("## Zusammenfassung: „Synthetische Seite“");
    expect(answer.messageMarkdown).toContain("einen Wert von „zwei Einheiten.“");
    expect(answer.citations).toHaveLength(1);
  });

  test("removes abandoned strong-emphasis alternatives and joins an obvious continuation", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "## Empfohlene Konfiguration",
          "",
          "Der Autor empfiehlt ausdrücklich das **„lossless profile“",
          "",
          "Der Autor empfiehlt das **„Lossless-Profil“",
          "",
          "Der Autor empfiehlt `topp 0.85` als stabiles Profil. [[source:wiki:1001]]",
          "",
          "Das Profil erreicht rund 1,2 tok/s und bleibt kohärent",
          "",
          "das aggressivere Profil ist für offenen Chat ungeeignet.",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
      locale: "de-DE",
    });

    expect(answer.messageMarkdown).not.toContain("lossless profile");
    expect(answer.messageMarkdown).not.toContain("Der Autor empfiehlt das **");
    expect(answer.messageMarkdown).toContain(
      "Das Profil erreicht rund 1,2 tok/s und bleibt kohärent; das aggressivere Profil ist für offenen Chat ungeeignet.",
    );
    expect(answer.messageMarkdown).toContain("[Synthetic page]");
  });

  test("removes orphan citation lines and humanizes internal wiki IDs", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "[[source:wiki:1001]]",
          "",
          "The page wiki:1001 establishes the synthetic claim. [[source:wiki:1001]]",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).not.toContain("wiki:1001");
    expect(answer.messageMarkdown.match(/\[Synthetic page\]\(https:\/\/tenant-a\.atlassian\.net\/wiki\/spaces\/SPACE\/pages\/1001\)/gu)).toHaveLength(1);
    expect(answer.messageMarkdown).toContain("The page Synthetic page establishes");
    expect(answer.evidenceRefs).toEqual(["wiki:1001"]);
  });

  test("keeps supported answer blocks when a neighbouring block has unread evidence", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        blocks: [
          {
            id: "answer-block:supported",
            markdown: "The accepted page establishes the rollout decision.",
            sourceRefs: ["wiki:1001"],
            assertion: "positive",
            scope: "none",
          },
          {
            id: "answer-block:unsupported",
            markdown: "A second page establishes the implementation status.",
            sourceRefs: ["wiki:1002"],
            assertion: "positive",
            scope: "none",
          },
        ],
        gaps: [],
      },
      sources: [
        syntheticPageSource,
        {
          ...syntheticPageSource,
          id: "wiki:1002",
          title: "Unread page",
          contentId: "1002",
          url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1002",
        },
      ],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    });

    expect(answer.messageMarkdown).toContain("establishes the rollout decision");
    expect(answer.messageMarkdown).not.toContain("implementation status");
    expect(answer.evidenceRefs).toEqual(["wiki:1001"]);
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "no-detail-evidence",
    })]);
  });

  test("normalizes harmless model metadata drift without rejecting the whole answer", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        blocks: [
          {
            id: "heading",
            markdown: "### Result",
            sourceRefs: ["wiki:1001"],
            assertion: "none",
            scope: "source",
          },
          {
            id: "fact",
            markdown: "The accepted page establishes the rollout decision.",
            sourceRefs: ["wiki:1001"],
            assertion: "positive",
            scope: "source",
          },
          {
            id: "fact",
            markdown: "A duplicate provider block must not be published twice.",
            sourceRefs: ["wiki:1001"],
            assertion: "positive",
            scope: "none",
          },
          {
            id: "missing-evidence",
            markdown: "An uncited factual block is not publishable.",
            sourceRefs: [],
            assertion: "positive",
            scope: "none",
          },
        ],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).toContain("### Result");
    expect(answer.messageMarkdown).toContain("establishes the rollout decision");
    expect(answer.messageMarkdown).not.toContain("published twice");
    expect(answer.messageMarkdown).not.toContain("uncited factual block");
    expect(answer.evidenceRefs).toEqual(["wiki:1001"]);
    expect(answer.gaps).toEqual([expect.objectContaining({ code: "no-detail-evidence" })]);
  });

  test("rejects provider prose that omits its required evidence classification", () => {
    expect(CHAT_AGENT_DRAFT_SCHEMA_V2.safeParse({
      blocks: [{ markdown: "This provider paragraph has no evidence classification." }],
    }).success).toBe(false);
  });

  test("rejects an over-broad absence block without discarding positive partial findings", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        blocks: [
          {
            id: "answer-block:positive",
            markdown: "The issue that was read documents the completed migration.",
            sourceRefs: ["wiki:1001"],
            assertion: "positive",
            scope: "none",
          },
          {
            id: "answer-block:absence",
            markdown: "No other matching implementation exists in the bound space.",
            sourceRefs: ["wiki:1001"],
            assertion: "absence",
            scope: "bound-scope",
          },
        ],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run: {
        ...run,
        retrieval: {
          discoveredCandidates: 4,
          admittedCandidates: 4,
          detailReadCandidates: 1,
          excludedCandidates: 0,
          deferredCandidates: 3,
          detailReadCoverage: 0.25,
          canonicalUrlCorrectness: 1,
          observedRecall: null,
          wrongSourceRate: null,
          atlassianHttpCalls: 2,
          latencyMs: 500,
        },
      },
    });

    expect(answer.messageMarkdown).toContain("documents the completed migration");
    expect(answer.messageMarkdown).not.toContain("No other matching implementation exists");
    expect(answer.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "incomplete-coverage" }),
    ]));
  });

  test("renders structured list blocks without empty items or broken numbering", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        blocks: [
          {
            id: "answer-block:heading",
            markdown: "### Priorities",
            sourceRefs: [],
            assertion: "none",
            scope: "none",
          },
          {
            id: "answer-block:first",
            markdown: "3. First supported priority.",
            sourceRefs: ["wiki:1001"],
            assertion: "positive",
            scope: "none",
          },
          {
            id: "answer-block:second",
            markdown: "7. Second supported priority.",
            sourceRefs: ["wiki:1001"],
            assertion: "positive",
            scope: "none",
          },
        ],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).toContain("1. First supported priority");
    expect(answer.messageMarkdown).toContain("2. Second supported priority");
    expect(answer.messageMarkdown).not.toMatch(/^\s*\d+[.)]\s*$/mu);
  });

  test("repairs a missing Markdown table separator without changing fenced content", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "The following cost table is supported. [[source:wiki:1001]]",
          "",
          "| Cost | Logic |",
          "| 10 EUR | Fixed |",
          "| 20 EUR | Variable |",
          "",
          "```text",
          "| not | a | table |",
          "| still | code | here |",
          "```",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    });

    expect(answer.messageMarkdown).toContain("| --- | --- |");
    expect(answer.messageMarkdown).toContain([
      "```text",
      "| not | a | table |",
      "| still | code | here |",
      "```",
    ].join("\n"));
    expect(answer.messageMarkdown.match(/\| --- \| --- \|/gu)).toHaveLength(1);
    expect(answer.messageMarkdown).toContain([
      "| 10 EUR | Fixed |",
      "| 20 EUR | Variable |",
    ].join("\n"));
  });

  test("preserves validated Confluence section locators as heading deep links", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown:
          "The decision is documented here. [[source:wiki:1001#section:003:top-3-mobile]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        section: {
          sectionId: "section:003:top-3-mobile",
          heading: "TOP 3 — Mobile (10 min, erstmals behandelt)",
          order: 3,
        },
        content: {
          text: "The section records the decision.",
          inputBytes: 33,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    const expectedUrl =
      "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001#TOP-3-%E2%80%94-Mobile-(10-min%2C-erstmals-behandelt)";
    expect(answer.messageMarkdown).toContain(
      `[TOP 3 — Mobile (10 min, erstmals behandelt)](${expectedUrl})`,
    );
    expect(answer.citations).toEqual([{
      sourceId: "wiki:1001",
      title: "TOP 3 — Mobile (10 min, erstmals behandelt)",
      url: expectedUrl,
      product: "confluence",
      section: {
        sectionId: "section:003:top-3-mobile",
        heading: "TOP 3 — Mobile (10 min, erstmals behandelt)",
      },
    }]);
    expect(answer.evidenceRefs).toEqual(["wiki:1001"]);
  });

  test("preserves a section deep link from a complete page read without a redundant section read", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The complete page establishes this decision. [[source:wiki:1001#section:003:decision]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
        coverage: {
          issues: [],
          sourceTruncated: false,
          outlineTruncated: false,
          projectionTruncated: false,
          unreadSections: 0,
          completeDocumentRead: true,
        },
      }],
      readSectionReferences: [{
        sourceId: "wiki:1001",
        sectionId: "section:003:decision",
        heading: "Decision",
        order: 3,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    const expectedUrl =
      "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001#Decision";
    expect(answer.messageMarkdown).toContain(`[Decision](${expectedUrl})`);
    expect(answer.citations).toEqual([expect.objectContaining({
      sourceId: "wiki:1001",
      url: expectedUrl,
      section: {
        sectionId: "section:003:decision",
        heading: "Decision",
      },
    })]);
  });

  test("removes a forged Confluence section locator instead of degrading it to a page link", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Unsupported section claim. [[source:wiki:1001#section:999:forged]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        section: {
          sectionId: "section:003:real",
          heading: "Real section",
          order: 3,
        },
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).toContain("No detail-backed claim remained");
    expect(answer.citations).toEqual([]);
    expect(answer.gaps).toEqual([expect.objectContaining({ code: "no-detail-evidence" })]);
  });

  test("preserves a supported page claim when its unverified section locator must be downgraded", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "### Relevant topic",
          "The visible page projection supports this useful summary. [[source:wiki:1001#section:999:not-read]]",
        ].join("\n\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).toContain("The visible page projection supports this useful summary.");
    expect(answer.messageMarkdown).toContain(
      "[Synthetic page](https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001)",
    );
    expect(answer.messageMarkdown).not.toContain("#section:999:not-read");
    expect(answer.messageMarkdown).toContain("### Limits");
    expect(answer.messageMarkdown).toContain("section reference was not read separately");
    expect(answer.citations).toEqual([{
      sourceId: "wiki:1001",
      title: "Synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      product: "confluence",
    }]);
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "unresolved-reference",
      sourceIds: ["wiki:1001"],
    })]);
  });

  test("renders accepted answer gaps in the user-visible Markdown", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Belegte Zusammenfassung. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [{
          code: "incomplete-coverage",
          message: "Die verlinkte Folgeseite wurde nicht gelesen.",
          sourceIds: ["wiki:1001"],
        }],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
      locale: "de",
    });

    expect(answer.messageMarkdown).toContain("### Grenzen");
    expect(answer.messageMarkdown).toContain("- Die verlinkte Folgeseite wurde nicht gelesen.");
  });

  test("merges equivalent coverage gaps before rendering them", () => {
    const repeated = "1 weiterer Seitenabschnitt wurde nicht im Detail gelesen.";
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Belegte Zusammenfassung. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [
          { code: "incomplete-coverage", message: repeated, sourceIds: ["wiki:1001"] },
          { code: "incomplete-coverage", message: repeated, sourceIds: ["wiki:1001"] },
        ],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
      locale: "de",
    });

    expect(answer.gaps).toEqual([{
      code: "incomplete-coverage",
      message: repeated,
      sourceIds: ["wiki:1001"],
    }]);
    expect(answer.messageMarkdown.split(repeated)).toHaveLength(2);
  });

  test("omits unsupported citation claims and still rejects unknown gap evidence", () => {
    const base = {
      sources: [],
      detailEvidence: [],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    };
    const omitted = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "Unsupported. [[source:wiki:missing]]",
        citationSourceIds: ["wiki:missing"],
        gaps: [],
      },
    });
    expect(omitted.messageMarkdown).toContain("No detail-backed claim remained");
    expect(omitted.gaps).toEqual([expect.objectContaining({
      code: "no-detail-evidence",
    })]);
    expect(() => finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "No evidence is available.",
        citationSourceIds: [],
        gaps: [{
          code: "no-detail-evidence",
          message: "No detailed source could be read.",
          sourceIds: ["wiki:missing"],
        }],
      },
    })).toThrow("unknown evidence");
  });

  test("never publishes a partial uncited sentence after an evidence-requiring read", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown:
          "Die Seite trägt den Titel **Synthetic page** (nicht „Testseite",
        citationSourceIds: [],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [],
      qualityPolicy: chatQualityPolicyV1("quick"),
      strategyDecision: {
        schema: "atlcli.chat-strategy-decision/v1",
        qualityMode: "quick",
        execution: "direct",
        reasonCodes: ["quick-direct", "single-exact-context"],
        ambiguityDisposition: "none",
        requiredCapabilities: ["exact-read", "chat-answer"],
        expectedComplexity: "simple",
        qualityRisks: [],
      },
      run: {
        ...run,
        retrieval: {
          discoveredCandidates: 1,
          admittedCandidates: 1,
          detailReadCandidates: 1,
          excludedCandidates: 0,
          deferredCandidates: 0,
          detailReadCoverage: 1,
          canonicalUrlCorrectness: 1,
          observedRecall: null,
          wrongSourceRate: null,
          atlassianHttpCalls: 1,
          latencyMs: 1_000,
        },
      },
      locale: "de",
    });

    expect(answer.messageMarkdown).toContain(
      "Für diese Antwort blieb keine detailbelegte Aussage übrig.",
    );
    expect(answer.messageMarkdown).not.toContain("nicht „Testseite");
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "no-detail-evidence",
      sourceIds: [],
    })]);
  });

  test("derives citations from validated detail-backed placeholders despite redundant array drift", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Belegte Aussage. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:unused-search-result"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });
    expect(answer.evidenceRefs).toEqual(["wiki:1001"]);
    expect(answer.citations).toEqual([expect.objectContaining({
      sourceId: "wiki:1001",
    })]);
  });

  test("cites known Jira-key lines and removes keys without detail evidence", () => {
    const jiraSource = {
      id: "jira:DEMO-1",
      product: "jira" as const,
      title: "Detailed issue",
      url: "https://tenant-a.atlassian.net/browse/DEMO-1",
      issueKey: "DEMO-1",
      projectKey: "DEMO",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "| Artefakt | Rolle |",
          "|---|---|",
          "| DEMO-1 | Umsetzung |",
          "",
          "DEMO-1 belegt die Umsetzung.",
          "DEMO-2 scheint ebenfalls zu passen.",
        ].join("\n"),
        citationSourceIds: ["jira:DEMO-1", "jira:DEMO-2"],
        gaps: [],
      },
      sources: [
        jiraSource,
        {
          id: "jira:DEMO-2",
          product: "jira",
          title: "Search-only issue",
          url: "https://tenant-a.atlassian.net/browse/DEMO-2",
          issueKey: "DEMO-2",
          projectKey: "DEMO",
        },
      ],
      detailEvidence: [{
        source: jiraSource,
        content: {
          text: "Detailed Jira evidence.",
          inputBytes: 23,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
      locale: "de",
    });
    expect(answer.messageMarkdown).toContain("DEMO-1");
    expect(answer.messageMarkdown).toContain("| Artefakt | Rolle |");
    expect(answer.messageMarkdown).toContain("|---|---|");
    expect(answer.messageMarkdown).toContain("[Detailed issue]");
    expect(answer.messageMarkdown).not.toContain("DEMO-2");
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "no-detail-evidence",
    })]);
  });

  test("retains a Jira-key mention supported by a detail-read Confluence page", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown:
          "The DEMO-1 design mandates bounded read-only tools. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: {
          text: "The DEMO-1 design mandates bounded read-only tools.",
          inputBytes: 51,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).toContain("DEMO-1 design mandates");
    expect(answer.citations).toEqual([expect.objectContaining({ sourceId: "wiki:1001" })]);
    expect(answer.gaps).toEqual([]);
  });

  test("retains a detailed canonical Jira source when optional issueKey metadata is absent", () => {
    const jiraSource = {
      id: "jira:DEMO-7",
      product: "jira" as const,
      title: "Detailed issue without projected issue metadata",
      url: "https://tenant-a.atlassian.net/browse/DEMO-7",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown:
          "- **DEMO-7** documents the implementation. [[source:jira:DEMO-7]]",
        citationSourceIds: ["jira:DEMO-7"],
        gaps: [],
      },
      sources: [jiraSource],
      detailEvidence: [{
        source: jiraSource,
        content: {
          text: "Detailed Jira evidence.",
          inputBytes: 23,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
      locale: "de",
    });

    expect(answer.messageMarkdown).toContain("DEMO-7");
    expect(answer.messageMarkdown).toContain("[Detailed issue without projected issue metadata]");
    expect(answer.gaps).toEqual([]);
  });

  test("keeps a supported Jira mapping while removing a separate unread-key sentence", () => {
    const jiraSource = {
      id: "jira:DEMO-7",
      product: "jira" as const,
      title: "Detailed issue",
      url: "https://tenant-a.atlassian.net/browse/DEMO-7",
      issueKey: "DEMO-7",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "**DEMO-7** directly documents the implementation. It belongs to DEMO-99, which was not read. [[source:jira:DEMO-7]]",
        ].join("\n"),
        citationSourceIds: ["jira:DEMO-7"],
        gaps: [],
      },
      sources: [jiraSource],
      detailEvidence: [{
        source: jiraSource,
        content: {
          text: "Detailed Jira evidence.",
          inputBytes: 23,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
      locale: "en",
    });

    expect(answer.messageMarkdown).toContain("DEMO-7");
    expect(answer.messageMarkdown).not.toContain("DEMO-99");
    expect(answer.messageMarkdown).toContain("[Detailed issue]");
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "no-detail-evidence",
    })]);
  });

  test("removes an empty answer heading before the next peer section", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "## Findings",
          "Supported detail. [[source:wiki:1001]]",
          "",
          "### Evidence gaps",
          "",
          "### Limits",
          "The bounded source does not establish complete space coverage. [[source:wiki:1001]]",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).not.toContain("### Evidence gaps");
    expect(answer.messageMarkdown).toContain("### Limits");
  });

  test("allows a gap to identify a discovered source without treating it as citation evidence", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The remaining candidate was not read in detail.",
        citationSourceIds: [],
        gaps: [{
          code: "incomplete-coverage",
          message: "One discovered candidate remains unread.",
          sourceIds: ["wiki:1002"],
        }],
      },
      sources: [{
        id: "wiki:1002",
        product: "confluence",
        title: "Unread synthetic candidate",
        url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1002",
        contentId: "1002",
        spaceKey: "SPACE",
      }],
      detailEvidence: [],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.citations).toEqual([]);
    expect(answer.gaps[0]?.sourceIds).toEqual(["wiki:1002"]);
  });

  test("requires a material coverage gap for a cited partial document projection", () => {
    const source = {
      id: "wiki:1001",
      product: "confluence" as const,
      title: "Long synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      contentId: "1001",
      spaceKey: "SPACE",
    };
    const base = {
      sources: [source],
      detailEvidence: [{
        source,
        content: {
          text: "A visible excerpt supports the positive statement.",
          inputBytes: 40_000,
          truncated: true,
          linkTargets: [],
        },
        coverage: {
          issues: ["projection_limit" as const],
          sourceTruncated: false,
          outlineTruncated: false,
          projectionTruncated: false,
          unreadSections: 3,
          completeDocumentRead: false,
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    };
    const bounded = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "The complete page contains no other constraint. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
    });
    expect(bounded.messageMarkdown).not.toContain("contains no other constraint");
    expect(bounded.messageMarkdown).toContain("does not establish what is absent");
    expect(bounded.messageMarkdown).toContain("### Limits");
    expect(bounded.gaps).toEqual([expect.objectContaining({
      code: "incomplete-coverage",
      sourceIds: ["wiki:1001"],
    })]);

    const answer = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "The visible section supports the positive statement. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [{
          code: "incomplete-coverage",
          message: "Three unrelated sections were not read.",
          sourceIds: ["wiki:1001"],
        }],
      },
    });
    expect(answer.messageMarkdown).toContain("positive statement");
    expect(answer.gaps).toHaveLength(1);
  });

  test("removes only unsupported whole-document negatives from a supported partial answer", () => {
    const source = {
      id: "wiki:1001",
      product: "confluence" as const,
      title: "Long synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      contentId: "1001",
      spaceKey: "SPACE",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "The visible section establishes the approved rollout.",
          "The entire page has no other constraint. [[source:wiki:1001]]",
        ].join(" "),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [source],
      detailEvidence: [{
        source,
        content: {
          text: "The visible section establishes the approved rollout.",
          inputBytes: 50_000,
          truncated: true,
          linkTargets: [],
        },
        coverage: {
          issues: ["unresolved_include"],
          sourceTruncated: false,
          outlineTruncated: false,
          projectionTruncated: true,
          unreadSections: 2,
          completeDocumentRead: false,
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    });
    expect(answer.messageMarkdown).toContain("visible section establishes");
    expect(answer.messageMarkdown).not.toContain("entire page has no other constraint");
    expect(answer.messageMarkdown).toContain("included Confluence item was not resolved");
  });

  test("preserves Markdown structure and scopes absence claims when retrieval is incomplete", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "### 1. Gemeinsamkeiten",
          "",
          "Die gelesene Seite nennt z. B. einen Export vs. isomorphes Rendering. [[source:wiki:1001]]",
          "",
          "| Kriterium | Ergebnis |",
          "|---|---|",
          "| Installationsanleitung | Nicht vorhanden im Space [[source:wiki:1001]] |",
          "",
          "Im DOCSY-Space existiert keine dedizierte Installationsanleitung.",
          "",
          "Insgesamt 6 Seiten gefunden.",
          "Die Konfigurationsreferenz fehlt in allen ausgewerteten Seiten.",
          "",
          "Da die Suche auf maximal 6 Seiten begrenzt war, kann es weitere Treffer geben.",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("deep"),
      locale: "de",
      run: {
        ...run,
        retrieval: {
          discoveredCandidates: 10,
          admittedCandidates: 10,
          detailReadCandidates: 6,
          excludedCandidates: 0,
          deferredCandidates: 4,
          detailReadCoverage: 0.6,
          canonicalUrlCorrectness: 1,
          observedRecall: null,
          wrongSourceRate: 0,
          atlassianHttpCalls: 8,
          latencyMs: 2_000,
        },
      },
    });

    expect(answer.messageMarkdown).toContain("### 1. Gemeinsamkeiten");
    expect(answer.messageMarkdown).toContain("z. B. einen Export vs. isomorphes Rendering");
    expect(answer.messageMarkdown).toContain([
      "| Kriterium | Ergebnis |",
      "|---|---|",
      "| Installationsanleitung | In den detailliert gelesenen Quellen nicht gefunden [Synthetic page](https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001) |",
    ].join("\n"));
    expect(answer.messageMarkdown).not.toContain("dedizierte Installationsanleitung");
    expect(answer.messageMarkdown).not.toContain("existiert keine");
    expect(answer.messageMarkdown).toContain("6 Seiten im Detail gelesen");
    expect(answer.messageMarkdown).not.toContain("Konfigurationsreferenz fehlt");
    expect(answer.messageMarkdown).toContain(
      "Da 6 von 10 zugelassenen Kandidaten im Detail gelesen wurden",
    );
    expect(answer.messageMarkdown).toContain("Aussagen über fehlende Dokumentation");
    expect(answer.messageMarkdown).toContain("6 von 10 zugelassenen Kandidaten");
    expect(answer.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "incomplete-coverage", sourceIds: [] }),
    ]));
  });

  test("renders parser and source limits as a material localized gap", () => {
    const source = {
      id: "wiki:1001",
      product: "confluence" as const,
      title: "Bounded synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      contentId: "1001",
      spaceKey: "SPACE",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Der lesbare Ausschnitt belegt den sichtbaren Beschluss. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [source],
      detailEvidence: [{
        source,
        content: {
          text: "Der sichtbare Beschluss ist freigegeben.",
          inputBytes: 4_500_000,
          truncated: true,
          linkTargets: [],
        },
        coverage: {
          issues: ["parse_budget"],
          sourceTruncated: false,
          outlineTruncated: true,
          projectionTruncated: true,
          unreadSections: 0,
          completeDocumentRead: false,
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
      locale: "de",
    });
    expect(answer.messageMarkdown).toContain("sichtbaren Beschluss");
    expect(answer.messageMarkdown).toContain("nur teilweise verarbeitet");
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "incomplete-coverage",
      sourceIds: ["wiki:1001"],
    })]);
  });

  test("turns a missing required product into a search gap instead of an absence claim", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "Die Confluence-Seite beschreibt eine belegte Maßnahme. [[source:wiki:1001]]",
          "## Vergleich mit dem Jira-Projekt",
          "Keine Übereinstimmungen sind feststellbar.",
          "| Maßnahme | Jira-Status |",
          "|---|---|",
          "| Validierung | Kein Issue |",
          "Im Jira-Projekt existiert kein einziges passendes Ticket.",
          "DEMO-42 scheint die Umsetzung zu belegen.",
          "## Verbleibende Einordnung",
          "Die belegte Confluence-Maßnahme bleibt gültig.",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [{
          code: "incomplete-coverage" as const,
          message: "Die Jira-Suche lieferte keine Detailbelege.",
          sourceIds: [],
        }],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      strategyDecision: {
        schema: "atlcli.chat-strategy-decision/v1",
        qualityMode: "auto",
        execution: "agentic",
        reasonCodes: ["cross-product-relationship"],
        ambiguityDisposition: "none",
        requiredCapabilities: [
          "jira-discovery",
          "confluence-discovery",
          "relationship-tracing",
          "quality-review",
          "chat-answer",
        ],
        expectedComplexity: "complex",
        qualityRisks: ["cross-product"],
      },
      strategyReview: {
        schema: "atlcli.chat-strategy-review/v1",
        execution: "agentic",
        detailedSourceIds: ["wiki:1001"],
        detailedProducts: ["confluence"],
        unmetCapabilityClasses: ["jira-discovery", "relationship-tracing"],
        readyForAnswer: false,
      },
      qualityDisposition: {
        schema: "atlcli.chat-quality-disposition/v1",
        conversationId: "conversation:test",
        turnId: "turn:test",
        recordedAt: "2026-08-06T12:00:00.000Z",
        defectIds: ["chat-defect:missing-jira"],
        blockingDefectIds: [],
        repairDefectIds: [],
        repairRequired: false,
        repairAdmitted: false,
        synthesisAllowed: true,
        requiredGapCodes: ["incomplete-retrieval"],
        rejectedSourceIds: [],
        repairAttemptsAllowed: 1,
      },
      locale: "de",
      run,
    });
    expect(answer.messageMarkdown).toContain("belegte Maßnahme");
    expect(answer.messageMarkdown).not.toContain("Keine Übereinstimmungen");
    expect(answer.messageMarkdown).not.toContain("Kein Issue");
    expect(answer.messageMarkdown).not.toContain("kein einziges");
    expect(answer.messageMarkdown).not.toContain("DEMO-42");
    expect(answer.messageMarkdown).toContain("bleibt gültig");
    expect(answer.messageMarkdown).toContain("belegt weder");
    expect(answer.gaps.some((gap) => gap.message.includes("belegt weder"))).toBe(true);
  });

  test("prevents final synthesis from citing evidence rejected by the quality disposition", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "## Antwort",
          "Diese Aussage darf nicht erscheinen. [[source:wiki:1001]]",
          "Die Qualitätsprüfung konnte die Quellenidentität nicht bestätigen.",
        ].join("\n\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [{
          code: "unresolved-reference",
          message: "Die angegebene Quellenidentität wurde verworfen.",
          sourceIds: ["wiki:1001"],
        }],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      strategyDecision: {
        schema: "atlcli.chat-strategy-decision/v1",
        qualityMode: "auto",
        execution: "agentic",
        reasonCodes: ["multi-source-comparison"],
        ambiguityDisposition: "none",
        requiredCapabilities: ["comparison-analysis", "quality-review", "chat-answer"],
        expectedComplexity: "complex",
        qualityRisks: ["multiple-sources"],
      },
      strategyReview: {
        schema: "atlcli.chat-strategy-review/v1",
        execution: "agentic",
        detailedSourceIds: ["wiki:1001"],
        detailedProducts: ["confluence"],
        unmetCapabilityClasses: [],
        readyForAnswer: false,
      },
      qualityDisposition: {
        schema: "atlcli.chat-quality-disposition/v1",
        conversationId: "conversation:test",
        turnId: "turn:rejected-source",
        recordedAt: "2026-08-06T12:00:00.000Z",
        defectIds: ["chat-defect:wrong-source"],
        blockingDefectIds: ["chat-defect:wrong-source"],
        repairDefectIds: [],
        repairRequired: false,
        repairAdmitted: false,
        synthesisAllowed: true,
        requiredGapCodes: ["wrong-source"],
        rejectedSourceIds: ["wiki:1001"],
        repairAttemptsAllowed: 1,
      },
      locale: "de",
      run,
    });

    expect(answer.messageMarkdown).not.toContain("Diese Aussage darf nicht erscheinen");
    expect(answer.citations).toEqual([]);
    expect(answer.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved-reference" }),
    ]));
  });

  test("adds a host-owned quality limit when the final synthesizer omits a required gap", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Eine knappe Antwort ohne den vorgeschriebenen Hinweis.",
        citationSourceIds: [],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{ source: syntheticPageSource, content: syntheticCompleteContent }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      strategyDecision: {
        schema: "atlcli.chat-strategy-decision/v1",
        qualityMode: "auto",
        execution: "agentic",
        reasonCodes: ["multi-source-comparison"],
        ambiguityDisposition: "none",
        requiredCapabilities: ["comparison-analysis", "quality-review", "chat-answer"],
        expectedComplexity: "complex",
        qualityRisks: ["multiple-sources"],
      },
      strategyReview: {
        schema: "atlcli.chat-strategy-review/v1",
        execution: "agentic",
        detailedSourceIds: ["wiki:1001"],
        detailedProducts: ["confluence"],
        unmetCapabilityClasses: [],
        readyForAnswer: true,
      },
      qualityDisposition: {
        schema: "atlcli.chat-quality-disposition/v1",
        conversationId: "conversation:test",
        turnId: "turn:missing-gap",
        recordedAt: "2026-08-06T12:00:00.000Z",
        defectIds: ["chat-defect:incomplete"],
        blockingDefectIds: [],
        repairDefectIds: [],
        repairRequired: false,
        repairAdmitted: false,
        synthesisAllowed: true,
        requiredGapCodes: ["incomplete-retrieval"],
        rejectedSourceIds: [],
        repairAttemptsAllowed: 1,
      },
      locale: "de",
      run,
    });
    expect(answer.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "incomplete-coverage" }),
    ]));
    expect(answer.messageMarkdown).toContain("Qualitätsgrenze");
    expect(answer.messageMarkdown).toContain("detailliert gelesenen Quellen");
  });
});

describe("separate Chat root", () => {
  test("projects only complete JSON string units from a streamed answer envelope", () => {
    expect(streamedJsonStringFieldV1('{"messageMarkdown":"Hello\\n**wor', "messageMarkdown"))
      .toBe("Hello\n**wor");
    expect(streamedJsonStringFieldV1('{"messageMarkdown":"Hello\\u2', "messageMarkdown"))
      .toBe("Hello");
    expect(streamedJsonStringFieldV1(
      '{"messageMarkdown":"Hello\\u263a","gaps":[{"message":"secret envelope field"}]}',
      "messageMarkdown",
    )).toBe("Hello☺");
    expect(streamedJsonStringFieldV1('{"gaps":["not an answer"]}', "messageMarkdown"))
      .toBeUndefined();
    expect(streamedJsonStringFieldsV1(
      '{"blocks":[{"markdown":"First"},{"markdown":"Second\\npart"}]}',
      "markdown",
    )).toEqual(["First", "Second\npart"]);
  });

  test("exposes only eval and durable HITL while hiding DeepAgents scaffolding", async () => {
    const middleware = createChatDirectToolSurfaceMiddlewareV1();
    let visibleNames: string[] = [];
    await middleware.wrapModelCall?.(
      {
        tools: [
          { name: "ls" },
          { name: "task" },
          { name: "eval" },
          { name: "ask_user_question" },
          { name: "write_file" },
        ],
      } as never,
      async (request) => {
        visibleNames = request.tools.map((candidate) => String(candidate.name));
        return {} as never;
      },
    );
    expect(visibleNames).toEqual(["eval", "ask_user_question"]);
  });

  test("makes terminal answer repair tool-free and evidence-bound", async () => {
    const middleware = createChatDirectToolSurfaceMiddlewareV1(undefined, {
      terminalRepairOnly: () => true,
      answerOutputInstruction: "Return the accepted ChatAnswerDraftV2 shape.",
      evidenceAccessRequired: true,
      evidenceAccessAttempted: () => false,
    });
    let visibleNames: string[] = [];
    let systemText = "";
    let calls = 0;
    const response = await middleware.wrapModelCall?.(
      {
        tools: [{ name: "eval" }, { name: "ask_user_question" }, { name: "task" }],
        systemMessage: new SystemMessage("Stable Chat contract."),
      } as never,
      async (request) => {
        calls += 1;
        visibleNames = request.tools.map((candidate) => String(candidate.name));
        systemText = request.systemMessage?.text ?? "";
        return new AIMessage("Corrected terminal answer.") as never;
      },
    );

    expect(calls).toBe(1);
    expect(visibleNames).toEqual([]);
    expect(systemText).toContain("Terminal answer correction for this turn");
    expect(systemText).toContain("Do not call a tool");
    expect(systemText).toContain("Return the accepted ChatAnswerDraftV2 shape.");
    expect((response as AIMessage).text).toBe("Corrected terminal answer.");
  });

  test("does not add a model round trip for an already host-accepted strategy", async () => {
    const middleware = createChatDirectToolSurfaceMiddlewareV1();
    const requests: Array<{ toolChoice?: unknown; systemText: string }> = [];
    const response = await middleware.wrapModelCall?.(
      {
        tools: [{ name: "eval" }, { name: "ask_user_question" }],
        systemMessage: new SystemMessage("Stable Chat contract."),
      } as never,
      async (request) => {
        requests.push({
          toolChoice: request.toolChoice,
          systemText: request.systemMessage?.text ?? "",
        });
        return new AIMessage("Accepted direct answer.") as never;
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolChoice).toBeUndefined();
    expect((response as AIMessage).text).toBe("Accepted direct answer.");
  });

  test("forces one current-turn evidence access before accepting a retained-context answer", async () => {
    let attempted = false;
    const middleware = createChatDirectToolSurfaceMiddlewareV1(undefined, {
      evidenceAccessRequired: true,
      evidenceAccessAttempted: () => attempted,
    });
    const requests: Array<{ toolChoice?: unknown; systemText: string }> = [];
    const response = await middleware.wrapModelCall?.(
      {
        tools: [{ name: "eval" }, { name: "ask_user_question" }],
        systemMessage: new SystemMessage("Stable Chat contract."),
      } as never,
      async (request) => {
        requests.push({
          toolChoice: request.toolChoice,
          systemText: request.systemMessage?.text ?? "",
        });
        if (requests.length === 1) {
          return new AIMessage("Answer copied from retained context.") as never;
        }
        attempted = true;
        return new AIMessage({
          content: "",
          tool_calls: [{
            id: "call:evidence",
            name: "eval",
            args: { code: "await tools.atlassianBoundRead({ anchorRef })" },
            type: "tool_call",
          }],
        }) as never;
      },
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]!.toolChoice).toEqual({
      type: "function",
      function: { name: "eval" },
    });
    expect(requests[1]!.systemText).toContain("Evidence correction for this turn");
    expect((response as AIMessage).tool_calls?.[0]?.name).toBe("eval");
  });

  test("closes an accepted agentic workflow without a supervisor rewrite", async () => {
    const middleware = createChatDirectToolSurfaceMiddlewareV1(undefined, {
      agenticWorkflowComplete: () => true,
    });
    let providerCalled = false;
    const response = await middleware.wrapModelCall?.(
      { tools: [{ name: "eval" }] } as never,
      async () => {
        providerCalled = true;
        return {} as never;
      },
    );
    expect(providerCalled).toBe(false);
    expect((response as AIMessage).text).toBe("Agentic Chat synthesis accepted.");
  });

  test("derives a bounded graph ceiling from the admitted PTC budget", () => {
    expect(chatRecursionLimitV1(1)).toBe(24);
    expect(chatRecursionLimitV1(16)).toBe(40);
    expect(chatRecursionLimitV1(10_000)).toBe(56);
  });

  function runtimeHarness() {
    let chatRoots = 0;
    let researchRoots = 0;
    const chatRuntime = {
      StateBackend: class {},
      createDeepAgent: (options: { name?: string }) => {
        chatRoots += 1;
        expect(options.name).toBe("kiteweave-chat-agent");
        const messageMarkdown = 'No detailed "Atlassian" evidence was needed for this response.';
        const firstSnapshot = '{"messageMarkdown":"No detailed \\"Atlassian\\" ';
        const finalSnapshot = JSON.stringify({
          messageMarkdown,
          citationSourceIds: [],
          gaps: [],
        });
        return {
          streamEvents: async () => ({
            messages: (async function* () {
              yield {
                text: (async function* () {})(),
                reasoning: (async function* () { yield "Checking the selected evidence."; })(),
                [Symbol.asyncIterator]: async function* () {
                  yield {
                    event: "content-block-start",
                    index: 0,
                    content: {
                      type: "tool_call_chunk",
                      id: "answer-1",
                      name: "ChatAnswerDraftV1",
                      args: "",
                    },
                  };
                  yield {
                    event: "content-block-delta",
                    index: 0,
                    delta: {
                      type: "block-delta",
                      fields: { type: "tool_call_chunk", args: firstSnapshot },
                    },
                  };
                  yield {
                    event: "content-block-delta",
                    index: 0,
                    delta: {
                      type: "block-delta",
                      fields: { type: "tool_call_chunk", args: finalSnapshot },
                    },
                  };
                  yield {
                    event: "content-block-finish",
                    index: 0,
                    content: {
                      type: "tool_call",
                      id: "answer-1",
                      name: "ChatAnswerDraftV1",
                      args: JSON.parse(finalSnapshot),
                    },
                  };
                },
              };
            })(),
            output: Promise.resolve({
              messages: [],
              structuredResponse: {
                messageMarkdown,
                citationSourceIds: [],
                gaps: [],
              },
            }),
          }),
        };
      },
      createSummarizationMiddleware: () => ({
        wrapModelCall: async (_request: unknown, handler: (request: unknown) => Promise<unknown>) =>
          handler(_request),
      }),
      registerHarnessProfile: () => undefined,
    } as unknown as ChatAgentRuntimeBindings;
    const researchRuntime = {
      CompositeBackend: class {},
      StateBackend: class {},
      createDeepAgent: () => {
        researchRoots += 1;
        return { invoke: async () => ({ messages: [] }) };
      },
      createFilesystemMiddleware: () => ({}),
      createSubAgentMiddleware: () => ({}),
      createSummarizationMiddleware: () => ({}),
      registerHarnessProfile: () => undefined,
    } as never;
    return { chatRuntime, researchRuntime, counts: () => ({ chatRoots, researchRoots }) };
  }

  test("constructs exactly one Chat root and does not construct the Research root", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    createKiteweaveResearchAgent(harness.researchRuntime);
    const workspace = createMemoryResearchWorkspace();
    const presentation: ChatPresentationStreamEventV1[] = [];
    const answer = await chat.runChatAgent({
      modelBinding: {
        model: {} as BaseChatModel,
        modelId: "synthetic-streaming-model",
        qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
        structuredOutput: "tool",
        reasoningPresentation: "summary",
      },
      turn,
      brokerRequest,
      providers: {
        jira: {
          searchPage: async () => { throw new Error("unexpected Jira search"); },
          getIssue: async () => { throw new Error("unexpected Jira detail"); },
        },
        wiki: {
          searchPage: async () => { throw new Error("unexpected wiki search"); },
          getPage: async () => { throw new Error("unexpected wiki detail"); },
        },
      },
      workspace,
      hostIdentity,
      qualityPolicy: chatQualityPolicyV1("quick"),
      onChatPresentation: (event) => presentation.push(event),
      now: (() => {
        let value = Date.parse("2026-08-05T08:00:00.000Z");
        return () => value++;
      })(),
    });

    expect(answer.schema).toBe("atlcli.chat-answer/v1");
    expect(answer.run.retrieval).toMatchObject({
      discoveredCandidates: 0,
      admittedCandidates: 0,
      detailReadCandidates: 0,
      detailReadCoverage: 0,
      canonicalUrlCorrectness: 0,
      atlassianHttpCalls: 0,
    });
    expect(presentation.filter((event) => event.channel === "reasoning-summary")).toEqual([
      expect.objectContaining({ channel: "reasoning-summary", status: "started" }),
      expect.objectContaining({
        channel: "reasoning-summary",
        status: "delta",
        delta: [
          "Claims are being matched to the available evidence.",
          "Remaining evidence gaps and possible contradictions are being checked.",
          "",
        ].join("\n"),
      }),
      expect.objectContaining({ channel: "reasoning-summary", status: "completed" }),
    ]);
    expect(presentation.filter((event) => event.channel === "answer-markdown")).toEqual([
      expect.objectContaining({ channel: "answer-markdown", status: "started" }),
      expect.objectContaining({
        channel: "answer-markdown",
        status: "delta",
        delta: 'No detailed "Atlassian" ',
      }),
      expect.objectContaining({
        channel: "answer-markdown",
        status: "delta",
        delta: "evidence was needed for this response.",
      }),
      expect.objectContaining({ channel: "answer-markdown", status: "completed" }),
    ]);
    expect(answer.messageMarkdown).toBe(
      'No detailed "Atlassian" evidence was needed for this response.',
    );
    expect(harness.counts()).toEqual({ chatRoots: 1, researchRoots: 0 });
    expect(JSON.parse((await workspace.readFile(CHAT_SESSION_STATE_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-session/v1",
      conversationId: turn.conversationId,
      operations: {
        lastCompletedTurnId: turn.turnId,
      },
      conversation: {
        recentTurns: [
          expect.objectContaining({
            id: turn.turnId,
            status: "complete",
          }),
        ],
      },
    });
    expect(JSON.parse((await workspace.readFile(CHAT_RETRIEVAL_PLAN_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-retrieval-plan/v1",
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      anchors: [],
      resolvedEntities: [{
        product: "confluence",
        entityKind: "space",
        key: "SPACE",
      }],
      searches: [{ product: "confluence" }],
      relationshipTraversals: [],
    });
    expect(JSON.parse((await workspace.readFile(CHAT_CANDIDATE_LEDGER_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-candidate-ledger/v1",
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      candidates: [],
    });
    expect(JSON.parse((await workspace.readFile(CHAT_RETRIEVAL_ASSESSMENT_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-retrieval-assessment/v1",
      sufficient: false,
      metrics: {
        discoveredCandidates: 0,
        detailReadCandidates: 0,
      },
    });
  });

  test("withholds reasoning without a provider grant while still streaming the structured answer", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    const presentation: ChatPresentationStreamEventV1[] = [];
    await chat.runChatAgent({
      modelBinding: {
        model: {} as BaseChatModel,
        modelId: "synthetic-ungated-model",
        qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
        structuredOutput: "tool",
      },
      turn,
      brokerRequest,
      providers: {
        jira: {
          searchPage: async () => { throw new Error("unexpected Jira search"); },
          getIssue: async () => { throw new Error("unexpected Jira detail"); },
        },
        wiki: {
          searchPage: async () => { throw new Error("unexpected wiki search"); },
          getPage: async () => { throw new Error("unexpected wiki detail"); },
        },
      },
      workspace: createMemoryResearchWorkspace(),
      hostIdentity,
      qualityPolicy: chatQualityPolicyV1("quick"),
      onChatPresentation: (event) => presentation.push(event),
    });

    expect(presentation.filter((event) => event.channel === "reasoning-summary")).toEqual([]);
    expect(presentation.filter((event) => event.channel === "answer-markdown")).toEqual([
      expect.objectContaining({ channel: "answer-markdown", status: "started" }),
      expect.objectContaining({
        channel: "answer-markdown",
        status: "delta",
        delta: 'No detailed "Atlassian" ',
      }),
      expect.objectContaining({
        channel: "answer-markdown",
        status: "delta",
        delta: "evidence was needed for this response.",
      }),
      expect.objectContaining({ channel: "answer-markdown", status: "completed" }),
    ]);
  });

  test("rejects an incompatible persisted state before root construction", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    const workspace = createMemoryResearchWorkspace();
    await workspace.writeFile(CHAT_SESSION_STATE_PATH_V1, JSON.stringify({
      schema: "atlcli.research-session/v1",
      conversationId: turn.conversationId,
    }));
    await expect(chat.runChatAgent({
      model: {} as BaseChatModel,
      turn,
      brokerRequest,
      providers: {
        jira: { searchPage: async () => ({ items: [] }), getIssue: async () => { throw new Error(); } },
        wiki: { searchPage: async () => ({ items: [] }), getPage: async () => { throw new Error(); } },
      },
      workspace,
      hostIdentity,
    })).rejects.toMatchObject({ code: "invalid-request" });
    expect(harness.counts().chatRoots).toBe(0);
  });

  test("keeps forbidden Research completion modules outside the Chat runtime import boundary", async () => {
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "@langchain/anthropic",
      "../brief.js",
      "../graph.js",
      "../agent-draft.js",
      "../report.js",
      "../report-v2.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("./answer.js");
    expect(source).toContain("./prompts.js");
  });
});
