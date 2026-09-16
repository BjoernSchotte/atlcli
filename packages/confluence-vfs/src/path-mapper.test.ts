import { describe, expect, it } from "bun:test";
import {
  formatDirName,
  formatName,
  isSpaceKey,
  joinPath,
  normalizePath,
  parseName,
  resolveNameToId,
  splitParent,
  splitPath,
  titleFromName,
  vfsSlug,
} from "./path-mapper.js";

describe("formatName", () => {
  it("makes a leaf a markdown file and a parent a directory", () => {
    expect(formatName("Architecture", "623869955", false)).toBe("architecture-623869955.md");
    expect(formatName("Architecture", "623869955", true)).toBe("architecture-623869955");
    expect(formatDirName("Architecture", "623869955")).toBe("architecture-623869955");
  });

  it("never produces a name starting with a dash, however unsluggable the title", () => {
    // "日本語" slugifies to the empty string; "-623869955.md" would look like a
    // flag to every shell that globs it.
    expect(formatName("日本語", "623869955", false)).toBe("page-623869955.md");
    expect(vfsSlug("***")).toBe("page");
    expect(vfsSlug("")).toBe("page");
  });
});

describe("parseName", () => {
  it("splits the trailing id off a normal name", () => {
    const parsed = parseName("architecture-623869955.md");
    expect(parsed).toMatchObject({
      slugCandidate: "architecture",
      idCandidate: "623869955",
      isMarkdown: true,
    });
  });

  it("splits directories too", () => {
    expect(parseName("architecture-623869955")).toMatchObject({
      idCandidate: "623869955",
      isMarkdown: false,
    });
  });

  it("takes the LAST digit run when the title itself ends in digits", () => {
    const parsed = parseName("release-2026-623869955.md");
    expect(parsed.slugCandidate).toBe("release-2026");
    expect(parsed.idCandidate).toBe("623869955");
  });

  it("reports no candidate when there is no trailing digit run", () => {
    expect(parseName("new-page.md").idCandidate).toBeUndefined();
    expect(parseName("_index.md").idCandidate).toBeUndefined();
  });

  it("does report a candidate for a name that is only digits after a dash", () => {
    // This is exactly the ambiguous case resolveNameToId exists to settle.
    expect(parseName("release-2026.md").idCandidate).toBe("2026");
  });
});

describe("resolveNameToId", () => {
  const known = new Set(["623869955", "100"]);
  const knows = (id: string): boolean => known.has(id);

  it("confirms a real id", () => {
    expect(resolveNameToId("architecture-623869955.md", knows)).toBe("623869955");
  });

  it("ignores the slug entirely, so a stale name still resolves after a rename", () => {
    expect(resolveNameToId("old-title-623869955.md", knows)).toBe("623869955");
    expect(resolveNameToId("-623869955.md", knows)).toBe("623869955");
  });

  it("refuses a digit run the index does not know, so a new file stays new", () => {
    // The regression this pins: `echo > release-2026.md` must create a page,
    // not silently overwrite page 2026.
    expect(resolveNameToId("release-2026.md", knows)).toBeUndefined();
  });

  it("returns undefined when there is no candidate at all", () => {
    expect(resolveNameToId("new-page.md", knows)).toBeUndefined();
  });
});

describe("titleFromName", () => {
  it("turns a slug into a title", () => {
    expect(titleFromName("new-page.md")).toBe("New Page");
    expect(titleFromName("release_notes-2026.md")).toBe("Release Notes 2026");
  });

  it("falls back for an empty stem", () => {
    expect(titleFromName(".md")).toBe("Untitled");
  });
});

describe("normalizePath", () => {
  it("normalises separators, dots and trailing slashes", () => {
    expect(normalizePath("/DOCSY//a-1/./")).toBe("/DOCSY/a-1");
    expect(normalizePath("DOCSY/a-1")).toBe("/DOCSY/a-1");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });

  it("resolves .. inside the tree", () => {
    expect(normalizePath("/DOCSY/a-1/../b-2.md")).toBe("/DOCSY/b-2.md");
  });

  it("refuses to escape the root", () => {
    expect(() => normalizePath("/../etc/passwd")).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => normalizePath("/DOCSY/../../etc")).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });
});

describe("splitPath and splitParent", () => {
  it("splits into segments", () => {
    expect(splitPath("/DOCSY/a-1/b-2.md")).toEqual(["DOCSY", "a-1", "b-2.md"]);
    expect(splitPath("/")).toEqual([]);
  });

  it("splits off the parent", () => {
    expect(splitParent("/DOCSY/a-1/b-2.md")).toEqual({ parent: "/DOCSY/a-1", name: "b-2.md" });
    expect(splitParent("/DOCSY")).toEqual({ parent: "/", name: "DOCSY" });
  });

  it("refuses to take the parent of the root", () => {
    expect(() => splitParent("/")).toThrow(expect.objectContaining({ code: "EINVAL" }));
  });

  it("joins", () => {
    expect(joinPath("/DOCSY", "a-1", "b-2.md")).toBe("/DOCSY/a-1/b-2.md");
  });
});

describe("isSpaceKey", () => {
  it("accepts keys and rejects reserved names", () => {
    expect(isSpaceKey("DOCSY")).toBe(true);
    expect(isSpaceKey("TEAM_1")).toBe(true);
    expect(isSpaceKey(".me.json")).toBe(false);
    expect(isSpaceKey("has space")).toBe(false);
  });
});
