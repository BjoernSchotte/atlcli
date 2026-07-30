import { getActiveProfile, loadConfig } from "@atlcli/core/node";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import { ResearchRunBudget } from "../utils/research/budget.js";
import { createRestResearchProviders } from "../utils/research/rest-provider.js";
import {
  RESEARCH_MODEL_ID,
  runResearchAgent,
} from "../utils/research/agent-runtime.js";

const PROFILE_NAME = "mayflower";
const PROJECT_KEY = "ATLCLI";
const SPACE_KEY = "DOCSY";

function questionFromArguments(): string {
  const value = Bun.argv.slice(2).join(" ").trim();
  return (
    value ||
    "Welche aktuellen Arbeiten und Dokumentationen im Jira-Projekt ATLCLI und Confluence-Space DOCSY betreffen browserbasierte Exporte oder Agentenfunktionalitäten, und welche Jira-Confluence-Beziehungen sind explizit belegt?"
  );
}

async function main(): Promise<void> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is missing. Add it to the ignored repository .env file."
    );
  }

  const config = await loadConfig();
  const profile = getActiveProfile(config, PROFILE_NAME);
  if (!profile) {
    throw new Error(`The '${PROFILE_NAME}' atlcli profile does not exist.`);
  }
  const siteOrigin = new URL(profile.baseUrl).origin;
  const request = normalizeResearchRequestV1({
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: questionFromArguments(),
    scope: {
      siteOrigin,
      jiraProjectKeys: [PROJECT_KEY],
      confluenceSpaceKeys: [SPACE_KEY],
    },
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      pageSize: 10,
      maxSearchPagesPerProduct: 2,
      maxItemsPerProduct: 20,
      maxDetailItemsPerProduct: 6,
      maxBodyCharsPerItem: 4_000,
      maxPtcCalls: 24,
      maxHttpCalls: 28,
      maxModelOutputTokens: 4_096,
      maxRunMs: 180_000,
    },
    wikiProvider: "rest",
  });
  const budget = new ResearchRunBudget(request.limits);
  const providers = createRestResearchProviders(
    profile,
    request,
    budget,
    { allowProfileAuth: true }
  );

  console.error(
    `[research-live] model=${RESEARCH_MODEL_ID} source=profile:${PROFILE_NAME} project=${PROJECT_KEY} space=${SPACE_KEY} key=present`
  );
  const report = await runResearchAgent({
    apiKey,
    request,
    providers,
    budget,
    runId: `mayflower-live-${crypto.randomUUID()}`,
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
