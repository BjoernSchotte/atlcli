import { describe, expect, test } from "bun:test";
import { rankResearchCandidatesV1 } from "./candidate-ranking.js";

describe("research candidate ranking", () => {
  test("prioritizes an exact quoted title and returns opaque references only", () => {
    const ranked = rankResearchCandidatesV1({
      question: "How does \"Lead Pipeline\" relate to qualification?",
      candidates: [
        { entityRef: "research-entity:other", sourceId: "wiki:2", title: "Qualification notes", excerpt: "General notes." },
        { entityRef: "research-entity:lead", sourceId: "wiki:1", title: "Lead Pipeline", excerpt: "Qualification process." },
      ],
    });

    expect(ranked).toEqual([
      { entityRef: "research-entity:lead", sourceId: "wiki:1", rank: 1 },
      { entityRef: "research-entity:other", sourceId: "wiki:2", rank: 2 },
    ]);
    expect(JSON.stringify(ranked)).not.toContain("Qualification process");
  });

  test("uses a stable source-id tie break when no question term matches", () => {
    expect(rankResearchCandidatesV1({
      question: "Which records are relevant?",
      candidates: [
        { entityRef: "research-entity:b", sourceId: "jira:B", title: "Beta" },
        { entityRef: "research-entity:a", sourceId: "jira:A", title: "Alpha" },
      ],
    })).toEqual([
      { entityRef: "research-entity:a", sourceId: "jira:A", rank: 1 },
      { entityRef: "research-entity:b", sourceId: "jira:B", rank: 2 },
    ]);
  });
});
