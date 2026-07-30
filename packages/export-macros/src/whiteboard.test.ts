import { describe, expect, it } from "bun:test";
import { adfToBlocks, type ExportBlock } from "@atlcli/confluence";
import { defaultRegistry } from "./registry.js";
import { resolveMacroBlocks } from "./resolve.js";
import {
  whiteboardRenderer,
  whiteboardTargetVerdict,
  type WhiteboardTargetFailure,
} from "./whiteboard.js";
import type { MacroExportContext, MacroInstance } from "./types.js";

const SITE = "https://tenant.invalid";
const EXTENSION = {
  extensionType: "com.atlassian.confluence.macro.core",
  extensionKey: "native-embed:whiteboard",
} as const;

function context(
  overrides: Partial<MacroExportContext> = {},
): MacroExportContext {
  return {
    page: { id: "100", spaceKey: "SYNTHETIC" },
    depth: 0,
    visited: new Set(),
    siteId: SITE,
    siteOrigin: SITE,
    ...overrides,
  };
}

function macro(url?: string): MacroInstance {
  return {
    name: EXTENSION.extensionKey,
    adfExtension: EXTENSION,
    ...(url ? { params: [{ name: "url", text: url }] } : { params: [] }),
  };
}

describe("whiteboardTargetVerdict", () => {
  it("canonicalizes same-site absolute and origin-relative routes", () => {
    expect(whiteboardTargetVerdict(
      `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/41?source=embed`,
      `${SITE}/wiki`,
    )).toEqual({
      safe: true,
      url: `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/41`,
    });
    expect(whiteboardTargetVerdict(
      "/wiki/spaces/~SYNTHETIC/whiteboard/42",
      SITE,
    )).toEqual({
      safe: true,
      url: `${SITE}/wiki/spaces/~SYNTHETIC/whiteboard/42`,
    });
  });

  const unsafe: Array<{
    name: string;
    url?: string;
    siteOrigin?: string;
    reason: WhiteboardTargetFailure;
  }> = [
    { name: "missing URL", siteOrigin: SITE, reason: "missing-url" },
    {
      name: "missing trusted site",
      url: "/wiki/spaces/SYNTHETIC/whiteboard/41",
      reason: "trusted-site-unavailable",
    },
    {
      name: "malformed trusted site",
      url: "/wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: "not a URL",
      reason: "trusted-site-unavailable",
    },
    {
      name: "external host",
      url: "https://external.invalid/wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: SITE,
      reason: "cross-site",
    },
    {
      name: "cross-tenant host",
      url: "https://other-tenant.invalid/wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: SITE,
      reason: "cross-site",
    },
    {
      name: "unsupported scheme",
      url: "javascript:alert(1)",
      siteOrigin: SITE,
      reason: "unsupported-scheme",
    },
    {
      name: "downgraded HTTP scheme",
      url: "http://tenant.invalid/wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: SITE,
      reason: "unsupported-scheme",
    },
    {
      name: "credentials",
      url: "https://user:secret@tenant.invalid/wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: SITE,
      reason: "credentials",
    },
    {
      name: "fragment",
      url: `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/41#canvas`,
      siteOrigin: SITE,
      reason: "fragment",
    },
    {
      name: "protocol-relative URL",
      url: "//tenant.invalid/wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: SITE,
      reason: "protocol-relative",
    },
    {
      name: "path-relative URL",
      url: "wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: SITE,
      reason: "unsafe-relative",
    },
    {
      name: "parent-relative URL",
      url: "../wiki/spaces/SYNTHETIC/whiteboard/41",
      siteOrigin: SITE,
      reason: "malformed-url",
    },
    {
      name: "wrong route",
      url: "/wiki/spaces/SYNTHETIC/pages/41",
      siteOrigin: SITE,
      reason: "malformed-route",
    },
    {
      name: "invalid space key",
      url: "/wiki/spaces/SYNTHETIC-SPACE/whiteboard/41",
      siteOrigin: SITE,
      reason: "invalid-space-key",
    },
    {
      name: "invalid Whiteboard id",
      url: "/wiki/spaces/SYNTHETIC/whiteboard/board-41",
      siteOrigin: SITE,
      reason: "invalid-whiteboard-id",
    },
    {
      name: "encoded slash",
      url: "/wiki/spaces/SYNTHETIC/whiteboard/41%2F42",
      siteOrigin: SITE,
      reason: "malformed-route",
    },
  ];

  for (const fixture of unsafe) {
    it(`rejects ${fixture.name}`, () => {
      expect(
        whiteboardTargetVerdict(fixture.url, fixture.siteOrigin),
      ).toEqual({ safe: false, reason: fixture.reason });
    });
  }
});

describe("whiteboardRenderer", () => {
  it("emits one deterministic linked Smart Card without a live port", async () => {
    const renderer = whiteboardRenderer();
    expect(renderer.macros).toEqual(["native-embed:whiteboard"]);
    expect(renderer.requiresLivePort).toBe(false);

    const result = await renderer.render(
      macro(`${SITE}/wiki/spaces/SYNTHETIC/whiteboard/41?ignored=true`),
      context(),
    );

    expect(result).toEqual({
      kind: "blocks",
      blocks: [{
        type: "smartCard",
        card: {
          appearance: "block",
          source: "url",
          url: `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/41`,
          target: {
            kind: "external",
            href: `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/41`,
          },
          title: "Atlassian Whiteboard",
        },
      }],
      notes: [{
        level: "info",
        code: "macro-rendered-via",
        message:
          "The embedded Atlassian Whiteboard was represented as a linked card; " +
          "Whiteboard pixels and editable content were not exported.",
        macroName: "native-embed:whiteboard",
      }],
    });
  });

  it("emits a visible degraded fallback without echoing an unsafe target", async () => {
    const unsafe = "https://external.invalid/wiki/spaces/PRIVATE/whiteboard/999";
    const result = await whiteboardRenderer().render(macro(unsafe), context());

    expect(result.kind).toBe("blocks");
    if (result.kind !== "blocks") throw new Error("Expected blocks");
    expect(result.blocks).toEqual([{
      type: "paragraph",
      content: [{ type: "text", text: "Atlassian Whiteboard (link unavailable)" }],
    }]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes?.[0]).toMatchObject({
      level: "warning",
      code: "macro-degraded",
      macroName: "native-embed:whiteboard",
    });
    expect(JSON.stringify(result.notes)).not.toContain(unsafe);
    expect(JSON.stringify(result.notes)).not.toContain("PRIVATE");
    expect(JSON.stringify(result.notes)).not.toContain("999");
  });

  it("does not claim a Storage macro or another ADF extension type", async () => {
    const renderer = whiteboardRenderer();
    expect(await renderer.render({
      name: EXTENSION.extensionKey,
      params: [{ name: "url", text: "/wiki/spaces/SYNTHETIC/whiteboard/41" }],
    }, context())).toEqual({ kind: "skip" });
    expect(await renderer.render({
      ...macro("/wiki/spaces/SYNTHETIC/whiteboard/41"),
      adfExtension: { ...EXTENSION, extensionType: "com.example.app" },
    }, context())).toEqual({ kind: "skip" });
  });
});

describe("Whiteboard ADF resolution", () => {
  const deps = {
    storageToBlocks: () => ({ blocks: [], notes: [] }),
    htmlToExportBlocks: () => ({ blocks: [], notes: [] }),
    parsePageProperties: () => [],
    extractMacroBody: () => undefined,
  } as unknown as Parameters<typeof defaultRegistry>[0];

  function extension(id: number): Record<string, unknown> {
    return {
      type: "extension",
      attrs: {
        ...EXTENSION,
        parameters: {
          macroParams: {
            _parentId: { value: "100" },
            url: {
              value: `/wiki/spaces/SYNTHETIC/whiteboard/${id}`,
            },
          },
        },
      },
    };
  }

  it("preserves nested source order, one card and one terminal outcome per instance", async () => {
    const decoded = adfToBlocks({
      version: 1,
      type: "doc",
      content: [
        extension(41),
        { type: "blockquote", content: [extension(42)] },
        extension(43),
      ],
    } as Parameters<typeof adfToBlocks>[0], {
      pageContext: { id: "100", spaceKey: "SYNTHETIC" },
    });
    let exportViewCalls = 0;

    const result = await resolveMacroBlocks(
      decoded,
      defaultRegistry(deps),
      context({
        exportView: {
          async renderMacroHtml() {
            exportViewCalls += 1;
            return "<p>unexpected</p>";
          },
        },
      }),
      { live: false },
    );

    expect(exportViewCalls).toBe(0);
    expect(result.blocks.map((block) => block.type)).toEqual([
      "smartCard",
      "blockquote",
      "smartCard",
    ]);
    const nested = result.blocks[1] as Extract<ExportBlock, { type: "blockquote" }>;
    expect(nested.content.map((block) => block.type)).toEqual(["smartCard"]);
    const cards: ExportBlock[] = [
      result.blocks[0]!,
      nested.content[0]!,
      result.blocks[2]!,
    ];
    expect(cards.map((block) =>
      block.type === "smartCard" ? block.card.url : undefined
    )).toEqual([
      `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/41`,
      `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/42`,
      `${SITE}/wiki/spaces/SYNTHETIC/whiteboard/43`,
    ]);
    expect(result.notes).toHaveLength(3);
    expect(result.notes.map((note) => note.code)).toEqual([
      "macro-rendered-via",
      "macro-rendered-via",
      "macro-rendered-via",
    ]);
  });
});
