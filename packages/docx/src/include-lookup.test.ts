import { describe, expect, it } from "bun:test";
import { escapeCqlValue } from "@atlcli/confluence";
import type { ConfluencePageDetails } from "@atlcli/confluence";
import { buildGetIncludedPage, classifyIncludeError, type IncludeLookupIo } from "./include-lookup.js";

/** A real in-memory page store — no mocking, plain closures over fixture data. */
function makePage(id: string, title: string, spaceKey = "ENG"): ConfluencePageDetails {
  return { id, title, spaceKey, storage: `<p>${title} body</p>` };
}

function makeIo(
  pages: ConfluencePageDetails[],
  overrides: Partial<IncludeLookupIo> = {}
): IncludeLookupIo & { getPageCalls: string[]; searchCalls: string[] } {
  const getPageCalls: string[] = [];
  const searchCalls: string[] = [];
  return {
    getPageCalls,
    searchCalls,
    escapeCqlValue,
    defaultSpaceKey: "ENG",
    getPage: async (id) => {
      getPageCalls.push(id);
      const p = pages.find((x) => x.id === id);
      if (!p) throw new Error("Confluence API error (404): not found");
      return p;
    },
    searchPages: async (cql) => {
      searchCalls.push(cql);
      // Real matching: a page hits when its ESCAPED title clause is present in
      // the CQL (mirrors how the client would match the same literal server-side).
      return pages
        .filter((p) => cql.includes(`title = "${escapeCqlValue(p.title)}"`))
        .map((p) => ({ id: p.id }));
    },
    ...overrides,
  };
}

describe("buildGetIncludedPage — resolution paths", () => {
  it("resolves a pageId ref with one getPage and no search", async () => {
    const io = makeIo([makePage("500", "Imprint")]);
    const get = buildGetIncludedPage(io);
    const out = await get({ pageId: "500" });
    expect(out.kind).toBe("resolved");
    expect(io.searchCalls).toHaveLength(0);
    expect(io.getPageCalls).toEqual(["500"]);
  });

  it("resolves a title ref via CQL, filling the default space and escaping the value", async () => {
    const io = makeIo([makePage("501", 'Legal "Notice"')]);
    const get = buildGetIncludedPage(io);
    const out = await get({ title: 'Legal "Notice"' });
    expect(out.kind).toBe("resolved");
    // Default space filled + both literals escaped through escapeCqlValue.
    expect(io.searchCalls[0]).toBe('type = page and space = "ENG" and title = "Legal \\"Notice\\""');
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

  it("classifies a thrown 429 from search as rate-limited", async () => {
    const io = makeIo([], {
      searchPages: async () => {
        throw new Error("Rate limited by Confluence API after 3 retries");
      },
    });
    const out = await buildGetIncludedPage(io)({ title: "X" });
    expect(out.kind).toBe("rate-limited");
  });
});
