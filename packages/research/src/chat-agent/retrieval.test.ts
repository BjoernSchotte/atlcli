import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  type ResearchRequestV1,
  type ResearchScopeSeedV1,
} from "../contracts.js";
import {
  BOUND_ENTITY_READ_INPUT_SCHEMA_V1,
  BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
  type BoundEntityReadOutputV1,
} from "../capability-contracts.js";
import { navigateConfluenceStorageV1 } from "../document-navigation.js";
import {
  ResearchCapabilityBroker,
  type ResearchReadProviders,
} from "../broker.js";
import { createChatPtcToolsV1 } from "./retrieval.js";

const ORIGIN = "https://tenant-a.atlassian.net";

function seed(input: {
  product: "jira" | "confluence";
  entityKind: "issue" | "page" | "project" | "space";
  key: string;
  name: string;
  id: string;
  origin?: string;
}): ResearchScopeSeedV1 {
  const origin = input.origin ?? ORIGIN;
  return {
    binding: {
      schema: "atlcli.research-scope-binding/v1",
      id: `scope-binding:current:${input.id}`,
      tenantOrigin: origin,
      product: input.product,
      entityKind: input.entityKind,
      entityRef: `research-scope-entity:${input.id}`,
      key: input.key,
      name: input.name,
      source: "current_context",
      authority: "approved",
    },
    precedence: 300,
  };
}

function request(input: {
  seeds: ResearchScopeSeedV1[];
  jira?: string[];
  wiki?: string[];
  exact: Array<"jira" | "confluence">;
  origin?: string;
}): ResearchRequestV1 {
  const origin = input.origin ?? ORIGIN;
  return {
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: "Summarize the attached entity.",
    scope: {
      siteOrigin: origin,
      jiraProjectKeys: input.jira ?? [],
      confluenceSpaceKeys: input.wiki ?? [],
    },
    scopeSeeds: input.seeds,
    exactContextProducts: input.exact,
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxDetailItemsPerProduct: 4,
      maxPtcCalls: 8,
    },
    wikiProvider: "rest",
  };
}

function providers(calls: string[]): ResearchReadProviders {
  return {
    jira: {
      async searchPage() {
        calls.push("jira.search");
        return { items: [] };
      },
      async getIssue({ issueKey, signal }) {
        signal.throwIfAborted();
        calls.push(`jira.get:${issueKey}`);
        return {
          issueKey,
          projectKey: "DEMO",
          title: "Encoded / issue title",
          content: {
            text: "The bound issue establishes the accepted change.",
            linkTargets: [],
            truncated: false,
            inputBytes: 49,
          },
        };
      },
    },
    wiki: {
      async searchPage() {
        calls.push("wiki.search");
        return { items: [] };
      },
      async getPage({ contentId, signal }) {
        signal.throwIfAborted();
        calls.push(`wiki.get:${contentId}`);
        return {
          contentId,
          spaceKey: "~account-id",
          title: "Renamed / title ä",
          content: {
            text: "The bound page establishes the current synthetic decision.",
            linkTargets: [],
            truncated: false,
            inputBytes: 58,
          },
        };
      },
    },
  };
}

async function invokeDirect(
  broker: ResearchCapabilityBroker,
  anchorRef: string,
): Promise<BoundEntityReadOutputV1> {
  return broker.readExactAnchor({
    schema: BOUND_ENTITY_READ_INPUT_SCHEMA_V1,
    anchorRef,
  });
}

describe("Chat exact-anchor retrieval", () => {
  test("reads an attached page once without search or ranking", async () => {
    const calls: string[] = [];
    const broker = new ResearchCapabilityBroker(request({
      seeds: [
        seed({ product: "confluence", entityKind: "space", key: "~account-id", name: "Personal space", id: "space-personal" }),
        seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" }),
      ],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), providers(calls), { createAnchorId: () => "page-anchor" });

    const anchors = broker.exactAnchors();
    expect(anchors).toEqual([{
      anchorRef: "research-anchor:page-anchor",
      product: "confluence",
      entityKind: "page",
      name: "Attached page",
    }]);
    const output = await invokeDirect(broker, anchors[0]!.anchorRef);

    expect(calls).toEqual(["wiki.get:1001"]);
    expect(output.source).toMatchObject({
      sourceId: "wiki:1001",
      title: "Renamed / title ä",
      url: `${ORIGIN}/wiki/spaces/~account-id/pages/1001`,
      contentId: "1001",
      spaceKey: "~account-id",
    });
    expect(broker.detailEvidenceLedger()[0]?.retrieval).toMatchObject({
      reason: "exact_anchor",
      rank: 1,
    });
  });

  test("records section references from a complete page read without a second HTTP request", async () => {
    const calls: string[] = [];
    const fake = providers(calls);
    fake.wiki.getPage = async ({ contentId }) => {
      calls.push(`wiki.get:${contentId}`);
      return {
        contentId,
        spaceKey: "~account-id",
        title: "Complete synthetic page",
        content: {
          text: "Decision\nThe synthetic decision is approved.",
          linkTargets: [],
          truncated: false,
          inputBytes: 43,
        },
        navigation: navigateConfluenceStorageV1({
          storage: "<h1>Decision</h1><p>The synthetic decision is approved.</p>",
          sourceVersion: 1,
          siteOrigin: ORIGIN,
          projectionLimits: {
            maxTextChars: 1_000,
            maxTextBytes: 4_000,
            maxLinks: 10,
            maxNodes: 1_000,
            maxDepth: 32,
          },
        }),
      };
    };
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), fake, {
      createAnchorId: () => "anchor",
      createSectionId: () => "decision-section",
    });

    await invokeDirect(broker, broker.exactAnchors()[0]!.anchorRef);

    expect(broker.readSectionReferenceLedger()).toEqual([{
      sourceId: "wiki:1001",
      sectionId: "section:000:decision",
      heading: "Decision",
      order: 0,
    }]);
    expect(calls).toEqual(["wiki.get:1001"]);
  });

  test("reads an attached Jira issue once and preserves its host canonical URL", async () => {
    const calls: string[] = [];
    const broker = new ResearchCapabilityBroker(request({
      seeds: [
        seed({ product: "jira", entityKind: "project", key: "DEMO", name: "Demo project", id: "project-demo" }),
        seed({ product: "jira", entityKind: "issue", key: "DEMO-42", name: "Attached issue", id: "issue-demo-42" }),
      ],
      jira: ["DEMO"],
      exact: ["jira"],
    }), providers(calls), { createAnchorId: () => "issue-anchor" });

    const output = await invokeDirect(broker, broker.exactAnchors()[0]!.anchorRef);
    expect(calls).toEqual(["jira.get:DEMO-42"]);
    expect(output.source).toMatchObject({
      sourceId: "jira:DEMO-42",
      url: `${ORIGIN}/browse/DEMO-42`,
      issueKey: "DEMO-42",
      projectKey: "DEMO",
    });
  });

  test("rejects forged, stale, and cross-turn anchor refs before provider IO", async () => {
    const calls: string[] = [];
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), providers(calls), { createAnchorId: () => "real-anchor" });
    broker.exactAnchors();

    await expect(invokeDirect(broker, "research-anchor:forged-anchor"))
      .rejects.toMatchObject({ code: "invalid-request" });
    expect(calls).toEqual([]);
  });

  test("fences every content operation before budget or provider work until strategy acceptance", async () => {
    const calls: string[] = [];
    let accepted = false;
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), providers(calls), {
      createAnchorId: () => "guarded-anchor",
      beforeContentOperation: () => {
        if (!accepted) throw new Error("strategy not accepted");
      },
    });
    const anchor = broker.exactAnchors()[0]!;

    await expect(invokeDirect(broker, anchor.anchorRef))
      .rejects.toThrow("strategy not accepted");
    expect(calls).toEqual([]);
    expect(broker.budget.counts()).toMatchObject({ ptcCalls: 0, httpCalls: 0 });

    accepted = true;
    await invokeDirect(broker, anchor.anchorRef);
    expect(calls).toEqual(["wiki.get:1001"]);
  });

  test("fails closed on a mismatched page and never falls back to search", async () => {
    const calls: string[] = [];
    const fake = providers(calls);
    fake.wiki.getPage = async () => {
      calls.push("wiki.get:1001");
      return {
        contentId: "9999",
        spaceKey: "~account-id",
        title: "Wrong page",
        content: { text: "wrong", linkTargets: [], truncated: false, inputBytes: 5 },
      };
    };
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), fake, { createAnchorId: () => "page-anchor" });

    await expect(invokeDirect(broker, broker.exactAnchors()[0]!.anchorRef))
      .rejects.toMatchObject({ code: "access-denied" });
    expect(calls).toEqual(["wiki.get:1001"]);
    expect(broker.sourceLedger()).toEqual([]);
  });

  test("does not expose same-product search tools for an exact-only context", () => {
    const calls: string[] = [];
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), providers(calls), { createAnchorId: () => "page-anchor" });
    expect(createChatPtcToolsV1(broker, {
      exactContextProducts: ["confluence"],
      searchProducts: ["confluence"],
    })
      .map((candidate) => candidate.name)).toEqual([
        "atlassian_bound_read",
        "atlassian_bound_section_read",
      ]);
    expect(calls).toEqual([]);
  });

  test("keeps Jira dormant until an admitted Jira signal is observed", async () => {
    const calls: string[] = [];
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), providers(calls), { createAnchorId: () => "page-anchor" });

    const output = await invokeDirect(broker, broker.exactAnchors()[0]!.anchorRef);
    expect(output.relatedAnchors).toEqual([]);
    expect(calls).toEqual(["wiki.get:1001"]);
  });

  test("keeps auxiliary projections off by default and admits an explicit typed need", async () => {
    const seen: Array<{ includeComments?: boolean; includeMetadata?: boolean }> = [];
    const fake = providers([]);
    fake.wiki.getPage = async (input) => {
      seen.push({
        ...(input.includeComments ? { includeComments: true } : {}),
        ...(input.includeMetadata ? { includeMetadata: true } : {}),
      });
      return {
        contentId: input.contentId,
        spaceKey: "~account-id",
        title: "Bound page",
        content: { text: "Synthetic body.", linkTargets: [], truncated: false, inputBytes: 15 },
      };
    };
    const makeBroker = (exactAuxiliaryNeeds?: Array<"comments" | "metadata">) =>
      new ResearchCapabilityBroker(request({
        seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Page", id: "page-1001" })],
        wiki: ["~account-id"],
        exact: ["confluence"],
      }), fake, {
        createAnchorId: () => exactAuxiliaryNeeds ? "aux-anchor" : "plain-anchor",
        exactAuxiliaryNeeds,
      });

    const ordinary = makeBroker();
    await invokeDirect(ordinary, ordinary.exactAnchors()[0]!.anchorRef);
    const explicit = makeBroker(["comments"]);
    await invokeDirect(explicit, explicit.exactAnchors()[0]!.anchorRef);
    expect(seen).toEqual([{}, { includeComments: true }]);
  });

  test("returns an opaque Jira anchor only after a verified page exposes its key", async () => {
    const calls: string[] = [];
    const fake = providers(calls);
    fake.wiki.getPage = async ({ contentId }) => {
      calls.push(`wiki.get:${contentId}`);
      return {
        contentId,
        spaceKey: "~account-id",
        title: "Attached page",
        content: {
          text: "The material implementation status is tracked in DEMO-42.",
          linkTargets: [],
          truncated: false,
          inputBytes: 57,
        },
      };
    };
    let anchorSequence = 0;
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), fake, { createAnchorId: () => `anchor-${++anchorSequence}` });

    const page = broker.exactAnchors()[0]!;
    const pageOutput = await invokeDirect(broker, page.anchorRef);
    expect(pageOutput.relatedAnchors).toEqual([{
      anchorRef: "research-anchor:anchor-2",
      product: "jira",
      entityKind: "issue",
      name: "DEMO-42",
    }]);
    const issue = await invokeDirect(broker, pageOutput.relatedAnchors[0]!.anchorRef);
    expect(issue.source.sourceId).toBe("jira:DEMO-42");
    expect(calls).toEqual(["wiki.get:1001", "jira.get:DEMO-42"]);
  });

  test("stops before HTTP when the turn has already been cancelled", async () => {
    const calls: string[] = [];
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Attached page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), providers(calls), { createAnchorId: () => "page-anchor" });
    const anchor = broker.exactAnchors()[0]!;
    broker.cancel();
    await expect(invokeDirect(broker, anchor.anchorRef)).rejects.toBeDefined();
    expect(calls).toEqual([]);
  });

  test("selects a late section from a body-free outline without loading a large irrelevant section", async () => {
    const calls: string[] = [];
    const fake = providers(calls);
    const irrelevant = "Irrelevant historical detail. ".repeat(900);
    const storage = [
      "<h1>Historical background</h1>",
      `<p>${irrelevant}</p>`,
      "<h1>Current decision</h1>",
      "<p>The decisive late-section fact is approved for the synthetic rollout.</p>",
    ].join("");
    const navigation = navigateConfluenceStorageV1({
      storage,
      sourceVersion: 7,
      siteOrigin: ORIGIN,
      projectionLimits: {
        maxTextChars: 4_000,
        maxTextBytes: 16_000,
        maxLinks: 20,
        maxNodes: 20_000,
        maxDepth: 64,
      },
    })!;
    fake.wiki.getPage = async ({ contentId }) => {
      calls.push(`wiki.get:${contentId}`);
      return {
        contentId,
        spaceKey: "~account-id",
        title: "Long synthetic page",
        content: {
          text: `${irrelevant}\nThe initial projection ends before the decisive fact.`,
          linkTargets: [],
          truncated: true,
          inputBytes: new TextEncoder().encode(storage).byteLength,
        },
        navigation,
      };
    };
    let sectionSequence = 0;
    const directRequest = request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Long page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    });
    directRequest.limits.maxDetailItemsPerProduct = 1;
    const broker = new ResearchCapabilityBroker(directRequest, fake, {
      createAnchorId: () => "page-anchor",
      createSectionId: () => `section-${++sectionSequence}`,
    });

    const page = await invokeDirect(broker, broker.exactAnchors()[0]!.anchorRef);
    expect(page.content.text.length).toBeLessThanOrEqual(1_200);
    expect(page.document).toMatchObject({
      projectionTruncated: true,
      sourceTruncated: false,
      outlineTruncated: false,
      genuinelyEmpty: false,
      unreadSections: 2,
    });
    const target = page.document!.sections.find((section) => section.heading === "Current decision")!;
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty("content");
    expect(broker.readSectionReferenceLedger()).toEqual([]);
    const section = await broker.readExactSection({
      schema: BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
      sectionRef: target.sectionRef,
    });
    expect(section.content.text).toContain("decisive late-section fact");
    expect(section.content.text).not.toContain("Irrelevant historical detail");
    expect(section.support).toMatchObject({
      sectionId: target.sectionId,
      start: 0,
      end: section.content.text.length,
    });
    expect(section.coverage).toMatchObject({
      sourceTruncated: false,
      outlineTruncated: false,
      unreadSections: 1,
      completeDocumentRead: false,
    });
    expect(broker.budget.state().details.confluence).toBe(1);
    expect(broker.readSectionReferenceLedger()).toEqual([{
      sourceId: "wiki:1001",
      sectionId: target.sectionId,
      heading: "Current decision",
      order: 1,
    }]);
    expect(calls).toEqual(["wiki.get:1001"]);
  });

  test("rejects forged, cross-tenant, and stale section refs", async () => {
    const calls: string[] = [];
    const fake = providers(calls);
    fake.wiki.getPage = async ({ contentId }) => ({
      contentId,
      spaceKey: "~account-id",
      title: "Navigable page",
      content: { text: "Preview", linkTargets: [], truncated: true, inputBytes: 2_000 },
      navigation: navigateConfluenceStorageV1({
        storage: "<h1>Late section</h1><p>Bound evidence.</p>",
        sourceVersion: 7,
        siteOrigin: ORIGIN,
        projectionLimits: {
          maxTextChars: 1_000,
          maxTextBytes: 4_000,
          maxLinks: 10,
          maxNodes: 1_000,
          maxDepth: 32,
        },
      }),
    });
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), fake, {
      createAnchorId: () => "anchor",
      createSectionId: () => "real-section",
    });
    const page = await invokeDirect(broker, broker.exactAnchors()[0]!.anchorRef);
    await expect(broker.readExactSection({
      schema: BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
      sectionRef: "research-section:forged",
    })).rejects.toMatchObject({ code: "invalid-request" });
    const ref = page.document!.sections[0]!.sectionRef;

    const foreignOrigin = "https://tenant-b.atlassian.net";
    const foreignBroker = new ResearchCapabilityBroker(request({
      seeds: [seed({
        product: "confluence",
        entityKind: "page",
        key: "1001",
        name: "Foreign page",
        id: "foreign-page-1001",
        origin: foreignOrigin,
      })],
      wiki: ["~account-id"],
      exact: ["confluence"],
      origin: foreignOrigin,
    }), providers([]), {
      createAnchorId: () => "foreign-anchor",
      createSectionId: () => "foreign-section",
    });
    await expect(foreignBroker.readExactSection({
      schema: BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
      sectionRef: ref,
    })).rejects.toMatchObject({ code: "invalid-request" });

    broker.cancel();
    await expect(broker.readExactSection({
      schema: BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
      sectionRef: ref,
    })).rejects.toBeDefined();
  });

  test("invalidates section refs when the bound page snapshot is captured again", async () => {
    const calls: string[] = [];
    const fake = providers(calls);
    let sourceVersion = 7;
    fake.wiki.getPage = async ({ contentId }) => {
      calls.push(`wiki.get:${contentId}:v${sourceVersion}`);
      return {
        contentId,
        spaceKey: "~account-id",
        title: "Versioned page",
        content: { text: "Preview", linkTargets: [], truncated: true, inputBytes: 2_000 },
        navigation: navigateConfluenceStorageV1({
          storage: `<h1>Decision</h1><p>Snapshot version ${sourceVersion}.</p>`,
          sourceVersion,
          siteOrigin: ORIGIN,
          projectionLimits: {
            maxTextChars: 1_000,
            maxTextBytes: 4_000,
            maxLinks: 10,
            maxNodes: 1_000,
            maxDepth: 32,
          },
        }),
      };
    };
    let sectionSequence = 0;
    const broker = new ResearchCapabilityBroker(request({
      seeds: [seed({ product: "confluence", entityKind: "page", key: "1001", name: "Page", id: "page-1001" })],
      wiki: ["~account-id"],
      exact: ["confluence"],
    }), fake, {
      createAnchorId: () => "anchor",
      createSectionId: () => `section-${++sectionSequence}`,
      createCaptureId: () => `capture-${sourceVersion}`,
    });
    const anchor = broker.exactAnchors()[0]!.anchorRef;
    const first = await invokeDirect(broker, anchor);
    const staleRef = first.document!.sections[0]!.sectionRef;

    sourceVersion = 8;
    const second = await invokeDirect(broker, anchor);
    const currentRef = second.document!.sections[0]!.sectionRef;
    expect(second.document!.snapshot).toEqual({
      sourceId: "wiki:1001",
      representation: "storage",
      sourceVersion: 8,
      captureRef: "research-capture:capture-8",
    });
    await expect(broker.readExactSection({
      schema: BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
      sectionRef: staleRef,
    })).rejects.toMatchObject({ code: "invalid-request" });
    const current = await broker.readExactSection({
      schema: BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
      sectionRef: currentRef,
    });
    expect(current.content.text).toContain("Snapshot version 8");
    expect(calls).toEqual(["wiki.get:1001:v7", "wiki.get:1001:v8"]);
  });
});
