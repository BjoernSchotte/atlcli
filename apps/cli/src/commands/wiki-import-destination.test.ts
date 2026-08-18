import { describe, expect, it } from "bun:test";
import type { ConfluenceClient } from "@atlcli/confluence";
import { preflightImportTitles, TitlePreflightConflictError } from "./wiki-import-destination.js";

function client(existing: readonly string[]): ConfluenceClient {
  const normalized = new Set(existing.map((title) => title.normalize("NFC").toLocaleLowerCase("en-US")));
  return {
    async findPagesByTitle(title: string): Promise<Array<{ id: string }>> {
      return normalized.has(title.normalize("NFC").toLocaleLowerCase("en-US")) ? [{ id: "existing" }] : [];
    },
  } as unknown as ConfluenceClient;
}

describe("import destination title preflight", () => {
  it("fails before mutation for remote and within-plan title conflicts", async () => {
    const candidates = [
      { id: "root", title: "Guide" },
      { id: "child-a", title: "Chapter" },
      { id: "child-b", title: "Chapter" },
    ];
    try {
      await preflightImportTitles(client(["Guide"]), "DOCSY", candidates, "fail");
      throw new Error("expected a title conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(TitlePreflightConflictError);
      expect((error as TitlePreflightConflictError).conflicts).toEqual(["Guide", "Chapter"]);
    }
  });

  it("derives deterministic free titles without colliding with planned names", async () => {
    const renames = await preflightImportTitles(client(["Guide", "Guide (2)"]), "DOCSY", [
      { id: "root", title: "Guide" },
      { id: "reserved", title: "Guide (3)" },
      { id: "duplicate", title: "Guide" },
    ], "rename");
    expect(Object.fromEntries(renames)).toEqual({ root: "Guide (4)", duplicate: "Guide (5)" });
  });
});
