import { describe, expect, it } from "bun:test";
import type { ConfluencePageDetails } from "@atlcli/confluence";
import { buildGetIncludedPage, classifyIncludeError, type IncludeLookupIo } from "./include-lookup.js";

/** A real in-memory page store — no mocking, plain closures over fixture data. */
function makePage(id: string, title: string, spaceKey = "ENG"): ConfluencePageDetails {
  return { id, title, spaceKey, storage: `<p>${title} body</p>` };
}

function makeIo(
  pages: ConfluencePageDetails[],
  overrides: Partial<IncludeLookupIo> = {}
): IncludeLookupIo & { getPageCalls: string[]; titleCalls: Array<{ title: string; spaceKey?: string }> } {
  const getPageCalls: string[] = [];
  const titleCalls: Array<{ title: string; spaceKey?: string }> = [];
  return {
    getPageCalls,
    titleCalls,
    defaultSpaceKey: "ENG",
    getPage: async (id) => {
      getPageCalls.push(id);
      const p = pages.find((x) => x.id === id);
      if (!p) throw new Error("Confluence API error (404): not found");
      return p;
    },
    // Direct content-endpoint lookup (NOT CQL): exact title match, optionally
    // scoped to a space — mirrors ConfluenceClient.findPagesByTitle.
    findPagesByTitle: async (title, spaceKey) => {
      titleCalls.push({ title, ...(spaceKey ? { spaceKey } : {}) });
      return pages
        .filter((p) => p.title === title && (spaceKey === undefined || p.spaceKey === spaceKey))
        .map((p) => ({ id: p.id }));
    },
    ...overrides,
  };
}

describe("buildGetIncludedPage — resolution paths", () => {
  it("resolves a pageId ref with one getPage and no title lookup", async () => {
    const io = makeIo([makePage("500", "Imprint")]);
    const get = buildGetIncludedPage(io);
    const out = await get({ pageId: "500" });
    expect(out.kind).toBe("resolved");
    expect(io.titleCalls).toHaveLength(0);
    expect(io.getPageCalls).toEqual(["500"]);
  });

  it("resolves a title ref through the DIRECT endpoint (not CQL), filling the default space", async () => {
    const io = makeIo([makePage("501", 'Legal "Notice"')]);
    const get = buildGetIncludedPage(io);
    const out = await get({ title: 'Legal "Notice"' });
    expect(out.kind).toBe("resolved");
    // The raw title + default space are passed straight through — no CQL clause,
    // no escaping (the client URL-encodes the query param). This is the
    // regression pin: title resolution must NOT build a CQL string.
    expect(io.titleCalls).toEqual([{ title: 'Legal "Notice"', spaceKey: "ENG" }]);
  });

  it("passes an explicit space through and honors it in the match", async () => {
    const io = makeIo([makePage("601", "Imprint", "ENG"), makePage("602", "Imprint", "DOCSY")]);
    const out = await buildGetIncludedPage(io)({ spaceKey: "DOCSY", title: "Imprint" });
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.page.id).toBe("602");
    expect(io.titleCalls).toEqual([{ title: "Imprint", spaceKey: "DOCSY" }]);
  });

  it("reports ambiguous but still resolves the id-sorted first hit", async () => {
    const io = makeIo([makePage("30", "Dup"), makePage("10", "Dup"), makePage("20", "Dup")]);
    const get = buildGetIncludedPage(io);
    const out = await get({ title: "Dup" });
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.count).toBe(3);
      expect(out.page.id).toBe("10"); // lexicographic id sort → deterministic
    }
  });

  it("returns not-found-or-forbidden on zero title hits", async () => {
    const io = makeIo([makePage("1", "Other")]);
    const out = await buildGetIncludedPage(io)({ title: "Missing" });
    expect(out.kind).toBe("not-found-or-forbidden");
  });
});

describe("classifyIncludeError — every distinct failure class", () => {
  it("maps client error messages to the right outcome kind", () => {
    expect(classifyIncludeError(new Error("Confluence API error (401): bad token")).kind).toBe("auth-failed");
    expect(classifyIncludeError(new Error("Confluence API error (403): forbidden")).kind).toBe("not-found-or-forbidden");
    expect(classifyIncludeError(new Error("Confluence API error (404): missing")).kind).toBe("not-found-or-forbidden");
    expect(classifyIncludeError(new Error("Rate limited by Confluence API after 3 retries")).kind).toBe("rate-limited");
    const transient = classifyIncludeError(new Error("Confluence API error (503): upstream down"));
    expect(transient.kind).toBe("transient-error");
    if (transient.kind === "transient-error") expect(transient.message).toContain("503");
  });

  it("classifies a raw network failure as transient", () => {
    const out = classifyIncludeError(new TypeError("fetch failed"));
    expect(out.kind).toBe("transient-error");
  });
});

describe("buildGetIncludedPage — error handling", () => {
  it("rethrows an AbortError instead of swallowing it", async () => {
    const io = makeIo([], {
      getPage: async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    await expect(buildGetIncludedPage(io)({ pageId: "1" })).rejects.toThrow("aborted");
  });

  it("classifies a thrown 429 from the title lookup as rate-limited", async () => {
    const io = makeIo([], {
      findPagesByTitle: async () => {
        throw new Error("Rate limited by Confluence API after 3 retries");
      },
    });
    const out = await buildGetIncludedPage(io)({ title: "X" });
    expect(out.kind).toBe("rate-limited");
  });
});
