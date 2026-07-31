import { describe, expect, test } from "bun:test";
import {
  PublicationRoutePlanningErrorV1,
  normalizePublicationRoutePrefixV1,
  normalizePublicationRouteV1,
  planPublicationRoutesV1,
  publicationRouteToOutputPathV1,
  publicationSlugV1,
  validatePublicationOutputPathV1,
  type PublicationRoutePlanRequestV1,
  type PublicationRoutePolicyV1,
  type PublicationRouteRecordV1,
} from "./index.js";

const policy = {
  prefix: "",
  generatedStyle: "stable-pretty",
  collisions: "stable-source-suffix",
  tombstones: "retain",
  customRoutes: [],
} as const satisfies PublicationRoutePolicyV1;

function plan(
  request: Partial<PublicationRoutePlanRequestV1> &
    Pick<PublicationRoutePlanRequestV1, "pages">,
) {
  return planPublicationRoutesV1({
    previousRoutes: [],
    tombstoneSourceIds: [],
    policy,
    outputProfile: "directory",
    ...request,
  });
}

function routeRecord(
  sourceId: string,
  route: string,
  overrides: Partial<PublicationRouteRecordV1> = {},
): PublicationRouteRecordV1 {
  return {
    sourceId,
    route,
    state: "active",
    assignedBy: "generated",
    previousRoutes: [],
    ...overrides,
  };
}

function expectPlanningError(
  run: () => unknown,
  code: PublicationRoutePlanningErrorV1["code"],
): PublicationRoutePlanningErrorV1 {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PublicationRoutePlanningErrorV1);
    expect((error as PublicationRoutePlanningErrorV1).code).toBe(code);
    return error as PublicationRoutePlanningErrorV1;
  }
  throw new Error(`Expected PublicationRoutePlanningErrorV1(${code})`);
}

describe("publication route primitives", () => {
  test("creates safe Unicode-capable slugs and deterministic fallbacks", () => {
    expect(publicationSlugV1("Crème brûlée & Straße")).toBe("creme-brulee-strasse");
    expect(publicationSlugV1("東京 ガイド")).toBe("東京-ガイド");
    expect(publicationSlugV1("../\\/?!")).toBe("page");
    expect(publicationSlugV1("CON")).toBe("con-page");
    expect(Array.from(publicationSlugV1("a".repeat(200)))).toHaveLength(80);
  });

  test("normalizes only unambiguous prefixes and routes", () => {
    expect(normalizePublicationRoutePrefixV1("/")).toBe("");
    expect(normalizePublicationRoutePrefixV1("/docs")).toBe("/docs");
    expect(normalizePublicationRouteV1("/Guide")).toBe("/Guide/");
    expect(normalizePublicationRouteV1("/東京/ガイド/")).toBe("/東京/ガイド/");

    expectPlanningError(() => normalizePublicationRoutePrefixV1("docs"), "unsafe-prefix");
    expectPlanningError(() => normalizePublicationRouteV1("/a/../b/"), "unsafe-route");
    expectPlanningError(() => normalizePublicationRouteV1("/a\\b/"), "unsafe-route");
    expectPlanningError(() => normalizePublicationRouteV1("/a%2fb/"), "unsafe-route");
    expectPlanningError(() => normalizePublicationRouteV1("/a?query/"), "unsafe-route");
    expectPlanningError(() => normalizePublicationRouteV1("/nul/"), "unsafe-route");
    expectPlanningError(
      () => normalizePublicationRouteV1(`/${"a".repeat(121)}/`),
      "unsafe-route",
    );
  });

  test("maps logical routes to both Astro output profiles", () => {
    expect(publicationRouteToOutputPathV1("/", "directory")).toBe("index.html");
    expect(publicationRouteToOutputPathV1("/guide/", "directory"))
      .toBe("guide/index.html");
    expect(publicationRouteToOutputPathV1("/docs/guide/", "portable-file"))
      .toBe("docs/guide.html");
    expect(publicationRouteToOutputPathV1("/", "portable-file")).toBe("index.html");

    expect(validatePublicationOutputPathV1("_astro/app.123.js"))
      .toBe("_astro/app.123.js");
    expectPlanningError(() => validatePublicationOutputPathV1("../site.html"), "unsafe-output-path");
    expectPlanningError(() => validatePublicationOutputPathV1("C:\\site.html"), "unsafe-output-path");
    expectPlanningError(() => validatePublicationOutputPathV1("docs\\site.html"), "unsafe-output-path");
  });
});

describe("planPublicationRoutesV1", () => {
  test("assigns stable pretty routes in source-id order, independent of input order", () => {
    const forward = plan({
      pages: [
        { sourceId: "20", title: "Guide" },
        { sourceId: "10", title: "Guide" },
        { sourceId: "30", title: "Overview" },
      ],
    });
    const reversed = plan({ pages: [...[
      { sourceId: "20", title: "Guide" },
      { sourceId: "10", title: "Guide" },
      { sourceId: "30", title: "Overview" },
    ]].reverse() });

    expect(forward).toEqual(reversed);
    expect(forward.routes).toEqual([
      routeRecord("10", "/guide/"),
      routeRecord("20", "/guide-20/"),
      routeRecord("30", "/overview/"),
    ]);
    expect(forward.activeOutputs.map((entry) => entry.outputPath)).toEqual([
      "guide/index.html",
      "guide-20/index.html",
      "overview/index.html",
    ]);
  });

  test("retains the first route across title changes and tree moves", () => {
    const previous = routeRecord("10", "/old-title/");
    const result = plan({
      pages: [{ sourceId: "10", title: "Completely New Title" }],
      previousRoutes: [previous],
    });

    expect(result.routes).toEqual([previous]);
    expect(result.changes).toEqual([]);
  });

  test("applies an operator route, retains history, and never reverts implicitly", () => {
    const changed = plan({
      pages: [{ sourceId: "10", title: "Guide" }],
      previousRoutes: [routeRecord("10", "/guide/")],
      policy: { ...policy, customRoutes: [{ sourceId: "10", route: "/handbook/" }] },
    });
    expect(changed.routes).toEqual([routeRecord("10", "/handbook/", {
      assignedBy: "operator",
      previousRoutes: ["/guide/"],
    })]);
    expect(changed.changes).toEqual([{
      kind: "changed",
      sourceId: "10",
      previousRoute: "/guide/",
      nextRoute: "/handbook/",
    }]);

    const retained = plan({
      pages: [{ sourceId: "10", title: "Guide Again" }],
      previousRoutes: changed.routes,
    });
    expect(retained.routes).toEqual(changed.routes);
    expect(retained.changes).toEqual([]);
  });

  test("tombstones only explicit identities and restores the retained route", () => {
    const retained = routeRecord("10", "/guide/");
    const tombstoned = plan({
      pages: [],
      previousRoutes: [retained],
      tombstoneSourceIds: ["10"],
    });
    expect(tombstoned.routes).toEqual([{ ...retained, state: "tombstone" }]);
    expect(tombstoned.activeOutputs).toEqual([]);
    expect(tombstoned.changes).toEqual([{
      kind: "tombstoned",
      sourceId: "10",
      nextRoute: "/guide/",
    }]);

    const restored = plan({
      pages: [{ sourceId: "10", title: "Renamed Guide" }],
      previousRoutes: tombstoned.routes,
    });
    expect(restored.routes).toEqual([retained]);
    expect(restored.changes).toEqual([{
      kind: "reactivated",
      sourceId: "10",
      nextRoute: "/guide/",
    }]);
  });

  test("preserves unmentioned records during a partial refresh", () => {
    const previous = [
      routeRecord("10", "/present/"),
      routeRecord("20", "/temporarily-unseen/"),
    ];
    const result = plan({
      pages: [{ sourceId: "10", title: "Present" }],
      previousRoutes: previous,
    });
    expect(result.routes).toEqual(previous);
    expect(result.activeOutputs).toEqual([{
      sourceId: "10",
      route: "/present/",
      outputPath: "present/index.html",
    }]);
  });

  test("keeps tombstoned and historical routes reserved for new pages", () => {
    const result = plan({
      pages: [{ sourceId: "20", title: "Guide" }],
      previousRoutes: [routeRecord("10", "/guide/", {
        state: "tombstone",
        previousRoutes: ["/manual/"]
      })],
    });
    expect(result.routes).toEqual([
      routeRecord("10", "/guide/", {
        state: "tombstone",
        previousRoutes: ["/manual/"],
      }),
      routeRecord("20", "/guide-20/"),
    ]);
  });

  test("applies a safe prefix before allocation and output mapping", () => {
    const result = plan({
      pages: [{ sourceId: "10", title: "Guide" }],
      policy: { ...policy, prefix: "/docs" },
      outputProfile: "portable-file",
    });
    expect(result.routes[0]?.route).toBe("/docs/guide/");
    expect(result.activeOutputs[0]?.outputPath).toBe("docs/guide.html");
  });

  test("lets a new operator route win before generated collision allocation", () => {
    const result = plan({
      pages: [
        { sourceId: "10", title: "Guide" },
        { sourceId: "20", title: "Other" },
      ],
      policy: {
        ...policy,
        customRoutes: [{ sourceId: "20", route: "/guide/" }],
      },
    });
    expect(result.routes).toEqual([
      routeRecord("10", "/guide-10/"),
      routeRecord("20", "/guide/", { assignedBy: "operator" }),
    ]);
  });

  test("rejects duplicate active IDs and contradictory state", () => {
    expectPlanningError(() => plan({ pages: [
      { sourceId: "10", title: "One" },
      { sourceId: "10", title: "Two" },
    ] }), "duplicate-source-id");
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "One" }],
      previousRoutes: [routeRecord("10", "/one/")],
      tombstoneSourceIds: ["10"],
    }), "conflicting-source-state");
    expectPlanningError(() => plan({
      pages: [],
      tombstoneSourceIds: ["missing"],
    }), "unknown-tombstone-source");
  });

  test("rejects unsupported runtime policy and malformed retained records", () => {
    expectPlanningError(() => plan({
      pages: [],
      policy: { ...policy, generatedStyle: "future" as "stable-pretty" },
    }), "invalid-route-policy");
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "One" }],
      previousRoutes: [{
        ...routeRecord("10", "/one/"),
        state: "future" as "active",
      }],
    }), "invalid-route-record");
  });

  test("rejects duplicate records and duplicate or unknown custom mappings", () => {
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "One" }],
      previousRoutes: [routeRecord("10", "/one/"), routeRecord("10", "/two/")],
    }), "duplicate-route-record");
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "One" }],
      policy: { ...policy, customRoutes: [
        { sourceId: "10", route: "/one/" },
        { sourceId: "10", route: "/two/" },
      ] },
    }), "duplicate-custom-route");
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "One" }],
      policy: { ...policy, customRoutes: [{ sourceId: "20", route: "/two/" }] },
    }), "unknown-custom-source");
  });

  test("rejects unsafe and out-of-prefix custom routes", () => {
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "One" }],
      policy: { ...policy, customRoutes: [{ sourceId: "10", route: "/../escape/" }] },
    }), "unsafe-route");
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "One" }],
      policy: {
        ...policy,
        prefix: "/docs",
        customRoutes: [{ sourceId: "10", route: "/outside/" }],
      },
    }), "unsafe-route");
  });

  test("rejects exact and case-folded route collisions", () => {
    expectPlanningError(() => plan({
      pages: [
        { sourceId: "10", title: "One" },
        { sourceId: "20", title: "Two" },
      ],
      policy: { ...policy, customRoutes: [
        { sourceId: "10", route: "/same/" },
        { sourceId: "20", route: "/same/" },
      ] },
    }), "route-collision");
    expectPlanningError(() => plan({
      pages: [
        { sourceId: "10", title: "One" },
        { sourceId: "20", title: "Two" },
      ],
      policy: { ...policy, customRoutes: [
        { sourceId: "10", route: "/Guide/" },
        { sourceId: "20", route: "/guide/" },
      ] },
    }), "route-collision");
  });

  test("rejects portable-file and reserved output-path collisions", () => {
    expectPlanningError(() => plan({
      pages: [
        { sourceId: "10", title: "Root" },
        { sourceId: "20", title: "Index" },
      ],
      previousRoutes: [routeRecord("10", "/"), routeRecord("20", "/index/")],
      outputProfile: "portable-file",
    }), "output-path-collision");
    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "Guide" }],
      reservedOutputPaths: ["GUIDE/index.html"],
    }), "output-path-collision");
  });

  test("rejects handwritten route collisions before generated allocation", () => {
    const result = plan({
      pages: [{ sourceId: "10", title: "Guide" }],
      reservedRoutes: ["/guide/"],
    });
    expect(result.routes[0]?.route).toBe("/guide-10/");

    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "Guide" }],
      policy: { ...policy, customRoutes: [{ sourceId: "10", route: "/guide/" }] },
      reservedRoutes: ["/Guide/"],
    }), "route-collision");

    expectPlanningError(() => plan({
      pages: [{ sourceId: "10", title: "Index" }],
      reservedRoutes: ["/"],
      outputProfile: "portable-file",
    }), "output-path-collision");
  });
});
