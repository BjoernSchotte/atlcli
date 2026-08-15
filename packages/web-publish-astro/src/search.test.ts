import { expect, test } from "bun:test";
import { normalizePagefindSearchFiltersV1 } from "./search.js";

test("normalizes the label shorthand into a bounded Pagefind facet", () => {
  expect(normalizePagefindSearchFiltersV1(["guide", "release"], undefined)).toEqual([{
    name: "label", label: "Filter by label", values: ["guide", "release"],
  }]);
});

test("accepts multiple explicit allowlisted facets and rejects ambiguous keys", () => {
  expect(normalizePagefindSearchFiltersV1([], [
    { name: "space", label: "Space", values: ["DOCSY"] },
    { name: "language", label: "Language", values: ["en", "de"] },
  ])).toEqual([
    { name: "space", label: "Space", values: ["DOCSY"] },
    { name: "language", label: "Language", values: ["en", "de"] },
  ]);
  expect(() => normalizePagefindSearchFiltersV1([], [
    { name: "label", label: "Label", values: ["guide"] },
    { name: "label", label: "Second label", values: ["release"] },
  ])).toThrow("unique lowercase identifiers");
  expect(() => normalizePagefindSearchFiltersV1([], [
    { name: "unsafe name", label: "Label", values: ["guide"] },
  ])).toThrow("unique lowercase identifiers");
});
