import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import React from "react";
import {
  ResearchScreen,
  inferResearchScope,
} from "../components/screens/ResearchScreen.js";
import { I18nProvider } from "../utils/i18n/context.js";
import type {
  ResearchPort,
  ResearchReportV1,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import type { ScreenProps } from "../utils/screens/registry.js";
import type { AppPorts } from "../utils/ports/index.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => {
  expect(dom.leakedGlobals()).toEqual([]);
});

const report: ResearchReportV1 = {
  schema: "atlcli.research-report/v1",
  title: "Guarded research",
  question: "How are DEMO-1 and KB related?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  executiveSummary: "The page explicitly links the issue.",
  findings: [
    {
      id: "finding-1",
      classification: "fact",
      summary: "The design is documented.",
      sourceIds: ["wiki:1001"],
    },
  ],
  relationships: [
    {
      id: "relationship-1",
      classification: "verified",
      jiraIssueKey: "DEMO-1",
      confluenceContentId: "1001",
      summary: "Exact link.",
      sourceIds: ["jira:DEMO-1", "wiki:1001"],
    },
  ],
  limitations: ["Synthetic result."],
  sources: [
    {
      id: "jira:DEMO-1",
      product: "jira",
      title: "Issue",
      url: "https://example.atlassian.net/browse/DEMO-1",
      issueKey: "DEMO-1",
      projectKey: "DEMO",
    },
    {
      id: "wiki:1001",
      product: "confluence",
      title: "Design",
      url: "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
      contentId: "1001",
      spaceKey: "KB",
    },
  ],
  run: {
    model: "claude-sonnet-4-6",
    wikiProvider: "rest",
    startedAt: "2026-07-30T10:00:00.000Z",
    completedAt: "2026-07-30T10:00:01.000Z",
    durationMs: 1_000,
    complete: true,
    counts: { ptcCalls: 8, httpCalls: 8, jiraItems: 2, confluenceItems: 2 },
    usage: { inputTokens: 100, outputTokens: 50 },
    warnings: [],
  },
  markdown: "# Guarded research\n\nSafe Markdown.",
};

function screenProps(port: ResearchPort): ScreenProps {
  return {
    ports: {
      host: {
        kind: "test",
        name: "test",
        version: "1",
        capabilities: ["research"],
      },
      research: port,
    } as unknown as AppPorts,
    page: {
      status: "loaded",
      token: 1,
      lastSeq: 1,
      ref: {
        url: "https://example.atlassian.net/wiki/spaces/KB/pages/1001/Design",
        entity: {
          product: "confluence",
          type: "page",
          pageId: "1001",
          spaceKey: "KB",
        },
      },
      contentId: "1001",
      page: {
        details: {
          id: "1001",
          title: "Design",
          spaceKey: "KB",
          version: 1,
          storage: "<p>Design</p>",
        },
        markdown: "Design",
        wordCount: 1,
        attachments: [],
      },
    },
    retry: () => undefined,
    navigate: () => undefined,
  };
}

describe("research scope inference", () => {
  it("extracts the project and space keys from the question the user described", () => {
    expect(
      inferResearchScope({
        siteOrigin: "https://example.atlassian.net",
        question:
          "Nutze Jira Projektkey ATLCLI und Confluence Spacekey DOCSY für den Bericht.",
        jiraProjects: "",
        confluenceSpaces: "",
        activeSpaceKey: "CURRENT",
      })
    ).toMatchObject({
      jiraProjectKeys: ["ATLCLI"],
      confluenceSpaceKeys: ["DOCSY"],
      scopeSeeds: [
        { binding: { key: "ATLCLI", source: "natural_language", authority: "approved" }, precedence: 400 },
        { binding: { key: "DOCSY", source: "natural_language", authority: "approved" }, precedence: 400 },
        { binding: { key: "CURRENT", source: "current_context", authority: "approved" }, precedence: 300 },
      ],
    });
  });

  it("keeps manual scope locked while retaining removable current context", () => {
    expect(inferResearchScope({
      siteOrigin: "https://example.atlassian.net",
      question: "Research the current context.",
      jiraProjects: "MANUAL, SECOND",
      confluenceSpaces: "DOCS",
      activeProjectKey: "CURRENT",
      activeSpaceKey: "CURRENTSPACE",
    })).toMatchObject({
      jiraProjectKeys: ["MANUAL", "SECOND"],
      confluenceSpaceKeys: ["DOCS"],
      scopeSeeds: [
        { binding: { key: "MANUAL", source: "ui_added", authority: "locked" }, precedence: 500 },
        { binding: { key: "SECOND", source: "ui_added", authority: "locked" }, precedence: 500 },
        { binding: { key: "CURRENT", source: "current_context", authority: "approved" }, precedence: 300 },
        { binding: { key: "DOCS", source: "ui_added", authority: "locked" }, precedence: 500 },
        { binding: { key: "CURRENTSPACE", source: "current_context", authority: "approved" }, precedence: 300 },
      ],
    });
  });
});

describe("portable Research screen", () => {
  it("stores the key through the port, infers scope, runs, and renders safe structured output", async () => {
    let stored = false;
    const observed: ResearchRequestV1[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => stored,
      setApiKey: async () => {
        stored = true;
      },
      clearApiKey: async () => {
        stored = false;
      },
      run: async (request, options) => {
        observed.push(request);
        options?.onProgress?.({
          phase: "researching",
          message: "Synthetic progress",
          completedCalls: 2,
          maxCalls: 32,
        });
        options?.onEvent?.({
          kind: "subagent",
          seq: 1,
          at: "2026-07-31T12:00:00.000Z",
          taskId: "research-task:1",
          roleId: "wiki-retrieval",
          status: "started",
        });
        options?.onEvent?.({
          kind: "capability",
          seq: 2,
          at: "2026-07-31T12:00:00.000Z",
          callId: "wiki.search:1",
          toolId: "wiki.search",
          inputKind: "search",
          status: "completed",
          itemCount: 10,
          termination: "item-limit",
          durationMs: 42,
        });
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="de">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>
    );
    await dom.setValue("research-key", "synthetic-key");
    await dom.setValue(
      "research-question",
      "Nutze Jira Projektkey DEMO und Confluence Spacekey KB: Wie hängen DEMO-1 und Seite 1001 zusammen?"
    );
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(stored).toBe(true);
    expect(observed[0]!.scope).toMatchObject({
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
    });
    expect(observed[0]!.scopeSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: expect.objectContaining({ source: "natural_language", key: "DEMO" }),
      }),
      expect.objectContaining({
        binding: expect.objectContaining({ source: "current_context", key: "KB" }),
      }),
    ]));
    expect(dom.find("research-formatted-report").textContent).toContain(
      "The page explicitly links the issue."
    );
    expect(dom.find("research-activity").textContent).toContain(
      "agent · wiki-retrieval · started"
    );
    expect(dom.find("research-activity").textContent).toContain(
      "tool · wiki.search · search · completed · 10 items · item-limit · 42 ms"
    );
    await dom.toggle("research-current-context");
    await dom.click("research-run");
    await dom.flush();
    expect(observed[1]!.scopeSeeds?.some(
      (seed) => seed.binding.source === "current_context",
    )).toBe(false);
    expect(dom.html()).not.toContain("<script");
    expect((globalThis as Record<string, unknown>).chrome).toBeUndefined();
  });
});
