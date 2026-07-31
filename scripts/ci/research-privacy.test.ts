import { describe, expect, test } from "bun:test";
import {
  findResearchPrivacyViolations,
  parseResearchPrivateMarkers,
  readTrackedResearchPrivacyFile,
  type ResearchPrivacyFile,
} from "./research-privacy.js";

const scan = (files: ResearchPrivacyFile[], privateMarkers: readonly string[] = []) =>
  findResearchPrivacyViolations(files, privateMarkers)
    .map(({ path, rule }) => `${path}:${rule}`);

describe("research privacy gate", () => {
  test("allows approved test scopes, synthetic tenants, and explicit fake keys", () => {
    expect(scan([{
      path: "fixture.ts",
      content: [
        "DOCSY ATLCLI https://example.atlassian.net",
        "sk-ant-test-fixture-only",
        "sk-ant-packed-extension-test-only",
      ].join("\n"),
    }])).toEqual([]);
  });

  test("rejects configured private markers without storing them in the scanner", () => {
    const markers = ["PRIVATE_PROJECT", "private-tenant.atlassian.invalid"];
    expect(scan([
      { path: "report.md", content: "PRIVATE_PROJECT" },
      { path: "fixture.json", content: "https://private-tenant.atlassian.invalid" },
    ], markers)).toEqual([
      "fixture.json:configured-private-marker",
      "report.md:configured-private-marker",
    ]);
  });

  test("parses, trims and deduplicates private markers from the environment", () => {
    expect(parseResearchPrivateMarkers('[" PRIVATE_PROJECT ","PRIVATE_PROJECT",""]'))
      .toEqual(["PRIVATE_PROJECT"]);
    expect(parseResearchPrivateMarkers(undefined)).toEqual([]);
    expect(() => parseResearchPrivateMarkers('{"marker":"PRIVATE_PROJECT"}'))
      .toThrow("ATLCLI_RESEARCH_PRIVATE_MARKERS must be a JSON array of strings");
  });

  test("rejects live-looking Anthropic keys but reports no secret content", () => {
    const key = ["sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
    expect(scan([{ path: "leak.txt", content: key }])).toEqual([
      "leak.txt:anthropic-api-key",
    ]);
  });

  test("rejects tracked private artifacts and environment files", () => {
    expect(scan([
      { path: ".env.local", content: "" },
      { path: "tmp/run.research-report.private.md", content: "" },
    ])).toEqual([
      ".env.local:tracked-environment-file",
      "tmp/run.research-report.private.md:tracked-private-research-artifact",
    ]);
  });

  test("does not interpret compressed binary bytes as text", () => {
    const coincidentalBytes = ["R", "CM"].join("");
    expect(scan([{ path: "image.png", content: coincidentalBytes, binary: true }])).toEqual([]);
  });

  test("skips a tracked path deleted in the working tree", async () => {
    await expect(readTrackedResearchPrivacyFile(
      "/tmp/atlcli-research-privacy-missing-root",
      "deleted-tracked-file.ts",
    )).resolves.toBeUndefined();
  });
});
