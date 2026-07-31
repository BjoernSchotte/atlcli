import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import {
  RESEARCH_ONE_SHOT_REQUEST_PATH_V1,
  RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1,
  createMemoryResearchWorkspace,
  normalizeResearchRequestV1,
  type ResearchOneShotEventV1,
} from "./index.js";
import { runResearchAgent as runBrowserResearchAgent } from "./agent-runtime.browser.js";
import { runResearchAgent as runNodeResearchAgent } from "./agent-runtime.node.js";
import {
  composeStandardResearchGraphV1,
} from "./graph.js";

const request = normalizeResearchRequestV1({
  schema: "atlcli.research-request/v1",
  question: "Summarize the bounded synthetic evidence.",
  scope: {
    siteOrigin: "https://synthetic.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  wikiProvider: "rest",
});

const graph = composeStandardResearchGraphV1(request.question);

const draft = {
  title: "Cross-host synthetic report",
  executiveSummary: "No source evidence was supplied to this parity run.",
  findings: [],
  relationships: [],
  limitations: ["Synthetic host-parity scenario."],
};

function model() {
  const code = `
    const finalDraft = await task({
      description: "Write the deterministic empty-evidence report.",
      subagentType: "synthesizer",
      responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
    });
    finalDraft;
  `;
  return fakeModel()
    .respondWithTools([{ name: "eval", args: { code } }])
    .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
    .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);
}

const providers = {
  jira: {
    async searchPage() { return { items: [] }; },
    async getIssue() { throw new Error("not reached"); },
  },
  wiki: {
    async searchPage() { return { items: [] }; },
    async getPage() { throw new Error("not reached"); },
  },
};

describe("research one-shot host parity", () => {
  test("produces schema-equivalent reports and byte-identical Markdown in Node and browser runtimes", async () => {
    const nodeWorkspace = createMemoryResearchWorkspace();
    const browserWorkspace = createMemoryResearchWorkspace();
    const nodeEvents: ResearchOneShotEventV1[] = [];
    const browserEvents: ResearchOneShotEventV1[] = [];
    const common = {
      request,
      providers,
      researchGraph: graph,
      runId: "host-parity",
      now: () => Date.parse("2026-07-31T12:00:00.000Z"),
    };

    const [nodeReport, browserReport] = await Promise.all([
      runNodeResearchAgent({
        ...common,
        model: model(),
        workspace: nodeWorkspace,
        options: { onEvent: (event) => nodeEvents.push(event) },
      }),
      runBrowserResearchAgent({
        ...common,
        model: model(),
        workspace: browserWorkspace,
        options: { onEvent: (event) => browserEvents.push(event) },
      }),
    ]);

    expect(nodeReport).toEqual(browserReport);
    expect(new TextEncoder().encode(nodeReport.markdown)).toEqual(
      new TextEncoder().encode(browserReport.markdown),
    );
    expect(await nodeWorkspace.readFile("/artifacts/report.md")).toBe(nodeReport.markdown);
    expect(await browserWorkspace.readFile("/artifacts/report.md")).toBe(browserReport.markdown);
    expect(await nodeWorkspace.readFile(RESEARCH_ONE_SHOT_REQUEST_PATH_V1)).toBe(
      await browserWorkspace.readFile(RESEARCH_ONE_SHOT_REQUEST_PATH_V1),
    );
    expect(JSON.parse((await nodeWorkspace.readFile(RESEARCH_ONE_SHOT_REQUEST_PATH_V1))!)).toEqual({
      runId: "host-parity",
      request,
    });
    expect(nodeEvents).toEqual(browserEvents);
    expect(nodeEvents.map((event) => event.seq)).toEqual(
      nodeEvents.map((_, index) => index + 1),
    );
    expect(nodeEvents).toContainEqual(expect.objectContaining({
      kind: "artifact",
      path: "/artifacts/report.md",
    }));
    expect(JSON.stringify(nodeEvents)).not.toMatch(/question|sourceBody|cursor|credential|prompt/i);
  });
});
