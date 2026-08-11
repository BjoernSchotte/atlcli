export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const ACTION_SCHEMA_VERSION = 1 as const;

export const ACTION_IDS = {
  exportPdfCurrentPage: "atlcli.export.pdf.current-page",
  exportDocxCurrentPage: "atlcli.export.docx.current-page",
  configureDocx: "atlcli.export.docx.configure",
  openSidebar: "atlcli.sidebar.open",
  openPublishing: "atlcli.sidebar.publishing",
  openResearch: "atlcli.sidebar.research",
  openActivity: "atlcli.sidebar.activity",
  quickAsk: "atlcli.ai.quick-ask",
} as const;

export type BuiltInActionIdV1 = typeof ACTION_IDS[keyof typeof ACTION_IDS];

export const ACTION_GROUP_IDS = {
  suggested: "atlcli.group.suggested",
  export: "atlcli.group.export",
  ai: "atlcli.group.ai",
  navigation: "atlcli.group.navigation",
} as const;

export type BuiltInActionGroupIdV1 =
  typeof ACTION_GROUP_IDS[keyof typeof ACTION_GROUP_IDS];
export type ActionGroupIdV1 = string;

export interface ActionTextV1 {
  readonly key: string;
  readonly fallback: string;
}

export type ActionIconTokenV1 =
  | "activity"
  | "document-docx"
  | "document-pdf"
  | "extension"
  | "research"
  | "settings"
  | "sidebar"
  | "sparkles";

export type ActionEffectV1 =
  | "read"
  | "download"
  | "external-navigation"
  | "write";

export type AtlassianProductV1 = "confluence" | "jira" | "atlassian";

export interface ActionEntityV1 {
  readonly kind: string;
  readonly id: string;
  readonly key?: string;
  readonly title?: string;
  readonly url: string;
}

export interface ActionSurfaceContextV1 {
  readonly siteOrigin: string;
  readonly product: AtlassianProductV1;
  readonly entity?: ActionEntityV1;
  readonly locale: string;
  readonly capabilities: readonly string[];
}

export type ActionRequirementV1 =
  | {
      readonly kind: "capability";
      readonly capability: string;
    }
  | {
      readonly kind: "product";
      readonly product: AtlassianProductV1;
    }
  | {
      readonly kind: "entity";
      readonly entityKind?: string;
    };

export type ActionUnavailableReasonCodeV1 =
  | "missing-capability"
  | "wrong-product"
  | "missing-entity"
  | "wrong-entity-kind";

export const ACTION_UNAVAILABLE_TEXTS = {
  "missing-capability": {
    key: "atlcli.action.unavailable.missing-capability",
    fallback: "This capability is not available in the current host.",
  },
  "wrong-product": {
    key: "atlcli.action.unavailable.wrong-product",
    fallback: "This action is not available for the current Atlassian product.",
  },
  "missing-entity": {
    key: "atlcli.action.unavailable.missing-entity",
    fallback: "Open a supported page or issue to use this action.",
  },
  "wrong-entity-kind": {
    key: "atlcli.action.unavailable.wrong-entity-kind",
    fallback: "This action is not available for the current item type.",
  },
} as const satisfies Record<ActionUnavailableReasonCodeV1, ActionTextV1>;

export interface ActionUnavailableReasonV1 {
  readonly code: ActionUnavailableReasonCodeV1;
  readonly message: ActionTextV1;
  readonly requirement: ActionRequirementV1;
}

export type ActionAvailabilityV1 =
  | { readonly available: true; readonly reasons: readonly [] }
  | {
      readonly available: false;
      readonly reasons: readonly ActionUnavailableReasonV1[];
    };

export type SidebarScreenTargetV1 =
  | "export"
  | "research"
  | "activity"
  | "settings";

export type ActionSurfaceTargetV1 =
  | {
      readonly kind: "sidebar";
      readonly screen: SidebarScreenTargetV1;
      readonly continuationId?: string;
    }
  | {
      readonly kind: "forge-modal";
      readonly format: "pdf" | "docx";
      readonly sessionId?: string;
    };

export type BuiltInActionIntentV1 =
  | {
      readonly kind: "export.current-page";
      readonly format: "pdf" | "docx";
    }
  | { readonly kind: "export.configure-docx" }
  | {
      readonly kind: "surface.open";
      readonly target: ActionSurfaceTargetV1;
    }
  | { readonly kind: "ai.quick-ask" };

/**
 * Compile-time contributions use a reserved namespace. A host must still add
 * the exact kind to its runtime validator policy and executor allowlist.
 */
export interface ContributedActionIntentV1 {
  readonly kind: `contribution.${string}`;
  readonly payload?: JsonValue;
}

export type ActionIntentV1 =
  | BuiltInActionIntentV1
  | ContributedActionIntentV1;

export interface ActionTextInputV1 {
  readonly type: "text";
  readonly id: string;
  readonly label: ActionTextV1;
  readonly placeholder?: ActionTextV1;
  readonly required?: boolean;
  readonly multiline?: boolean;
  readonly minLength?: number;
  readonly maxLength: number;
}

export interface ActionSelectOptionV1 {
  readonly id: string;
  readonly label: ActionTextV1;
}

export interface ActionSelectInputV1 {
  readonly type: "select";
  readonly id: string;
  readonly label: ActionTextV1;
  readonly required?: boolean;
  readonly options: readonly ActionSelectOptionV1[];
}

/** Explicit per-invocation acknowledgement; serialized as the string `"true"`. */
export interface ActionBooleanInputV1 {
  readonly type: "boolean";
  readonly id: string;
  readonly label: ActionTextV1;
  readonly required?: boolean;
}

export type ActionInputFieldV1 =
  | ActionTextInputV1
  | ActionSelectInputV1
  | ActionBooleanInputV1;

export interface ActionInputSchemaV1 {
  readonly schemaVersion: 1;
  readonly fields: readonly ActionInputFieldV1[];
  readonly submitLabel: ActionTextV1;
}

export type ActionInputValuesV1 = Readonly<Record<string, string>>;

export interface ActionAffordanceV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: ActionTextV1;
  readonly intent: ActionIntentV1;
  readonly requirements?: readonly ActionRequirementV1[];
  readonly effect: ActionEffectV1;
  readonly availability?: ActionAvailabilityV1;
}

export interface ActionDefinitionV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly moduleId: string;
  readonly title: ActionTextV1;
  readonly subtitle?: ActionTextV1;
  readonly keywords?: readonly string[];
  readonly group: ActionGroupIdV1;
  readonly icon: ActionIconTokenV1;
  readonly intent: ActionIntentV1;
  readonly secondaryActions?: readonly ActionAffordanceV1[];
  readonly requirements?: readonly ActionRequirementV1[];
  readonly effect: ActionEffectV1;
  readonly input?: ActionInputSchemaV1;
  readonly order?: number;
}

export interface ActionModuleV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly actions: readonly ActionDefinitionV1[];
}

export interface ResolvedActionDefinitionV1 {
  readonly action: ActionDefinitionV1;
  readonly availability: ActionAvailabilityV1;
}

export interface ActionExecutionRequestV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly actionId: string;
  readonly intent: ActionIntentV1;
  readonly context: ActionSurfaceContextV1;
  readonly input?: ActionInputValuesV1;
}

export type ActionReceiptStatusV1 = "queued" | "running" | "completed" | "failed";
export type ActionHostKindV1 = "extension" | "forge";

/** Safe to persist or show. It deliberately contains no tenant or entity data. */
export interface ActionReceiptV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly actionId: string;
  readonly status: ActionReceiptStatusV1;
  readonly host: ActionHostKindV1;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly jobKind?: "pdf" | "docx" | "research";
}

export type ActionResultV1 =
  | {
      readonly status: "completed";
      readonly messageKey: string;
      /** Ephemeral host-validated output. Presenters render it as text, never HTML. */
      readonly presentation?: {
        readonly kind: "markdown";
        readonly text: string;
        readonly truncated: boolean;
      };
      readonly actions?: readonly ActionAffordanceV1[];
    }
  | {
      readonly status: "queued";
      readonly receipt: ActionReceiptV1;
      readonly actions?: readonly ActionAffordanceV1[];
    }
  | {
      readonly status: "input-required";
      readonly input: ActionInputSchemaV1;
    }
  | {
      readonly status: "open-surface";
      readonly target: ActionSurfaceTargetV1;
      readonly actions?: readonly ActionAffordanceV1[];
    }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      readonly messageKey: string;
      readonly retryable: boolean;
    };

export interface ActionExecutorPortV1 {
  execute(
    request: ActionExecutionRequestV1,
    signal: AbortSignal,
  ): Promise<ActionResultV1>;
}

export interface ActionReceiptProjectionInputV1 {
  readonly id: unknown;
  readonly actionId: unknown;
  readonly status: unknown;
  readonly host: unknown;
  readonly createdAt: unknown;
  readonly completedAt?: unknown;
  readonly jobKind?: unknown;
  readonly [internalField: string]: unknown;
}
