import { describe, expect, test } from "bun:test";
import {
  ActionPaletteContextError,
  bindingsEqualV1,
  deriveActionPaletteContextV1,
  type ActionPaletteSenderV1,
} from "../utils/action-palette/context.js";

const sender: ActionPaletteSenderV1 = {
  tabId: 17,
  documentId: "document-A",
  frameId: 0,
  origin: "https://example.atlassian.net",
  url: "https://example.atlassian.net/wiki/spaces/DOC/pages/123/Title",
};

function derive(url: string, overrides: Partial<ActionPaletteSenderV1> = {}) {
  return deriveActionPaletteContextV1({
    sender: { ...sender, ...overrides },
    tab: { id: 17, url },
    locale: "de-DE",
    capabilities: ["atlcli.capability.surface.sidebar", "atlcli.capability.surface.sidebar"],
  });
}

describe("authoritative action palette context", () => {
  test("projects a Confluence page from the re-read tab", () => {
    const result = derive("https://example.atlassian.net/wiki/spaces/DOC/pages/123/Title");
    expect(result.context).toEqual({
      siteOrigin: "https://example.atlassian.net",
      product: "confluence",
      entity: {
        kind: "atlcli.entity.confluence-page",
        id: "123",
        key: "DOC",
        url: "https://example.atlassian.net/wiki/spaces/DOC/pages/123/Title",
      },
      locale: "de-DE",
      capabilities: ["atlcli.capability.surface.sidebar"],
    });
    expect(result.binding.documentId).toBe("document-A");
    expect(Object.isFrozen(result.context)).toBe(true);
  });

  test("projects Jira entities and a generic Atlassian surface", () => {
    expect(derive("https://example.atlassian.net/browse/ATLCLI-42").context).toMatchObject({
      product: "jira",
      entity: { kind: "atlcli.entity.jira-issue", id: "ATLCLI-42", key: "ATLCLI-42" },
    });
    expect(derive("https://example.atlassian.net/jira/software/c/projects/ATLCLI/boards/7").context).toMatchObject({
      product: "jira",
      entity: { kind: "atlcli.entity.jira-board", id: "7", key: "ATLCLI" },
    });
    expect(derive("https://example.atlassian.net/home").context).toEqual({
      siteOrigin: "https://example.atlassian.net",
      product: "atlassian",
      locale: "de-DE",
      capabilities: ["atlcli.capability.surface.sidebar"],
    });
  });

  test("rejects non-top frames, missing documents, tab substitution, and unsupported sites", () => {
    const cases = [
      () => derive("https://example.atlassian.net/home", { frameId: 2 }),
      () => derive("https://example.atlassian.net/home", { documentId: "" }),
      () => deriveActionPaletteContextV1({ sender, tab: { id: 99, url: sender.url }, locale: "en-US", capabilities: [] }),
      () => derive("https://example.com/wiki/spaces/DOC/pages/123"),
    ];
    for (const run of cases) expect(run).toThrow(ActionPaletteContextError);
  });

  test("rejects a stale origin and binds navigation/document replacement exactly", () => {
    expect(() => derive("https://other.atlassian.net/wiki/spaces/DOC/pages/123")).toThrow("stale-context");
    const original = derive("https://example.atlassian.net/wiki/spaces/DOC/pages/123").binding;
    const navigated = derive("https://example.atlassian.net/wiki/spaces/DOC/pages/456").binding;
    const replaced = derive("https://example.atlassian.net/wiki/spaces/DOC/pages/123", { documentId: "document-B" }).binding;
    expect(bindingsEqualV1(original, navigated)).toBe(false);
    expect(bindingsEqualV1(original, replaced)).toBe(false);
    expect(bindingsEqualV1(original, { ...original })).toBe(true);
  });
});
