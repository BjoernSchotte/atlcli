import { afterEach, describe, expect, it } from "bun:test";
import { ReplSession } from "@langchain/quickjs";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import { ResearchCapabilityBroker } from "@atlcli/research";
import {
  createResearchPtcTools,
  type ResearchPtcDiagnosticV1,
} from "@atlcli/research/browser/agent";

const toolNames = [
  "jira_issue_search",
  "jira_issue_get",
  "wiki_search",
  "wiki_page_get",
] as const;

function readTools() {
  return toolNames.map((name) =>
    tool(async (input) => JSON.stringify({ name, input }), {
      name,
      description: `Synthetic ${name} read tool`,
      schema: z.object({ value: z.string() }).strict(),
    })
  );
}

afterEach(() => {
  ReplSession.clearCache();
  ReplSession.resetSharedModule();
});

describe("QuickJS research sandbox", () => {
  it("keeps wire schema ids host-owned while exposing simple model arguments", async () => {
    const request = normalizeResearchRequestV1({
      schema: RESEARCH_REQUEST_SCHEMA_V1,
      question: "Find the bounded issue.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["KB"],
      },
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      wikiProvider: "rest",
    });
    const broker = new ResearchCapabilityBroker(request, {
      jira: {
        async searchPage({ providerCursor }) {
          return providerCursor
            ? {
                items: [
                  {
                    issueKey: "DEMO-2",
                    projectKey: "DEMO",
                    title: "Second bounded issue",
                  },
                ],
              }
            : {
            items: [
              {
                issueKey: "DEMO-1",
                projectKey: "DEMO",
                title: "Bounded issue",
              },
            ],
                nextProviderCursor: "provider-page-2",
              };
        },
        async getIssue() {
          throw new Error("not used");
        },
      },
      wiki: {
        async searchPage() {
          return { items: [] };
        },
        async getPage() {
          throw new Error("not used");
        },
      },
    });
    try {
      const diagnostics: ResearchPtcDiagnosticV1[] = [];
      const jiraSearch = createResearchPtcTools(broker, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }).find(
        (candidate) => candidate.name === "jira_issue_search"
      );
      expect(jiraSearch).toBeDefined();
      const result = JSON.parse(
        String(await jiraSearch!.invoke({ query: {} }))
      ) as {
        items: Array<{ issueKey: string }>;
        page: { nextCursor: string };
      };
      expect(result.items[0]?.issueKey).toBe("DEMO-1");
      const continuation = JSON.parse(
        String(
          await jiraSearch!.invoke({
            query: { cursor: result.page.nextCursor },
          })
        )
      ) as { items: Array<{ issueKey: string }> };
      expect(continuation.items[0]?.issueKey).toBe("DEMO-2");
      expect(diagnostics.filter((diagnostic) => diagnostic.outcome === "success")).toEqual([
        expect.objectContaining({ inputKind: "search", itemCount: 1, resultBytes: expect.any(Number) }),
        expect.objectContaining({ inputKind: "continuation", itemCount: 1, resultBytes: expect.any(Number) }),
      ]);
      expect(diagnostics.every((diagnostic) => !("result" in diagnostic))).toBe(true);
    } finally {
      broker.cancel();
    }
  });

  it("exposes exactly the four PTC reads and no host escape hatches", async () => {
    const session = new ReplSession("research-sandbox-contract", {
      tools: readTools(),
      maxPtcCalls: 4,
      memoryLimitBytes: 64 * 1024 * 1024,
      maxStackSizeBytes: 320 * 1024,
      captureConsole: false,
    });
    try {
      const result = await session.eval(
        `({
          tools: Object.keys(tools).sort(),
          fetch: typeof fetch,
          chrome: typeof chrome,
          process: typeof process,
          require: typeof require,
          task: typeof task,
          readFile: typeof readFile,
          writeFile: typeof writeFile
        })`,
        5_000
      );

      expect(result.ok).toBe(true);
      expect(result.value).toEqual({
        tools: ["jiraIssueGet", "jiraIssueSearch", "wikiPageGet", "wikiSearch"],
        fetch: "undefined",
        chrome: "undefined",
        process: "undefined",
        require: "undefined",
        task: "undefined",
        readFile: "undefined",
        writeFile: "undefined",
      });
    } finally {
      session.dispose();
    }
  });

  it("calls bridged reads from guest code and returns JSON strings", async () => {
    const session = new ReplSession("research-sandbox-ptc", {
      tools: readTools(),
      maxPtcCalls: 4,
      captureConsole: false,
    });
    try {
      const result = await session.eval(
        `JSON.parse(await tools.jiraIssueSearch({ value: "DEMO" }))`,
        5_000
      );

      expect(result).toMatchObject({
        ok: true,
        value: {
          name: "jira_issue_search",
          input: { value: "DEMO" },
        },
      });
    } finally {
      session.dispose();
    }
  });

  it("enforces the per-evaluation PTC call budget", async () => {
    const session = new ReplSession("research-sandbox-budget", {
      tools: readTools(),
      maxPtcCalls: 1,
      captureConsole: false,
    });
    try {
      const result = await session.eval(
        `await tools.jiraIssueSearch({ value: "one" });
         await tools.wikiSearch({ value: "two" });`,
        5_000
      );

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain(
        "PTC call budget exceeded (limit=1, attempted=2"
      );
    } finally {
      session.dispose();
    }
  });
});
