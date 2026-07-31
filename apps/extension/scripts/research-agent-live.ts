import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import type {
  ResearchProviderPage,
  ResearchReadProviders,
} from "../utils/research/broker.js";
import {
  RESEARCH_MODEL_ID,
  runResearchAgent,
} from "../utils/research/agent-runtime.js";
import { composeStandardResearchGraphV1 } from "@atlcli/research/graph";

const SITE_ORIGIN = "https://synthetic.atlassian.net";
const PROJECT_KEY = "DEMO";
const SPACE_KEY = "KB";

function syntheticProviders(): ResearchReadProviders {
  return {
    jira: {
      async searchPage({ providerCursor, signal }) {
        signal.throwIfAborted();
        const page: ResearchProviderPage<{
          issueKey: string;
          projectKey: string;
          title: string;
          excerpt: string;
          updatedAt: string;
        }> = providerCursor
          ? {
              items: [
                {
                  issueKey: "DEMO-2",
                  projectKey: PROJECT_KEY,
                  title: "Add formatted Markdown report",
                  excerpt:
                    "Render a structured, cited research result as safe Markdown.",
                  updatedAt: "2026-07-29T09:00:00.000Z",
                },
              ],
            }
          : {
              items: [
                {
                  issueKey: "DEMO-1",
                  projectKey: PROJECT_KEY,
                  title: "Build bounded read-only research agent",
                  excerpt:
                    "Use QuickJS programmatic tool calling with four read-only tools.",
                  updatedAt: "2026-07-30T10:00:00.000Z",
                },
              ],
              nextProviderCursor: "jira-page-2",
            };
        return page;
      },
      async getIssue({ issueKey, signal }) {
        signal.throwIfAborted();
        if (issueKey === "DEMO-1") {
          return {
            issueKey,
            projectKey: PROJECT_KEY,
            title: "Build bounded read-only research agent",
            excerpt:
              "Use QuickJS programmatic tool calling with four read-only tools.",
            updatedAt: "2026-07-30T10:00:00.000Z",
            content: {
              text: "DEMO-1 implements the read-only agent. Its accepted design is the Confluence Research design page.",
              linkTargets: [`${SITE_ORIGIN}/wiki/spaces/KB/pages/1001`],
              truncated: false,
              inputBytes: 101,
            },
          };
        }
        return {
          issueKey,
          projectKey: PROJECT_KEY,
          title: "Add formatted Markdown report",
          excerpt: "Render a structured, cited research result as safe Markdown.",
          updatedAt: "2026-07-29T09:00:00.000Z",
          content: {
            text: "DEMO-2 consumes the structured report and renders host-generated Markdown.",
            linkTargets: [],
            truncated: false,
            inputBytes: 76,
          },
        };
      },
    },
    wiki: {
      async searchPage({ providerCursor, signal }) {
        signal.throwIfAborted();
        return providerCursor
          ? {
              items: [
                {
                  contentId: "1002",
                  spaceKey: SPACE_KEY,
                  title: "Markdown output contract",
                  excerpt:
                    "Markdown is the portable intermediate representation for later exporters.",
                  updatedAt: "2026-07-29T08:00:00.000Z",
                },
              ],
            }
          : {
              items: [
                {
                  contentId: "1001",
                  spaceKey: SPACE_KEY,
                  title: "Research design",
                  excerpt:
                    "The design limits the agent to Jira and Confluence read capabilities.",
                  updatedAt: "2026-07-30T08:00:00.000Z",
                },
              ],
              nextProviderCursor: "wiki-page-2",
            };
      },
      async getPage({ contentId, signal }) {
        signal.throwIfAborted();
        if (contentId === "1001") {
          return {
            contentId,
            spaceKey: SPACE_KEY,
            title: "Research design",
            excerpt:
              "The design limits the agent to Jira and Confluence read capabilities.",
            updatedAt: "2026-07-30T08:00:00.000Z",
            content: {
              text: "The design for DEMO-1 requires QuickJS PTC, opaque pagination cursors, strict budgets, and read-only Jira plus Confluence tools.",
              linkTargets: [`${SITE_ORIGIN}/browse/DEMO-1`],
              truncated: false,
              inputBytes: 126,
            },
          };
        }
        return {
          contentId,
          spaceKey: SPACE_KEY,
          title: "Markdown output contract",
          excerpt:
            "Markdown is the portable intermediate representation for later exporters.",
          updatedAt: "2026-07-29T08:00:00.000Z",
          content: {
            text: "The host, not the model, creates deterministic Markdown from a validated structured report.",
            linkTargets: [`${SITE_ORIGIN}/browse/DEMO-2`],
            truncated: false,
            inputBytes: 88,
          },
        };
      },
    },
  };
}

function questionFromArguments(): string {
  const value = Bun.argv.slice(2).join(" ").trim();
  return (
    value ||
    "For Jira project DEMO and Confluence space KB, what is the bounded research approach, how are DEMO-1 and page 1001 related, and what role does Markdown play?"
  );
}

async function main(): Promise<void> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is missing. Add it to the ignored repository .env file."
    );
  }
  const request = normalizeResearchRequestV1({
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: questionFromArguments(),
    scope: {
      siteOrigin: SITE_ORIGIN,
      jiraProjectKeys: [PROJECT_KEY],
      confluenceSpaceKeys: [SPACE_KEY],
    },
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      pageSize: 1,
      maxSearchPagesPerProduct: 3,
      maxItemsPerProduct: 4,
      maxDetailItemsPerProduct: 4,
      maxPtcCalls: 16,
      maxHttpCalls: 16,
      maxModelOutputTokens: 4_096,
      maxRunMs: 120_000,
    },
    wikiProvider: "rest",
  });

  console.error(
    `[research-live] model=${RESEARCH_MODEL_ID} source=synthetic key=present`
  );
  const report = await runResearchAgent({
    apiKey,
    request,
    providers: syntheticProviders(),
    runId: `synthetic-live-${crypto.randomUUID()}`,
    researchGraph: composeStandardResearchGraphV1(request.question),
    onPtcDiagnostic: (diagnostic) =>
      console.error(`[research-live] ptc=${JSON.stringify(diagnostic)}`),
    options: {
      signal: AbortSignal.timeout(request.limits.maxRunMs),
      onProgress: (progress) =>
        console.error(`[research-live] phase=${progress.phase}`),
    },
  });
  console.log(report.markdown);
}

await main();
