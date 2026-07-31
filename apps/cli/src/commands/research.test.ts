import { describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { buildResearchRequest, parseResearchCliInput, researchArtifactPath } from "./research.js";

const profile: Profile = {
  name: "mayflower",
  baseUrl: "https://tenant-a.atlassian.net",
  project: "ATLCLI",
  space: "DOCSY",
  auth: { type: "apiToken", email: "test@example.invalid", token: "test" },
};

describe("research CLI one-shot contract", () => {
  test("parses repeatable locked scope flags and the fixed-date question context", () => {
    const input = parseResearchCliInput(
      ["Which", "items", "are", "related?"],
      {
        project: ["atlcli", "ATLCLI"],
        space: "DOCSY",
        "as-of": "2026-07-31",
        timezone: "Europe/Berlin",
        "keep-session": true,
      },
    );
    expect(input.projectKeys).toEqual(["ATLCLI"]);
    expect(input.spaceKeys).toEqual(["DOCSY"]);
    expect(input.keepSession).toBe(true);
    expect(input.maxRunMinutes).toBe(10);
    expect(input.question).toContain("As-of date: 2026-07-31.");
    expect(input.question).toContain("Timezone: Europe/Berlin.");
  });

  test("accepts a bounded workflow deadline override", () => {
    const input = parseResearchCliInput(["Find related content"], { "max-run-minutes": "7" });
    const request = buildResearchRequest(input, profile);
    expect(input.maxRunMinutes).toBe(7);
    expect(request.limits.maxRunMs).toBe(7 * 60_000);
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": true })).toThrow("requires an integer");
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": "0" })).toThrow("between 1 and 10");
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": "2.5" })).toThrow("between 1 and 10");
    expect(() => parseResearchCliInput(["question"], { "max-run-minutes": "11" })).toThrow("between 1 and 10");
  });

  test("uses profile defaults only when explicit keys are absent", () => {
    const input = parseResearchCliInput(["Find related content"], {});
    const request = buildResearchRequest(input, profile);
    expect(request.scope).toMatchObject({
      siteOrigin: "https://tenant-a.atlassian.net",
      jiraProjectKeys: ["ATLCLI"],
      confluenceSpaceKeys: ["DOCSY"],
    });
    expect(request.limits).toMatchObject({
      maxSearchPagesPerProduct: 4,
      maxBodyCharsPerItem: 50_000,
      maxRunMs: 600_000,
    });
  });

  test("keeps future durable-session flags out of the one-shot contract", () => {
    expect(() => parseResearchCliInput(["question"], { resume: "r1" })).toThrow("reserved for durable sessions");
  });

  test("places every report in a timestamped Documents artifact directory", () => {
    expect(researchArtifactPath(new Date("2026-07-31T08:55:17.123Z"))).toMatch(
      /Documents\/atlcli\/artefacts\/research-2026-07-31-08-55-17-123\/report\.md$/,
    );
  });
});
