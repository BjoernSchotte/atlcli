import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  RESEARCH_REQUEST_SCHEMA_V1 as browserRequestSchema,
  ResearchContractError as BrowserResearchContractError,
  decodeResearchSearchInputV1 as decodeFromBrowser,
  normalizeResearchRequestV1 as normalizeFromBrowser,
} from "@atlcli/research/browser";
import {
  RESEARCH_REQUEST_SCHEMA_V1 as defaultRequestSchema,
  ResearchContractError as DefaultResearchContractError,
  decodeResearchSearchInputV1 as decodeFromDefault,
  normalizeResearchRequestV1 as normalizeFromDefault,
} from "@atlcli/research";
import {
  ResearchContractError as ExtensionResearchContractError,
  normalizeResearchRequestV1 as normalizeFromExtension,
} from "../../../apps/extension/utils/research/contracts.js";
import {
  decodeResearchSearchInputV1 as decodeFromExtension,
} from "../../../apps/extension/utils/research/capability-contracts.js";
import { runResearchAgent as runNodeResearchAgent } from "@atlcli/research/node";
import * as deepagentsBrowser from "deepagents/browser";
import * as deepagentsNode from "deepagents/node";

describe("@atlcli/research import boundaries", () => {
  it("pins the required DeepAgentsJS common surface without leaking Node-only exports", () => {
    const requiredCommon = [
      "CompositeBackend",
      "StateBackend",
      "createDeepAgent",
      "createFilesystemMiddleware",
      "createSubAgentMiddleware",
      "createSummarizationMiddleware",
      "registerHarnessProfile",
    ] as const;
    for (const symbol of requiredCommon) {
      expect(typeof deepagentsNode[symbol], `node:${symbol}`).toBe("function");
      expect(typeof deepagentsBrowser[symbol], `browser:${symbol}`).toBe("function");
    }
    expect("LocalShellBackend" in deepagentsNode).toBe(true);
    expect("LocalShellBackend" in deepagentsBrowser).toBe(false);
    expect("SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY" in deepagentsNode).toBe(true);
    expect("SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY" in deepagentsBrowser).toBe(false);
  });

  it("keeps default, browser, and legacy extension imports behavior-identical", () => {
    expect(defaultRequestSchema).toBe(browserRequestSchema);
    expect(DefaultResearchContractError).toBe(BrowserResearchContractError);
    expect(DefaultResearchContractError).toBe(ExtensionResearchContractError);
    expect(normalizeFromDefault).toBe(normalizeFromBrowser);
    expect(normalizeFromDefault).toBe(normalizeFromExtension);
    expect(decodeFromDefault).toBe(decodeFromBrowser);
    expect(decodeFromDefault).toBe(decodeFromExtension);
  });

  it("loads the host-neutral root with no browser or Node host graph", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-browser-build.ts",
        "--json",
        "packages/research/src/index.ts",
      ],
      {
        cwd: `${import.meta.dir}/../../..`,
        encoding: "utf8",
      }
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const checks = JSON.parse(result.stdout) as Array<{
      ok: boolean;
      builtinImports: unknown[];
      hostGraphViolations: unknown[];
    }>;
    expect(checks).toEqual([
      expect.objectContaining({
        ok: true,
        builtinImports: [],
        hostGraphViolations: [],
      }),
    ]);
  });

  it("constructs the synthetic Node runtime directly from the node entrypoint", async () => {
    await expect(runNodeResearchAgent({
      apiKey: "synthetic-test-key",
      request: normalizeFromDefault({
        schema: "atlcli.research-request/v1",
        question: "Summarize the synthetic Jira and Confluence evidence.",
        scope: {
          siteOrigin: "https://synthetic.atlassian.net",
          jiraProjectKeys: ["DEMO"],
          confluenceSpaceKeys: ["KB"],
        },
        wikiProvider: "rest",
      }),
      providers: {
        jira: {
          async searchPage() { return { items: [] }; },
          async getIssue() { throw new Error("not reached"); },
        },
        wiki: {
          async searchPage() { return { items: [] }; },
          async getPage() { throw new Error("not reached"); },
        },
      },
    })).rejects.toThrow("validated research graph");
  });

  it("keeps the Node entrypoint free of Bun-only session storage", () => {
    const nodeEntrypoint = readFileSync(
      new URL("./index.node.ts", import.meta.url),
      "utf8",
    );

    expect(nodeEntrypoint).not.toContain("./sqlite-session-store.js");
  });
});
