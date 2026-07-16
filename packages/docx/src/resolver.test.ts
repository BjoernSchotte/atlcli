import { describe, expect, it, mock } from "bun:test";
import type { ConfluencePageDetails, ConfluenceSpace } from "@atlcli/confluence";
import {
  resolveOne,
  resolvePlaceholders,
  type CurrentUser,
  type PageOwner,
  type ResolveContext,
} from "./resolver.js";

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

// Deliberately NOT the creator (Alice Author): Cloud ownership is transferable,
// so a resolver that quietly fell back to `createdBy` would still look right on
// most pages. This fixture makes that mistake fail (G1).
const owner: PageOwner = { accountId: "u-9", displayName: "Olga Owner" };

const ctx: ResolveContext = {
  details,
  template: { name: "mayflower.docx", modificationDate: new Date(2026, 6, 14) },
  exportDate: new Date(2026, 6, 14, 9, 5),
};

function value(raw: string): string {
  return resolveOne(raw, ctx, { space, currentUser, owner }, []);
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
    // Owner (G1) — distinct from the creator on purpose.
    ["$scroll.pageowner.fullName", "Olga Owner"],
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
    const notes: import("@atlcli/confluence").ExportNote[] = [];
    expect(resolveOne("$scroll.modifier.email", ctx, { space, currentUser, owner }, notes)).toBe("");
    expect(notes.some((n) => n.code === "placeholder-empty")).toBe(true);
  });

  it("exportdate with a quarter token formats without a note", () => {
    const notes: import("@atlcli/confluence").ExportNote[] = [];
    const out = resolveOne('$scroll.exportdate.("QQQ")', ctx, { space, currentUser, owner }, notes);
    expect(out).toBe("Q3");
    expect(notes.some((n) => n.code === "date-format-unknown")).toBe(false);
  });

  it("exportdate with an unknown format token falls back to ISO + a note (#10)", () => {
    const notes: import("@atlcli/confluence").ExportNote[] = [];
    const out = resolveOne('$scroll.exportdate.("yyyy-EEEE")', ctx, { space, currentUser, owner }, notes);
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

  it("does NOT call getPageOwner unless a pageowner placeholder is present (G1)", async () => {
    const getPageOwner = mock(async () => owner);
    await resolvePlaceholders(["$scroll.title", "$scroll.creator"], ctx, { getPageOwner });
    expect(getPageOwner).not.toHaveBeenCalled();
  });

  it("calls getPageOwner once, with the page id, and resolves the owner (G1)", async () => {
    const getPageOwner = mock(async () => owner);
    const getSpace = mock(async () => space);
    const res = await resolvePlaceholders(["$scroll.pageowner.fullName"], ctx, {
      getPageOwner,
      getSpace,
    });
    expect(getPageOwner).toHaveBeenCalledTimes(1);
    expect(getPageOwner).toHaveBeenCalledWith("123");
    expect(getSpace).not.toHaveBeenCalled();
    // The OWNER, not the creator — a createdBy fallback would yield "Alice Author".
    expect(res.values.get("$scroll.pageowner.fullName")).toBe("Olga Owner");
  });
});

describe("resolvePlaceholders — page owner degradation (G1)", () => {
  it("renders empty + a note when the page has no owner", async () => {
    const getPageOwner = mock(async () => null);
    const res = await resolvePlaceholders(["$scroll.pageowner.fullName"], ctx, { getPageOwner });
    expect(res.values.get("$scroll.pageowner.fullName")).toBe("");
    expect(res.notes.some((n) => n.code === "placeholder-empty")).toBe(true);
  });

  it("renders empty + a warning when the owner fetch throws", async () => {
    const getPageOwner = mock(async () => {
      throw new Error("403");
    });
    const res = await resolvePlaceholders(["$scroll.pageowner.fullName"], ctx, { getPageOwner });
    expect(res.values.get("$scroll.pageowner.fullName")).toBe("");
    expect(res.notes.some((n) => n.code === "owner-fetch-failed")).toBe(true);
  });

  it("renders empty + a warning when no owner fetcher is provided", async () => {
    const res = await resolvePlaceholders(["$scroll.pageowner.fullName"], ctx, {});
    expect(res.values.get("$scroll.pageowner.fullName")).toBe("");
    expect(res.notes.some((n) => n.code === "owner-unavailable")).toBe(true);
  });
});

describe("$scroll.pageproperty (G4)", () => {
  const detailsMacro = (rows: string, id?: string) =>
    `<ac:structured-macro ac:name="details">${
      id ? `<ac:parameter ac:name="id">${id}</ac:parameter>` : ""
    }<ac:rich-text-body><table><tbody>${rows}</tbody></table></ac:rich-text-body></ac:structured-macro>`;

  const withProps = (storage: string): ResolveContext => ({
    ...ctx,
    details: { ...details, storage },
  });

  const pageCtx = withProps(
    detailsMacro("<tr><th>Status</th><td>Approved</td></tr>", "specs") + "<p>body</p>"
  );

  it("resolves a key from the page's own macro with no round-trip at all", async () => {
    const getSpaceHomepageStorage = mock(async () => "");
    const res = await resolvePlaceholders(["$scroll.pageproperty.(Status)"], pageCtx, {
      getSpaceHomepageStorage,
    });
    expect(res.values.get("$scroll.pageproperty.(Status)")).toBe("Approved");
    // The page's storage is already in hand — the fallback form is what costs a fetch.
    expect(getSpaceHomepageStorage).not.toHaveBeenCalled();
  });

  it("scopes to a macro id when the 4-arg form names one", () => {
    const two =
      detailsMacro("<tr><th>Status</th><td>Approved</td></tr>", "specs") +
      detailsMacro("<tr><th>Status</th><td>Draft</td></tr>", "other");
    expect(
      resolveOne("$scroll.pageproperty.(Status,other,false,n/a)", withProps(two), {}, [])
    ).toBe("Draft");
  });

  it("falls back to the space homepage only when the argument asks for it", async () => {
    const homepage = detailsMacro("<tr><th>Imprint</th><td>Mayflower GmbH</td></tr>");
    const getSpaceHomepageStorage = mock(async () => homepage);

    const res = await resolvePlaceholders(["$scroll.pageproperty.(Imprint,true)"], pageCtx, {
      getSpaceHomepageStorage,
    });
    expect(getSpaceHomepageStorage).toHaveBeenCalledTimes(1);
    expect(getSpaceHomepageStorage).toHaveBeenCalledWith("ENG");
    expect(res.values.get("$scroll.pageproperty.(Imprint,true)")).toBe("Mayflower GmbH");
  });

  it("prefers the page's own value over the homepage's", async () => {
    const homepage = detailsMacro("<tr><th>Status</th><td>FROM HOMEPAGE</td></tr>");
    const res = await resolvePlaceholders(["$scroll.pageproperty.(Status,true)"], pageCtx, {
      getSpaceHomepageStorage: async () => homepage,
    });
    expect(res.values.get("$scroll.pageproperty.(Status,true)")).toBe("Approved");
  });

  it("renders the alternate text when the key is missing", () => {
    expect(
      resolveOne("$scroll.pageproperty.(Nope,specs,false,not set)", pageCtx, {}, [])
    ).toBe("not set");
  });

  it("renders empty + a note when the key is missing and no alternate text is given", () => {
    const notes: import("@atlcli/confluence").ExportNote[] = [];
    expect(resolveOne("$scroll.pageproperty.(Nope)", pageCtx, {}, notes)).toBe("");
    expect(notes.some((n) => n.code === "placeholder-empty")).toBe(true);
  });

  it("warns when the fallback is requested but no homepage fetcher exists", async () => {
    const res = await resolvePlaceholders(["$scroll.pageproperty.(Imprint,true)"], pageCtx, {});
    expect(res.values.get("$scroll.pageproperty.(Imprint,true)")).toBe("");
    expect(res.notes.some((n) => n.code === "homepage-unavailable")).toBe(true);
  });

  it("warns when the homepage fetch throws, and still exports", async () => {
    const res = await resolvePlaceholders(["$scroll.pageproperty.(Imprint,true)"], pageCtx, {
      getSpaceHomepageStorage: async () => {
        throw new Error("403");
      },
    });
    expect(res.values.get("$scroll.pageproperty.(Imprint,true)")).toBe("");
    expect(res.notes.some((n) => n.code === "homepage-fetch-failed")).toBe(true);
  });

  it("notes a pageproperty that names no key", () => {
    const notes: import("@atlcli/confluence").ExportNote[] = [];
    expect(resolveOne("$scroll.pageproperty.()", pageCtx, {}, notes)).toBe("");
    expect(notes.some((n) => n.code === "pageproperty-no-key")).toBe(true);
  });
});

describe(".name placeholders — DC username → display name on Cloud (G2)", () => {
  // `.name` is Scroll's Data Center USERNAME, not a person's name (`.fullName`
  // is). Cloud has no usernames at all, so the alternative to substituting is an
  // empty hole in a template that reads "Erstellt von: $scroll.creator.name".
  it("resolves creator/modifier .name to the display name", () => {
    expect(value("$scroll.creator.name")).toBe("Alice Author");
    expect(value("$scroll.modifier.name")).toBe("Mel Modifier");
  });

  it("resolves exporter.name from the fetched current user", () => {
    expect(value("$scroll.exporter.name")).toBe("Björn Schotte");
  });

  it("never substitutes silently — the report says what happened", () => {
    const notes: import("@atlcli/confluence").ExportNote[] = [];
    resolveOne("$scroll.creator.name", ctx, { space, currentUser, owner }, notes);
    const note = notes.find((n) => n.code === "placeholder-substituted");
    expect(note).toBeDefined();
    expect(note!.message).toContain("Data Center username");
    expect(note!.message).toContain("Alice Author");
  });

  it("stays empty (and silent) when the user is absent altogether", () => {
    const notes: import("@atlcli/confluence").ExportNote[] = [];
    const bare: ResolveContext = { ...ctx, details: { ...details, createdBy: undefined } };
    expect(resolveOne("$scroll.creator.name", bare, {}, notes)).toBe("");
    // No substitution happened, so nothing to report about one.
    expect(notes.some((n) => n.code === "placeholder-substituted")).toBe(false);
  });

  it("exporter.name still needs the user fetch, and only that", async () => {
    const getCurrentUser = mock(async () => currentUser);
    const getSpace = mock(async () => space);
    const res = await resolvePlaceholders(["$scroll.exporter.name"], ctx, {
      getCurrentUser,
      getSpace,
    });
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
    expect(getSpace).not.toHaveBeenCalled();
    expect(res.values.get("$scroll.exporter.name")).toBe("Björn Schotte");
  });
});

describe("$adhocState — dropped from the curated list, still blanked", () => {
  it("is unsupported (not never) and never leaks its literal", async () => {
    const res = await resolvePlaceholders(["$adhocState"], ctx, {});
    // Detection is deliberately kept: without it the raw token would survive
    // into the exported document.
    expect(res.values.get("$adhocState")).toBe("");
    expect(res.unsupportedNames).toContain("$adhocState");
  });
});

describe("resolvePlaceholders — pinning: never a literal", () => {
  it("maps unsupported and never placeholders to empty string + report entry", async () => {
    // $scroll.spacelogo is genuinely unsupported (needs the image module);
    // $scroll.pageowner.fullName is NOT used here — it became supported (G1).
    const res = await resolvePlaceholders(
      ["$scroll.spacelogo", "$adhocState", "$scroll.pageproperty.(status)"],
      ctx,
      {}
    );
    expect(res.values.get("$scroll.spacelogo")).toBe("");
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
