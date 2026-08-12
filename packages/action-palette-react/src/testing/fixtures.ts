import {
  ACTION_GROUP_IDS,
  createActionCatalog,
  type ActionDefinitionV1,
  type ActionModuleV1,
  type ActionSurfaceContextV1,
} from "@atlcli/action-registry";

export const paletteContextV1: ActionSurfaceContextV1 = {
  siteOrigin: "https://example.atlassian.net",
  product: "confluence",
  entity: {
    kind: "atlcli.entity.confluence-page",
    id: "page-1",
    title: "Fixture page",
    url: "https://example.atlassian.net/wiki/spaces/EX/pages/1",
  },
  locale: "en-US",
  capabilities: ["test.capability.enabled"],
};

export const paletteModuleV1: ActionModuleV1 = {
  schemaVersion: 1,
  id: "test.palette-module",
  actions: [
    {
      schemaVersion: 1,
      id: "test.palette.export-pdf",
      moduleId: "test.palette-module",
      title: { key: "test.export.title", fallback: "Export current page as PDF" },
      subtitle: { key: "test.export.subtitle", fallback: "Create a durable export" },
      keywords: ["download", "document"],
      group: ACTION_GROUP_IDS.export,
      icon: "document-pdf",
      intent: { kind: "export.current-page", format: "pdf" },
      secondaryActions: [
        {
          schemaVersion: 1,
          id: "test.palette.open-activity",
          title: { key: "test.activity.title", fallback: "Open Activity" },
          intent: {
            kind: "surface.open",
            target: { kind: "sidebar", screen: "activity" },
          },
          effect: "read",
        },
        {
          schemaVersion: 1,
          id: "test.palette.needs-capability",
          title: { key: "test.unavailable.title", fallback: "Unavailable option" },
          intent: {
            kind: "surface.open",
            target: { kind: "sidebar", screen: "settings" },
          },
          requirements: [
            { kind: "capability", capability: "test.capability.missing" },
          ],
          effect: "read",
        },
      ],
      effect: "download",
      order: 10,
    },
    {
      schemaVersion: 1,
      id: "test.palette.quick-ask",
      moduleId: "test.palette-module",
      title: { key: "test.ask.title", fallback: "Ask AI about this page" },
      group: ACTION_GROUP_IDS.ai,
      icon: "sparkles",
      intent: { kind: "ai.quick-ask" },
      effect: "read",
      input: {
        schemaVersion: 1,
        fields: [
          {
            type: "text",
            id: "question",
            label: { key: "test.question.label", fallback: "Question" },
            placeholder: { key: "test.question.placeholder", fallback: "What do you want to know?" },
            required: true,
            multiline: true,
            minLength: 2,
            maxLength: 200,
          },
          {
            type: "boolean",
            id: "disclosure",
            label: {
              key: "test.disclosure.label",
              fallback: "Send the current context to the selected AI provider",
            },
            required: true,
          },
        ],
        submitLabel: { key: "test.ask.submit", fallback: "Ask" },
      },
      order: 20,
    },
    {
      schemaVersion: 1,
      id: "test.palette.unavailable",
      moduleId: "test.palette-module",
      title: { key: "unknown.contribution.title", fallback: "Needs another host" },
      group: ACTION_GROUP_IDS.navigation,
      icon: "extension",
      intent: {
        kind: "surface.open",
        target: { kind: "sidebar", screen: "settings" },
      },
      requirements: [
        { kind: "capability", capability: "test.capability.missing" },
      ],
      effect: "read",
      order: 30,
    },
  ],
};

export function createPaletteCatalogV1(
  overrides: Partial<ActionSurfaceContextV1> = {},
) {
  return createActionCatalog(
    [paletteModuleV1],
    { ...paletteContextV1, ...overrides },
  );
}

export function longLabelActionV1(): ActionDefinitionV1 {
  return {
    ...paletteModuleV1.actions[0]!,
    id: "test.palette.long-label",
    title: {
      key: "test.long.title",
      fallback: "Eine sehr lange lokalisierte Aktionsbezeichnung mit zusätzlichen erklärenden Wörtern für schmale Ansichten",
    },
  };
}
