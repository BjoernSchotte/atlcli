import { describe, expect, test } from "bun:test";
import {
  findResearchPrivacyViolations,
  readTrackedResearchPrivacyFile,
  type ResearchPrivacyFile,
} from "./research-privacy.js";

const scan = (...files: ResearchPrivacyFile[]) =>
  findResearchPrivacyViolations(files).map(({ path, rule }) => `${path}:${rule}`);

describe("research privacy gate", () => {
  test("allows approved test scopes, synthetic tenants, and explicit fake keys", () => {
    expect(scan({
      path: "fixture.ts",
      content: [
        "DOCSY ATLCLI https://example.atlassian.net",
        "sk-ant-test-fixture-only",
        "sk-ant-packed-extension-test-only",
      ].join("\n"),
    })).toEqual([]);
  });

  test("rejects confidential project and space keys without embedding them in this fixture", () => {
    const project = ["GR", "OW"].join("");
    const space = ["R", "CM"].join("");
    expect(scan({ path: "report.md", content: `${project} ${space}` })).toEqual([
      "report.md:confidential-atlassian-scope",
    ]);
  });

  test("rejects private Atlassian identity values", () => {
    const tenant = ["mayflower", "gmbh", ".atlassian.net"].join("");
    const account = ["70121:666cbd78", "-32fa-4764-90a1-", "d3368305f07b"].join("");
    const cloud = ["ca7c5cc9-632e-", "4985-b88e-", "fb2a96c0b9ca"].join("");
    expect(scan({ path: "fixture.json", content: `${tenant} ${account} ${cloud}` })).toEqual([
      "fixture.json:private-atlassian-account-id",
      "fixture.json:private-atlassian-cloud-id",
      "fixture.json:private-atlassian-tenant",
    ]);
  });

  test("rejects live-looking Anthropic keys but reports no secret content", () => {
    const key = ["sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
    expect(scan({ path: "leak.txt", content: key })).toEqual([
      "leak.txt:anthropic-api-key",
    ]);
  });

  test("rejects tracked private artifacts and environment files", () => {
    expect(scan(
      { path: ".env.local", content: "" },
      { path: "tmp/run.research-report.private.md", content: "" },
    )).toEqual([
      ".env.local:tracked-environment-file",
      "tmp/run.research-report.private.md:tracked-private-research-artifact",
    ]);
  });

  test("does not interpret compressed binary bytes as text", () => {
    const coincidentalBytes = ["R", "CM"].join("");
    expect(scan({ path: "image.png", content: coincidentalBytes, binary: true })).toEqual([]);
  });

  test("skips a tracked path deleted in the working tree", async () => {
    await expect(readTrackedResearchPrivacyFile(
      "/tmp/atlcli-research-privacy-missing-root",
      "deleted-tracked-file.ts",
    )).resolves.toBeUndefined();
  });
});
