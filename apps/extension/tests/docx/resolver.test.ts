import { describe, expect, it, mock } from "bun:test";
import type { ConfluencePageDetails, ConfluenceSpace } from "@atlcli/confluence/browser";
import {
  resolveOne,
  resolvePlaceholders,
  type CurrentUser,
  type ResolveContext,
} from "../../utils/docx/resolver.js";

const details: ConfluencePageDetails = {
  id: "123",
  title: "Q3 Architecture Overview",
  url: "https://x.atlassian.net/wiki/spaces/ENG/pages/123",
  version: 7,
  spaceKey: "ENG",
  storage: "<p>body</p>",
  tinyUrl: "https://x.atlassian.net/wiki/x/AbC",
  created: "2026-01-02T10:00:00.000Z",
  modified: "2026-06-30T12:30:00.000Z",
  createdBy: { displayName: "Alice Author", email: "alice@x.com" },
  modifiedBy: { displayName: "Mel Modifier" },
  labels: ["architecture", "review"],
};

const space: ConfluenceSpace = {
  id: "s1",
  key: "ENG",
  name: "Engineering",
  type: "global",
  url: "https://x.atlassian.net/wiki/spaces/ENG",
};

const currentUser: CurrentUser = {
  accountId: "u-1",
  displayName: "Björn Schotte",
  email: "bjoern@x.com",
};

const ctx: ResolveContext = {
  details,
  template: { name: "mayflower.docx", modificationDate: new Date(2026, 6, 14) },
  exportDate: new Date(2026, 6, 14, 9, 5),
};

function value(raw: string): string {
  return resolveOne(raw, ctx, space, currentUser, []);
}

describe("resolveOne — every direct + derivable mapping row", () => {
  const cases: [string, string][] = [
    // Page info
    ["$scroll.title", "Q3 Architecture Overview"],
    ["$scroll.version", "7"],
    ["$scroll.pageid", "123"],
    ["$scroll.pageurl", details.url!],
    ["$scroll.tinyurl", details.tinyUrl!],
    ["$scroll.pagelabels", "architecture, review"],
    ["$scroll.pagelabels.capitalised", "Architecture, Review"],
    // Creator / modifier
    ["$scroll.creator", "Alice Author"],
    ["$scroll.creator.fullName", "Alice Author"],
    ["$scroll.creator.email", "alice@x.com"],
    ["$scroll.modifier", "Mel Modifier"],
    ["$scroll.modifier.fullName", "Mel Modifier"],
    // Dates
    ["$scroll.creationdate", "2026-01-02"],
    ['$scroll.creationdate.("dd.MM.yyyy")', "02.01.2026"],
    ["$scroll.modificationdate", "2026-06-30"],
    ["$scroll.exportdate", "2026-07-14"],
    ['$scroll.exportdate.("dd.MM.yyyy")', "14.07.2026"],
    // Space
    ["$scroll.space.key", "ENG"],
    ["$scroll.space.name", "Engineering"],
    ["$scroll.space.url", space.url!],
    // Export info
    ["$scroll.exporter", "Björn Schotte"],
    ["$scroll.exporter.fullName", "Björn Schotte"],
    ["$scroll.exporter.email", "bjoern@x.com"],
    ["$scroll.template.name", "mayflower.docx"],
    ['$scroll.template.modificationdate.("yyyy/MM/dd")', "2026/07/14"],
  ];
  for (const [raw, expected] of cases) {
    it(`${raw} → "${expected}"`, () => {
      expect(value(raw)).toBe(expected);
    });
  }

  it("modifier.email is empty (absent on Cloud) with a note", () => {
    const notes: import("@atlcli/confluence/browser").ExportNote[] = [];
    expect(resolveOne("$scroll.modifier.email", ctx, space, currentUser, notes)).toBe("");
    expect(notes.some((n) => n.code === "placeholder-empty")).toBe(true);
  });

  it("exportdate with an unknown format token falls back to ISO + a note (#10)", () => {
    const notes: import("@atlcli/confluence/browser").ExportNote[] = [];
    const out = resolveOne('$scroll.exportdate.("yyyy-QQ")', ctx, space, currentUser, notes);
    expect(out).toBe("2026-07-14"); // ISO fallback for the export date
    expect(notes.some((n) => n.code === "date-format-unknown")).toBe(true);
  });
});

describe("resolvePlaceholders — lazy fetching", () => {
  it("does NOT call getSpace / getCurrentUser when no placeholder needs them", async () => {
    const getSpace = mock(async () => space);
    const getCurrentUser = mock(async () => currentUser);
    await resolvePlaceholders(["$scroll.title", "$scroll.pageid"], ctx, { getSpace, getCurrentUser });
    expect(getSpace).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("calls getSpace only when a space placeholder is present", async () => {
    const getSpace = mock(async () => space);
    const getCurrentUser = mock(async () => currentUser);
    const res = await resolvePlaceholders(["$scroll.space.name"], ctx, { getSpace, getCurrentUser });
    expect(getSpace).toHaveBeenCalledTimes(1);
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(res.values.get("$scroll.space.name")).toBe("Engineering");
  });

  it("calls getCurrentUser only when an exporter placeholder is present", async () => {
    const getSpace = mock(async () => space);
    const getCurrentUser = mock(async () => currentUser);
    await resolvePlaceholders(["$scroll.exporter.fullName"], ctx, { getSpace, getCurrentUser });
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
    expect(getSpace).not.toHaveBeenCalled();
  });

  it("fetches each resource at most once for multiple placeholders", async () => {
    const getSpace = mock(async () => space);
    await resolvePlaceholders(["$scroll.space.name", "$scroll.space.url"], ctx, { getSpace });
    expect(getSpace).toHaveBeenCalledTimes(1);
  });

  it("notes a needed exporter placeholder when no user fetcher is provided (#12)", async () => {
    const res = await resolvePlaceholders(["$scroll.exporter.fullName"], ctx, {});
    expect(res.values.get("$scroll.exporter.fullName")).toBe("");
    expect(res.notes.some((n) => n.code === "user-unavailable")).toBe(true);
  });

  it("notes a needed space placeholder when no space fetcher is provided (#12)", async () => {
    const res = await resolvePlaceholders(["$scroll.space.name"], ctx, {});
    expect(res.values.get("$scroll.space.name")).toBe("");
    expect(res.notes.some((n) => n.code === "space-unavailable")).toBe(true);
  });
});

describe("resolvePlaceholders — pinning: never a literal", () => {
  it("maps unsupported and never placeholders to empty string + report entry", async () => {
    const res = await resolvePlaceholders(
      ["$scroll.pageowner.fullName", "$adhocState", "$scroll.pageproperty.(status)"],
      ctx,
      {}
    );
    expect(res.values.get("$scroll.pageowner.fullName")).toBe("");
    expect(res.values.get("$adhocState")).toBe("");
    expect(res.values.get("$scroll.pageproperty.(status)")).toBe("");
    // Every value is a string; none contains a literal $scroll./$adhoc.
    for (const v of res.values.values()) {
      expect(v).not.toContain("$scroll.");
      expect(v).not.toContain("$adhocState");
    }
    expect(res.unsupportedNames.length).toBeGreaterThan(0);
  });
});
