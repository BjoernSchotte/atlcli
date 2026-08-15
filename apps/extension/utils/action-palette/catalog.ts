import {
  ACTION_GROUP_IDS,
  ACTION_IDS,
  type ActionModuleV1,
} from "@atlcli/action-registry";

export const EXTENSION_ACTION_CAPABILITIES_V1 = {
  pdf: "atlcli.capability.export.pdf",
  docx: "atlcli.capability.export.docx",
  surface: "atlcli.capability.surface.sidebar",
  ai: "atlcli.capability.ai.quick-ask",
  synthetic: "atlcli.capability.test.synthetic",
} as const;

const publishingModule: ActionModuleV1 = {
  schemaVersion: 1,
  id: "atlcli.module.publishing",
  actions: [
    {
      schemaVersion: 1,
      id: ACTION_IDS.exportPdfCurrentPage,
      moduleId: "atlcli.module.publishing",
      title: { key: "atlcli.action.export-pdf.title", fallback: "Export current page as PDF" },
      subtitle: { key: "atlcli.action.export-pdf.subtitle", fallback: "Open publishing and create a PDF" },
      keywords: ["pdf", "publish", "download"],
      group: ACTION_GROUP_IDS.export,
      icon: "document-pdf",
      intent: { kind: "export.current-page", format: "pdf" },
      requirements: [
        { kind: "product", product: "confluence" },
        { kind: "entity", entityKind: "atlcli.entity.confluence-page" },
        { kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.pdf },
      ],
      effect: "download",
      order: 10,
    },
    {
      schemaVersion: 1,
      id: ACTION_IDS.exportDocxCurrentPage,
      moduleId: "atlcli.module.publishing",
      title: { key: "atlcli.action.export-docx.title", fallback: "Export current page as DOCX" },
      subtitle: { key: "atlcli.action.export-docx.subtitle", fallback: "Open publishing and create a Word document" },
      keywords: ["docx", "word", "publish", "download"],
      group: ACTION_GROUP_IDS.export,
      icon: "document-docx",
      intent: { kind: "export.current-page", format: "docx" },
      requirements: [
        { kind: "product", product: "confluence" },
        { kind: "entity", entityKind: "atlcli.entity.confluence-page" },
        { kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.docx },
      ],
      effect: "download",
      order: 20,
    },
    {
      schemaVersion: 1,
      id: ACTION_IDS.configureDocx,
      moduleId: "atlcli.module.publishing",
      title: { key: "atlcli.action.configure-docx.title", fallback: "Configure DOCX export" },
      group: ACTION_GROUP_IDS.export,
      icon: "settings",
      intent: { kind: "export.configure-docx" },
      requirements: [{ kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.docx }],
      effect: "external-navigation",
      order: 30,
    },
  ],
};

const aiModule: ActionModuleV1 = {
  schemaVersion: 1,
  id: "atlcli.module.research-ai",
  actions: [{
    schemaVersion: 1,
    id: ACTION_IDS.quickAsk,
    moduleId: "atlcli.module.research-ai",
    title: { key: "atlcli.action.quick-ask.title", fallback: "Ask AI about this page" },
    subtitle: { key: "atlcli.action.quick-ask.subtitle", fallback: "Use the existing Kiteweave AI session" },
    keywords: ["ai", "ask", "research"],
    group: ACTION_GROUP_IDS.ai,
    icon: "sparkles",
    intent: { kind: "ai.quick-ask" },
    requirements: [{ kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.ai }],
    effect: "read",
    input: {
      schemaVersion: 1,
      fields: [{
        type: "text",
        id: "question",
        label: { key: "atlcli.action.quick-ask.question", fallback: "Question" },
        placeholder: { key: "atlcli.action.quick-ask.placeholder", fallback: "Ask about the current page…" },
        required: true,
        multiline: true,
        minLength: 3,
        maxLength: 2_000,
      }, {
        type: "boolean",
        id: "disclosure",
        label: {
          key: "atlcli.action.quick-ask.disclosure",
          fallback: "I understand that the current Atlassian context is sent to the selected LLM provider.",
        },
        required: true,
      }],
      submitLabel: { key: "atlcli.action.quick-ask.submit", fallback: "Ask AI" },
    },
    order: 10,
  }],
};

const navigationTargets = [
  [ACTION_IDS.openSidebar, "export", "Open Kiteweave sidebar"],
  [ACTION_IDS.openPublishing, "export", "Open Publishing"],
  [ACTION_IDS.openResearch, "research", "Open Research"],
  [ACTION_IDS.openActivity, "activity", "Open Activity"],
] as const;

const navigationModule: ActionModuleV1 = {
  schemaVersion: 1,
  id: "atlcli.module.navigation",
  actions: navigationTargets.map(([id, screen, title], order) => ({
    schemaVersion: 1 as const,
    id,
    moduleId: "atlcli.module.navigation",
    title: { key: `atlcli.action.${id.split(".").slice(-2).join("-")}.title`, fallback: title },
    group: ACTION_GROUP_IDS.navigation,
    icon: screen === "activity" ? "activity" as const : screen === "research" ? "research" as const : "sidebar" as const,
    intent: { kind: "surface.open" as const, target: { kind: "sidebar" as const, screen } },
    requirements: [{ kind: "capability" as const, capability: EXTENSION_ACTION_CAPABILITIES_V1.surface }],
    effect: "external-navigation" as const,
    order: order * 10,
  })),
};

/** Compile-time fixture; inert unless a host registers its exact capability and executor. */
export const SYNTHETIC_EXTENSION_ACTION_MODULE_V1: ActionModuleV1 = {
  schemaVersion: 1,
  id: "atlcli.module.synthetic-fixture",
  actions: [{
    schemaVersion: 1,
    id: "atlcli.test.synthetic-action",
    moduleId: "atlcli.module.synthetic-fixture",
    title: { key: "atlcli.action.synthetic.title", fallback: "Synthetic contribution" },
    group: ACTION_GROUP_IDS.suggested,
    icon: "extension",
    intent: { kind: "contribution.extension-test", payload: { fixture: true } },
    requirements: [{ kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.synthetic }],
    effect: "read",
    input: {
      schemaVersion: 1,
      fields: [{
        type: "select",
        id: "fixture",
        label: { key: "atlcli.action.synthetic.fixture", fallback: "Fixture" },
        required: true,
        options: [{ id: "yes", label: { key: "atlcli.action.synthetic.yes", fallback: "Yes" } }],
      }],
      submitLabel: { key: "atlcli.action.synthetic.submit", fallback: "Run fixture" },
    },
    order: 999,
  }],
};

export const EXTENSION_ACTION_MODULES_V1: readonly ActionModuleV1[] = Object.freeze([
  publishingModule,
  aiModule,
  navigationModule,
]);

export const EXTENSION_CONTRIBUTION_INTENT_KINDS_V1 = ["contribution.extension-test"] as const;
