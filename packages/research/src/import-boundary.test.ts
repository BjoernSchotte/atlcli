import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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

describe("@atlcli/research import boundaries", () => {
  it("keeps default, browser, and legacy extension imports behavior-identical", () => {
    expect(defaultRequestSchema).toBe(browserRequestSchema);
    expect(DefaultResearchContractError).toBe(BrowserResearchContractError);
    expect(DefaultResearchContractError).toBe(ExtensionResearchContractError);
    expect(normalizeFromDefault).toBe(normalizeFromBrowser);
    expect(normalizeFromDefault).toBe(normalizeFromExtension);
    expect(decodeFromDefault).toBe(decodeFromBrowser);
    expect(decodeFromDefault).toBe(decodeFromExtension);
  });

  it("passes the repository browser graph gate as a standalone entrypoint", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-browser-build.ts",
        "--json",
        "packages/research/src/index.browser.ts",
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
});
