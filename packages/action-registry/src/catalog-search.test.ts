import { describe, expect, test } from "bun:test";
import {
  ACTION_GROUP_IDS,
  EMPTY_ACTION_SELECTION_V1,
  createActionCatalog,
  getExecutableSelectedActionV1,
  moveActionSelectionV1,
  normalizeActionSearchTextV1,
  repairActionSelectionV1,
  searchActionCatalog,
  selectActionByIdV1,
  type ActionDefinitionV1,
  type ActionModuleV1,
  type ActionSearchResultV1,
  type ActionSurfaceContextV1,
} from "./index.js";

const context: ActionSurfaceContextV1 = {
  siteOrigin: "https://example.atlassian.net",
  product: "confluence",
  entity: {
    kind: "atlcli.entity.confluence-page",
    id: "page-1",
    title: "Fixture page",
    url: "https://example.atlassian.net/wiki/spaces/EX/pages/1",
  },
  locale: "en-US",
  capabilities: ["atlcli.capability.enabled"],
};

interface ActionOptions {
  title?: string;
  subtitle?: string;
  keywords?: readonly string[];
  group?: string;
  order?: number;
  requirements?: ActionDefinitionV1["requirements"];
}

function action(
  moduleId: string,
  id: string,
  options: ActionOptions = {},
): ActionDefinitionV1 {
  return {
    schemaVersion: 1,
    id,
    moduleId,
    title: {
      key: `${id}.title`,
      fallback: options.title ?? id,
    },
    ...(options.subtitle
      ? { subtitle: { key: `${id}.subtitle`, fallback: options.subtitle } }
      : {}),
    ...(options.keywords ? { keywords: options.keywords } : {}),
    group: options.group ?? ACTION_GROUP_IDS.navigation,
    icon: "extension",
    intent: {
      kind: "surface.open",
      target: { kind: "sidebar", screen: "settings" },
    },
    ...(options.requirements ? { requirements: options.requirements } : {}),
    effect: "read",
    ...(options.order === undefined ? {} : { order: options.order }),
  };
}

function moduleWith(
  id: string,
  definitions: readonly ActionDefinitionV1[],
): ActionModuleV1 {
  return { schemaVersion: 1, id, actions: definitions };
}

function ids(results: readonly ActionSearchResultV1[]): string[] {
  return results.map((result) => result.entry.action.id);
}

function singleActionCatalog(options: ActionOptions = {}) {
  const moduleId = "test.search-module";
  return createActionCatalog(
    [moduleWith(moduleId, [action(moduleId, "test.search-action", options)])],
    context,
  );
}

describe("deterministic action catalog", () => {
  test("uses stable group, order, and declaration ordering", () => {
    const moduleId = "test.order-module";
    const catalog = createActionCatalog(
      [
        moduleWith(moduleId, [
          action(moduleId, "test.navigation-late", {
            title: "Same label",
            group: ACTION_GROUP_IDS.navigation,
            order: 20,
          }),
          action(moduleId, "test.export-second", {
            title: "Same label",
            group: ACTION_GROUP_IDS.export,
            order: 10,
          }),
          action(moduleId, "test.export-first", {
            title: "Same label",
            group: ACTION_GROUP_IDS.export,
            order: 10,
          }),
          action(moduleId, "test.suggested", {
            group: ACTION_GROUP_IDS.suggested,
          }),
          action(moduleId, "test.unknown-z", { group: "test.group.z" }),
          action(moduleId, "test.unknown-a", { group: "test.group.a" }),
        ]),
      ],
      context,
    );

    expect(catalog.actions.map((entry) => entry.action.id)).toEqual([
      "test.suggested",
      "test.export-second",
      "test.export-first",
      "test.navigation-late",
      "test.unknown-a",
      "test.unknown-z",
    ]);
    expect(catalog.actions.map((entry) => entry.catalogIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.actionsById)).toBe(true);
  });

  test("honors a de-duplicated custom group order", () => {
    const moduleId = "test.custom-order-module";
    const catalog = createActionCatalog(
      [moduleWith(moduleId, [
        action(moduleId, "test.export", { group: ACTION_GROUP_IDS.export }),
        action(moduleId, "test.navigation", { group: ACTION_GROUP_IDS.navigation }),
      ])],
      context,
      { groupOrder: [ACTION_GROUP_IDS.navigation, ACTION_GROUP_IDS.navigation] },
    );
    expect(catalog.actions.map((entry) => entry.action.id)).toEqual([
      "test.navigation",
      "test.export",
    ]);
  });

  test("fails closed on duplicate module and cross-module action ids", () => {
    const duplicateModuleId = "test.duplicate-module";
    const actionCollision = "test.same-action";
    const catalog = createActionCatalog(
      [
        moduleWith(duplicateModuleId, [action(duplicateModuleId, "test.module-copy-a")]),
        moduleWith(duplicateModuleId, [action(duplicateModuleId, "test.module-copy-b")]),
        moduleWith("test.unique-a", [action("test.unique-a", actionCollision)]),
        moduleWith("test.unique-b", [action("test.unique-b", actionCollision)]),
        moduleWith("test.safe", [action("test.safe", "test.safe-action")]),
      ],
      context,
    );

    expect(catalog.hasErrors).toBe(true);
    expect(catalog.diagnostics).toEqual([
      {
        code: "duplicate-action-id",
        id: actionCollision,
        moduleIds: ["test.unique-a", "test.unique-b"],
        sourceIndexes: [2, 3],
      },
      {
        code: "duplicate-module-id",
        id: duplicateModuleId,
        moduleIds: [duplicateModuleId, duplicateModuleId],
        sourceIndexes: [0, 1],
      },
    ]);
    expect(catalog.actions.map((entry) => entry.action.id)).toEqual(["test.safe-action"]);
    expect(Object.isFrozen(catalog.diagnostics[0])).toBe(true);
  });

  test("resolves every unmet context and capability requirement", () => {
    const moduleId = "test.availability-module";
    const catalog = createActionCatalog(
      [moduleWith(moduleId, [action(moduleId, "test.unavailable", {
        requirements: [
          { kind: "product", product: "jira" },
          { kind: "entity", entityKind: "atlcli.entity.jira-issue" },
          { kind: "capability", capability: "test.capability.missing" },
        ],
      })])],
      context,
    );
    expect(catalog.actions[0]!.availability).toEqual({
      available: false,
      reasons: [
        expect.objectContaining({ code: "wrong-product" }),
        expect.objectContaining({ code: "wrong-entity-kind" }),
        expect.objectContaining({ code: "missing-capability" }),
      ],
    });
  });
});

describe("locale-aware deterministic action search", () => {
  test("normalizes Unicode, punctuation, whitespace, and diacritics", () => {
    expect(normalizeActionSearchTextV1("  Résumé—Überblick  ", "de-DE")).toBe(
      "resume uberblick",
    );
    expect(normalizeActionSearchTextV1("İSTANBUL", "tr-TR")).toBe("istanbul");
    expect(normalizeActionSearchTextV1("Crème brûlée", "not_a_locale")).toBe(
      "creme brulee",
    );
  });

  test.each([
    { title: "Export page", query: "export page", expectedKind: "title-exact" },
    { title: "Export page quickly", query: "export", expectedKind: "title-prefix" },
    { title: "Export this page quickly", query: "ex pa", expectedKind: "title-token-prefix" },
    {
      title: "Create file",
      extra: { keywords: ["portable document"] },
      query: "portable document",
      expectedKind: "keyword-exact",
    },
    {
      title: "Create file",
      extra: { keywords: ["portable document"] },
      query: "portable",
      expectedKind: "keyword-prefix",
    },
    {
      title: "Create file",
      extra: { keywords: ["portable document"] },
      query: "port doc",
      expectedKind: "keyword-token-prefix",
    },
    { title: "Create file", query: "cetfl", expectedKind: "subsequence" },
  ] as const)(
    "classifies $query as $expectedKind",
    ({ title, extra, query, expectedKind }) => {
      const results = searchActionCatalog(
        singleActionCatalog({ title, ...(extra ?? {}) }),
        query,
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.matchKind).toBe(expectedKind);
    },
  );

  test("scores localized aliases and preserves catalog order for duplicate labels", () => {
    const moduleId = "test.alias-module";
    const catalog = createActionCatalog(
      [moduleWith(moduleId, [
        action(moduleId, "test.first", { title: "Same label", order: 5 }),
        action(moduleId, "test.second", { title: "Same label", order: 5 }),
        action(moduleId, "test.alias", { title: "Download document" }),
      ])],
      context,
    );
    expect(ids(searchActionCatalog(catalog, "same label"))).toEqual([
      "test.first",
      "test.second",
    ]);
    const aliasResult = searchActionCatalog(catalog, "herunterladen", {
      locale: "de-DE",
      aliases: { "test.alias": ["Herunterladen"] },
    });
    expect(aliasResult[0]!.entry.action.id).toBe("test.alias");
    expect(aliasResult[0]!.matchKind).toBe("alias-exact");
    expect(
      searchActionCatalog(catalog, "herunter", {
        locale: "de-DE",
        aliases: { "test.alias": ["Herunterladen"] },
      })[0]!.matchKind,
    ).toBe("alias-prefix");
  });

  test("keeps relevant disabled suggestions and exposes all explicit matches", () => {
    const moduleId = "test.disabled-module";
    const catalog = createActionCatalog(
      [moduleWith(moduleId, [
        action(moduleId, "test.available", { title: "Export available" }),
        action(moduleId, "test.missing-capability", {
          title: "Export needs setup",
          requirements: [{ kind: "capability", capability: "test.capability.missing" }],
        }),
        action(moduleId, "test.wrong-product", {
          title: "Export Jira issue",
          requirements: [{ kind: "product", product: "jira" }],
        }),
        action(moduleId, "test.missing-entity", {
          title: "Export issue context",
          requirements: [{ kind: "entity", entityKind: "atlcli.entity.jira-issue" }],
        }),
      ])],
      context,
    );

    expect(ids(searchActionCatalog(catalog, ""))).toEqual([
      "test.available",
      "test.missing-capability",
    ]);
    expect(ids(searchActionCatalog(catalog, "export"))).toEqual([
      "test.available",
      "test.wrong-product",
      "test.missing-capability",
      "test.missing-entity",
    ]);
  });

  test("returns inspectable rows when no action can execute", () => {
    const moduleId = "test.no-enabled-module";
    const catalog = createActionCatalog(
      [moduleWith(moduleId, [action(moduleId, "test.needs-host", {
        title: "Needs host capability",
        requirements: [{ kind: "capability", capability: "test.capability.missing" }],
      })])],
      { ...context, capabilities: [] },
    );
    const results = searchActionCatalog(catalog, "");
    const selection = moveActionSelectionV1(EMPTY_ACTION_SELECTION_V1, results, "next");
    expect(results).toHaveLength(1);
    expect(selection.activeActionId).toBe("test.needs-host");
    expect(getExecutableSelectedActionV1(selection, results)).toBeNull();
  });

  test("is repeatable for seeded queries over a 1,000-action catalog", () => {
    const moduleId = "test.large-module";
    const definitions = Array.from({ length: 1_000 }, (_, index) =>
      action(moduleId, `test.large.action-${index.toString().padStart(4, "0")}`, {
        title: `Action ${index.toString().padStart(4, "0")} Résumé`,
        keywords: [`keyword-${index % 31}`, `bucket-${index % 7}`],
        order: (index * 17) % 101,
      }),
    );
    const catalog = createActionCatalog([moduleWith(moduleId, definitions)], context);
    expect(catalog.actions).toHaveLength(1_000);

    let seed = 0x1a2b3c4d;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const query = iteration % 5 === 0 ? "resume" : `action ${next() % 1_000}`;
      const first = ids(searchActionCatalog(catalog, query, { limit: 25 }));
      const second = ids(searchActionCatalog(catalog, query, { limit: 25 }));
      expect(second).toEqual(first);
      expect(new Set(first).size).toBe(first.length);
    }
  });

  test("bounds limits and ignores overlong query tails deterministically", () => {
    const catalog = singleActionCatalog({ title: "Needle action" });
    expect(searchActionCatalog(catalog, "needle", { limit: -5 })).toEqual([]);
    expect(searchActionCatalog(catalog, `needle${"x".repeat(1_000)}`)).toEqual([]);
    expect(searchActionCatalog(catalog, "needle", { limit: Number.NaN })).toHaveLength(1);
  });
});

describe("pure visible-row selection", () => {
  const moduleId = "test.selection-module";
  const catalog = createActionCatalog(
    [moduleWith(moduleId, [
      action(moduleId, "test.row-a", { title: "Row A" }),
      action(moduleId, "test.row-b-disabled", {
        title: "Row B",
        requirements: [{ kind: "capability", capability: "test.capability.missing" }],
      }),
      action(moduleId, "test.row-c", { title: "Row C" }),
    ])],
    context,
  );
  const results = searchActionCatalog(catalog, "");

  test("moves across unavailable rows without wrapping and gates execution", () => {
    let state = moveActionSelectionV1(EMPTY_ACTION_SELECTION_V1, results, "next");
    expect(state).toEqual({ activeActionId: "test.row-a", anchorIndex: 0 });
    state = moveActionSelectionV1(state, results, "next");
    expect(state.activeActionId).toBe("test.row-b-disabled");
    expect(getExecutableSelectedActionV1(state, results)).toBeNull();
    state = moveActionSelectionV1(state, results, "next");
    expect(state.activeActionId).toBe("test.row-c");
    expect(getExecutableSelectedActionV1(state, results)?.action.id).toBe("test.row-c");
    expect(moveActionSelectionV1(state, results, "next")).toEqual(state);
    expect(moveActionSelectionV1(state, results, "first").activeActionId).toBe("test.row-a");
    expect(moveActionSelectionV1(state, results, "last").activeActionId).toBe("test.row-c");
    expect(moveActionSelectionV1(EMPTY_ACTION_SELECTION_V1, results, "previous").activeActionId).toBe("test.row-c");
  });

  test("repairs by stable ID, then clamped former index", () => {
    const selected = selectActionByIdV1("test.row-b-disabled", results)!;
    expect(repairActionSelectionV1(selected, [...results].reverse()).activeActionId).toBe(
      "test.row-b-disabled",
    );
    const filtered = results.filter((result) => result.entry.action.id !== "test.row-b-disabled");
    expect(repairActionSelectionV1(selected, filtered)).toEqual({
      activeActionId: "test.row-c",
      anchorIndex: 1,
    });
    expect(repairActionSelectionV1({ activeActionId: "stale", anchorIndex: 99 }, filtered).activeActionId).toBe("test.row-c");
    expect(repairActionSelectionV1({ activeActionId: "stale", anchorIndex: Number.NaN }, filtered).activeActionId).toBe("test.row-a");
    expect(repairActionSelectionV1(selected, [])).toBe(EMPTY_ACTION_SELECTION_V1);
    expect(selectActionByIdV1("missing", results)).toBeNull();
  });
});
