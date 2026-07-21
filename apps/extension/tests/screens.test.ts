/**
 * Screen registry (spec 010 Phase 0 — the actual deliverable).
 *
 * The rules pinned here are what make "adding a screen is a registry entry,
 * never an edit to the shell" true rather than aspirational:
 *  - unmet requirements never produce a silently broken screen — the result
 *    always carries a reason key the shell can translate;
 *  - `"disable"` (the default) keeps the entry visible, because a nav item that
 *    vanishes reads as a bug;
 *  - the active-screen choice never redirects away from something the user
 *    explicitly asked for.
 */
import { describe, expect, it } from "bun:test";
import type React from "react";
import {
  pickActiveScreen,
  requirementReasonKey,
  resolveScreens,
  type ScreenDefinition,
  type ScreenEnvironment,
} from "../utils/screens/registry.js";
import { defaultScreens, SCREEN_IDS } from "../components/screens/index.js";

const Icon = (() => null) as unknown as ScreenDefinition["icon"];
const Component = (() => null) as unknown as React.ComponentType<never>;

function screen(overrides: Partial<ScreenDefinition> & { id: string }): ScreenDefinition {
  return {
    labelKey: "screen.export.label",
    icon: Icon,
    component: Component as ScreenDefinition["component"],
    ...overrides,
  };
}

const ALL: ScreenEnvironment = {
  hasLoadedPage: true,
  capabilities: ["pdf-export", "docx-export", "durable-jobs"],
};
const NOTHING: ScreenEnvironment = { hasLoadedPage: false, capabilities: [] };

describe("resolveScreens", () => {
  it("returns one entry per definition, in `order` then registration order", () => {
    const resolved = resolveScreens(
      [
        screen({ id: "c", order: 30 }),
        screen({ id: "a", order: 10 }),
        screen({ id: "b", order: 10 }),
      ],
      ALL
    );
    expect(resolved.map((r) => r.definition.id)).toEqual(["a", "b", "c"]);
  });

  it("marks a screen with no requirements available and visible", () => {
    const [only] = resolveScreens([screen({ id: "x" })], NOTHING);
    expect(only!.available).toBe(true);
    expect(only!.visible).toBe(true);
    expect(only!.reasonKey).toBeNull();
    expect(only!.unmet).toEqual([]);
  });

  it("disables — but keeps visible — a screen whose capability is missing", () => {
    const [only] = resolveScreens(
      [screen({ id: "jobs", requirements: [{ kind: "capability", capability: "durable-jobs" }] })],
      NOTHING
    );
    expect(only!.available).toBe(false);
    expect(only!.visible).toBe(true);
    expect(only!.reasonKey).toBe("screen.unmet.capability.durableJobs");
  });

  it("hides a screen that asked to be hidden when unmet", () => {
    const [only] = resolveScreens(
      [
        screen({
          id: "jobs",
          whenUnmet: "hide",
          requirements: [{ kind: "capability", capability: "durable-jobs" }],
        }),
      ],
      NOTHING
    );
    expect(only!.available).toBe(false);
    expect(only!.visible).toBe(false);
  });

  it("reports a missing page with its own reason, not a generic one", () => {
    const [only] = resolveScreens(
      [screen({ id: "preview", requirements: [{ kind: "loaded-page" }] })],
      NOTHING
    );
    expect(only!.reasonKey).toBe("screen.unmet.page");
  });

  it("collects every unmet requirement but reports the first as the reason", () => {
    const [only] = resolveScreens(
      [
        screen({
          id: "preview",
          requirements: [
            { kind: "loaded-page" },
            { kind: "capability", capability: "pdf-preview" },
          ],
        }),
      ],
      NOTHING
    );
    expect(only!.unmet).toHaveLength(2);
    expect(only!.reasonKey).toBe("screen.unmet.page");
  });

  it("becomes available the moment the environment satisfies it — no other change", () => {
    const definitions = [
      screen({ id: "jobs", requirements: [{ kind: "capability", capability: "durable-jobs" }] }),
    ];
    expect(resolveScreens(definitions, NOTHING)[0]!.available).toBe(false);
    expect(resolveScreens(definitions, ALL)[0]!.available).toBe(true);
  });

  it("gives every capability a distinct explanation", () => {
    const capabilities = [
      "pdf-export",
      "docx-export",
      "docx-template-store",
      "template-library",
      "durable-jobs",
      "pdf-preview",
      "settings-persistence",
    ] as const;
    const keys = capabilities.map((capability) =>
      requirementReasonKey({ kind: "capability", capability })
    );
    expect(new Set(keys).size).toBe(capabilities.length);
  });
});

describe("pickActiveScreen", () => {
  const definitions = [
    screen({ id: "export", order: 10 }),
    screen({
      id: "jobs",
      order: 20,
      requirements: [{ kind: "capability", capability: "durable-jobs" }],
    }),
    screen({
      id: "secret",
      order: 30,
      whenUnmet: "hide",
      requirements: [{ kind: "capability", capability: "pdf-preview" }],
    }),
  ];

  it("honours an explicit request", () => {
    const resolved = resolveScreens(definitions, ALL);
    expect(pickActiveScreen(resolved, "jobs")?.definition.id).toBe("jobs");
  });

  it("keeps a requested-but-unavailable screen so the reason can be shown", () => {
    const resolved = resolveScreens(definitions, NOTHING);
    const active = pickActiveScreen(resolved, "jobs");
    expect(active?.definition.id).toBe("jobs");
    expect(active?.available).toBe(false);
  });

  it("falls back to the first available screen for an unknown or hidden request", () => {
    const resolved = resolveScreens(definitions, NOTHING);
    expect(pickActiveScreen(resolved, "nope")?.definition.id).toBe("export");
    expect(pickActiveScreen(resolved, "secret")?.definition.id).toBe("export");
  });

  it("returns null when nothing is visible", () => {
    expect(pickActiveScreen([], "export")).toBeNull();
  });
});

describe("the shipped registry", () => {
  it("registers Export, Preview, Templates, Activity, Settings and About", () => {
    expect(defaultScreens.map((s) => s.id)).toEqual([
      SCREEN_IDS.export,
      SCREEN_IDS.preview,
      SCREEN_IDS.templates,
      SCREEN_IDS.activity,
      SCREEN_IDS.settings,
      SCREEN_IDS.about,
    ]);
  });

  // Both wave-2/3 screens land the same way: registered, and gated on a
  // capability no host advertises yet. That is the registry behaving correctly
  // — a nav entry the user can see and a sentence saying why it is off — and
  // it is what makes "add the capability" the whole of the host-side wiring.
  it("gates Preview and Templates on capabilities, with a reason each", () => {
    const withoutEither = resolveScreens(defaultScreens, {
      hasLoadedPage: true,
      capabilities: ["pdf-export", "docx-export"],
    });
    const preview = withoutEither.find((s) => s.definition.id === SCREEN_IDS.preview);
    expect(preview?.visible).toBe(true);
    expect(preview?.available).toBe(false);
    expect(preview?.reasonKey).toBe("screen.unmet.capability.pdfPreview");

    const templates = withoutEither.find((s) => s.definition.id === SCREEN_IDS.templates);
    expect(templates?.visible).toBe(true);
    expect(templates?.available).toBe(false);
    expect(templates?.reasonKey).toBe("screen.unmet.capability.templateLibrary");

    const withBoth = resolveScreens(defaultScreens, {
      hasLoadedPage: true,
      capabilities: ["pdf-export", "docx-export", "pdf-preview", "template-library"],
    });
    expect(withBoth.find((s) => s.definition.id === SCREEN_IDS.preview)?.available).toBe(true);
    expect(withBoth.find((s) => s.definition.id === SCREEN_IDS.templates)?.available).toBe(true);
  });

  // Preview additionally needs a page: previewing "nothing" is not a state.
  it("keeps Preview unavailable without a loaded page even with the capability", () => {
    const resolved = resolveScreens(defaultScreens, {
      hasLoadedPage: false,
      capabilities: ["pdf-preview", "template-library"],
    });
    const preview = resolved.find((s) => s.definition.id === SCREEN_IDS.preview);
    expect(preview?.available).toBe(false);
    expect(preview?.reasonKey).toBe("screen.unmet.page");
  });

  it("has unique ids and unique nav order", () => {
    const ids = defaultScreens.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = defaultScreens.map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("treats Preview as a Studio capability, not a competing primary area", () => {
    expect(defaultScreens.find((screen) => screen.id === SCREEN_IDS.preview)?.navigation).toBe(
      "hidden"
    );
    expect(defaultScreens.find((screen) => screen.id === SCREEN_IDS.export)?.navigation).toBe(
      "primary"
    );
    expect(defaultScreens.find((screen) => screen.id === SCREEN_IDS.settings)?.navigation).toBe(
      "utility"
    );
  });

  it("keeps Export reachable with no page open, so there is always a landing screen", () => {
    const resolved = resolveScreens(defaultScreens, NOTHING);
    const exportScreen = resolved.find((s) => s.definition.id === SCREEN_IDS.export);
    expect(exportScreen?.available).toBe(true);
  });

  it("leaves Activity disabled with a reason until a host advertises durable jobs", () => {
    const withoutJobs = resolveScreens(defaultScreens, {
      hasLoadedPage: true,
      capabilities: ["pdf-export", "docx-export"],
    });
    const activity = withoutJobs.find((s) => s.definition.id === SCREEN_IDS.activity);
    expect(activity?.visible).toBe(true);
    expect(activity?.available).toBe(false);
    expect(activity?.reasonKey).toBe("screen.unmet.capability.durableJobs");

    const withJobs = resolveScreens(defaultScreens, ALL);
    expect(withJobs.find((s) => s.definition.id === SCREEN_IDS.activity)?.available).toBe(true);
  });
});
