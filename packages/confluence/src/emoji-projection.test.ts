import { describe, expect, it } from "bun:test";
import {
  CONFLUENCE_LEGACY_EMOJI_ALIASES,
  CONFLUENCE_LEGACY_EMOJI_PROJECTIONS,
  isColonEmojiShortName,
  normalizeEmojiShortName,
  projectTypedEmoji,
} from "./emoji-projection.js";

describe("legacy Confluence emoji catalog", () => {
  it("contains the exact 22 canonical names and 26 aliases", () => {
    expect(Object.keys(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS)).toEqual([
      "smile", "sad", "cheeky", "laugh", "wink",
      "thumbs-up", "thumbs-down",
      "tick", "cross",
      "warning", "information", "question",
      "light-on", "light-off",
      "yellow-star", "red-star", "green-star", "blue-star",
      "heart", "broken-heart",
      "plus", "minus",
    ]);
    expect(Object.keys(CONFLUENCE_LEGACY_EMOJI_ALIASES)).toHaveLength(26);
  });

  it("keeps every projection non-empty and semantically distinguishable", () => {
    const projections = Object.values(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS);
    expect(projections.every((entry) => entry.text.length > 0)).toBe(true);
    expect(new Set(projections.map((entry) => entry.text)).size).toBe(projections.length);
    expect(new Set([
      projections.find((entry) => entry.canonicalName === "yellow-star")!.text,
      projections.find((entry) => entry.canonicalName === "red-star")!.text,
      projections.find((entry) => entry.canonicalName === "green-star")!.text,
      projections.find((entry) => entry.canonicalName === "blue-star")!.text,
    ]).size).toBe(4);
  });

  it("is immutable at both catalog levels", () => {
    expect(Object.isFrozen(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS)).toBe(true);
    expect(Object.isFrozen(CONFLUENCE_LEGACY_EMOJI_ALIASES)).toBe(true);
    expect(
      Object.values(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS).every(Object.isFrozen)
    ).toBe(true);
  });

  it("maps every alias to one existing canonical entry", () => {
    for (const [alias, canonicalName] of Object.entries(CONFLUENCE_LEGACY_EMOJI_ALIASES)) {
      expect(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS[canonicalName]).toBeDefined();
      expect(normalizeEmojiShortName(alias)).toBe(canonicalName);
      expect(normalizeEmojiShortName(`:${alias}:`)).toBe(canonicalName);
    }
  });
});

describe("normalizeEmojiShortName", () => {
  it("matches canonical names and aliases case-insensitively", () => {
    expect(normalizeEmojiShortName("WARNING")).toBe("warning");
    expect(normalizeEmojiShortName(":WaRnInG:")).toBe("warning");
    expect(normalizeEmojiShortName(":THUMBSUP:")).toBe("thumbs-up");
  });

  it("strips exactly one colon pair and never trims", () => {
    expect(normalizeEmojiShortName("::warning::")).toBeUndefined();
    expect(normalizeEmojiShortName(" :warning:")).toBeUndefined();
    expect(normalizeEmojiShortName(":warning: ")).toBeUndefined();
    expect(normalizeEmojiShortName(":not-known:")).toBeUndefined();
  });
});

describe("projectTypedEmoji", () => {
  it("preserves usable source Unicode byte-for-byte", () => {
    for (const text of ["⚠️", "👍🏽", "👩‍💻", "🇩🇪"]) {
      expect(projectTypedEmoji({ shortName: ":warning:", sourceText: text })).toEqual({
        kind: "source-text",
        text,
      });
    }
  });

  it("uses the authoritative short name for missing, empty, or colon source text", () => {
    const warning = CONFLUENCE_LEGACY_EMOJI_PROJECTIONS.warning;
    expect(projectTypedEmoji({ shortName: ":warning:" })).toEqual({
      kind: "known",
      text: warning.text,
      projection: warning,
    });
    expect(projectTypedEmoji({ shortName: ":warning:", sourceText: "" })).toEqual({
      kind: "known",
      text: warning.text,
      projection: warning,
    });
    expect(projectTypedEmoji({ shortName: ":warning:", sourceText: ":smile:" })).toEqual({
      kind: "known",
      text: warning.text,
      projection: warning,
    });
  });

  it("normalizes aliases only inside typed metadata", () => {
    expect(projectTypedEmoji({ shortName: ":+1:" })).toEqual({
      kind: "known",
      text: CONFLUENCE_LEGACY_EMOJI_PROJECTIONS["thumbs-up"].text,
      projection: CONFLUENCE_LEGACY_EMOJI_PROJECTIONS["thumbs-up"],
    });
  });

  it("preserves an unknown or site-custom short name exactly", () => {
    expect(projectTypedEmoji({ shortName: ":party-parrot:", sourceText: ":fallback:" })).toEqual({
      kind: "unresolved",
      text: ":party-parrot:",
    });
  });

  it("recognizes only non-whitespace colon tokens", () => {
    expect(isColonEmojiShortName(":warning:")).toBe(true);
    expect(isColonEmojiShortName(":not known:")).toBe(false);
    expect(isColonEmojiShortName("warning")).toBe(false);
  });
});
