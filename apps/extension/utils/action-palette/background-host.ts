import {
  ACTION_IDS,
  createActionCatalog,
  parseActionExecutionRequestV1,
  parseActionResultV1,
  type ActionDefinitionV1,
  type ActionEffectV1,
  type ActionExecutionRequestV1,
  type ActionIntentV1,
  type ActionModuleV1,
  type ActionResultV1,
} from "@atlcli/action-registry";
import {
  ActionPaletteContextError,
  bindingsEqualV1,
  deriveActionPaletteContextV1,
  type ActionPaletteContextBindingV1,
  type ActionPaletteSenderV1,
  type ActionPaletteTabV1,
} from "./context.js";
import {
  EXTENSION_ACTION_MODULES_V1,
  EXTENSION_ACTION_CAPABILITIES_V1,
} from "./catalog.js";
import {
  actionPaletteInvalidRequest,
  isActionPaletteRequestV1,
  type ActionPaletteErrorCodeV1,
  type ActionPaletteRequestV1,
  type ActionPaletteResponseV1,
} from "./protocol.js";
import type { ActionPaletteExportRunnerV1 } from "./export-actions.js";

const ALLOWED_EFFECTS = new Set<ActionEffectV1>(["read", "download", "external-navigation"]);
const DEFAULT_LEASE_MS = 120_000;

export interface ActionPaletteExecutorEntryV1 {
  readonly actionId: string;
  readonly capability: string;
  readonly effect: ActionEffectV1;
  readonly intentKind: ActionIntentV1["kind"];
  execute(
    request: ActionExecutionRequestV1,
    signal: AbortSignal,
    assertContextCurrent: () => Promise<ActionPaletteContextBindingV1>,
    emit: (event: ActionPaletteExecutionStreamV1) => Promise<void>,
  ): Promise<ActionResultV1>;
}

export interface ActionPaletteExecutionStreamV1 {
  readonly sequence: number;
  readonly status: "started" | "delta" | "reset" | "completed";
  readonly delta?: string;
}

export interface ActionPaletteBackgroundDepsV1 {
  readonly getTab: (tabId: number) => Promise<ActionPaletteTabV1 | undefined>;
  readonly executors: readonly ActionPaletteExecutorEntryV1[];
  readonly modules?: readonly ActionModuleV1[];
  readonly allowedContributionIntentKinds?: readonly string[];
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly leaseMs?: number;
  readonly shortcutStatus?: () => Promise<{ status: "assigned" | "unbound"; value: string | null }>;
  readonly acknowledgeSurface?: (navigationId: string) => Promise<boolean>;
  readonly emitStream?: (
    sender: ActionPaletteSenderV1,
    event: Extract<ActionPaletteResponseV1, { kind: "action-palette:stream-event" }>,
  ) => Promise<void>;
  readonly reportExecutionError?: (
    caught: unknown,
    request: Pick<ActionExecutionRequestV1, "requestId" | "actionId">,
  ) => void;
}

interface CatalogLeaseV1 {
  readonly revision: string;
  readonly expiresAtMs: number;
  readonly binding: ActionPaletteContextBindingV1;
  readonly locale: string;
}

export interface ActionPaletteBackgroundHostV1 {
  readonly capabilities: readonly string[];
  handle(message: unknown, sender: ActionPaletteSenderV1): Promise<ActionPaletteResponseV1>;
  leaseCount(): number;
}

/** Redacted host diagnostics: never serialize rejection objects or execution context. */
export function actionPaletteErrorSummaryV1(caught: unknown): {
  readonly errorName: string;
  readonly errorMessage: string;
} {
  return {
    errorName: caught instanceof Error ? caught.name : typeof caught,
    errorMessage: caught instanceof Error ? caught.message : "Non-Error rejection",
  };
}

export type QueueActionPaletteSurfaceV1 = (
  screen: "export" | "research" | "activity" | "settings",
  continuationId?: string,
) => Promise<void>;

export interface ExtensionActionPaletteExecutorDepsV1 {
  readonly queueSurface?: QueueActionPaletteSurfaceV1;
  readonly exportPdf?: ActionPaletteExportRunnerV1;
  readonly exportDocx?: ActionPaletteExportRunnerV1;
  readonly quickAsk?: ActionPaletteExecutorEntryV1["execute"];
}

/** Normal production composition: every advertised capability has a concrete adapter. */
export function createExtensionActionPaletteExecutorsV1(
  deps: ExtensionActionPaletteExecutorDepsV1,
): readonly ActionPaletteExecutorEntryV1[] {
  const surface = (
    actionId: string,
    capability: string,
    effect: ActionEffectV1,
    intentKind: ActionIntentV1["kind"],
    screen: "export" | "research" | "activity" | "settings",
  ): ActionPaletteExecutorEntryV1 => ({
    actionId,
    capability,
    effect,
    intentKind,
    async execute(request) {
      const target = request.intent.kind === "surface.open" && request.intent.target.kind === "sidebar"
        ? request.intent.target
        : { kind: "sidebar" as const, screen };
      await deps.queueSurface?.(target.screen, target.continuationId);
      return { status: "open-surface", target };
    },
  });
  const entries: ActionPaletteExecutorEntryV1[] = [];
  if (deps.exportPdf) entries.push({
    actionId: ACTION_IDS.exportPdfCurrentPage,
    capability: EXTENSION_ACTION_CAPABILITIES_V1.pdf,
    effect: "download",
    intentKind: "export.current-page",
    execute: deps.exportPdf,
  });
  if (deps.exportDocx) entries.push({
    actionId: ACTION_IDS.exportDocxCurrentPage,
    capability: EXTENSION_ACTION_CAPABILITIES_V1.docx,
    effect: "download",
    intentKind: "export.current-page",
    execute: deps.exportDocx,
  });
  if (deps.exportDocx && deps.queueSurface) entries.push(
    surface(ACTION_IDS.configureDocx, EXTENSION_ACTION_CAPABILITIES_V1.docx, "external-navigation", "export.configure-docx", "export"),
  );
  if (deps.queueSurface) entries.push(
    surface(ACTION_IDS.openSidebar, EXTENSION_ACTION_CAPABILITIES_V1.surface, "external-navigation", "surface.open", "export"),
    surface(ACTION_IDS.openPublishing, EXTENSION_ACTION_CAPABILITIES_V1.surface, "external-navigation", "surface.open", "export"),
    surface(ACTION_IDS.openResearch, EXTENSION_ACTION_CAPABILITIES_V1.surface, "external-navigation", "surface.open", "research"),
    surface(ACTION_IDS.openActivity, EXTENSION_ACTION_CAPABILITIES_V1.surface, "external-navigation", "surface.open", "activity"),
  );
  if (deps.quickAsk) entries.push({
    actionId: ACTION_IDS.quickAsk,
    capability: EXTENSION_ACTION_CAPABILITIES_V1.ai,
    effect: "read",
    intentKind: "ai.quick-ask",
    execute: deps.quickAsk,
  });
  return Object.freeze(entries);
}

function error(
  requestId: string,
  code: ActionPaletteErrorCodeV1,
  retryable = false,
): Extract<ActionPaletteResponseV1, { kind: "action-palette:error" }> {
  return { kind: "action-palette:error", requestId, code, retryable };
}

function requestIdOf(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { requestId?: unknown }).requestId === "string") {
    const requestId = (value as { requestId: string }).requestId;
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)) return requestId;
  }
  return "invalid";
}

function validateExecutorEntries(entries: readonly ActionPaletteExecutorEntryV1[]): ReadonlyMap<string, ActionPaletteExecutorEntryV1> {
  const registry = new Map<string, ActionPaletteExecutorEntryV1>();
  for (const entry of entries) {
    if (registry.has(entry.actionId)) throw new Error(`Duplicate action palette executor: ${entry.actionId}`);
    registry.set(entry.actionId, Object.freeze(entry));
  }
  return registry;
}

function intentKind(action: ActionDefinitionV1): string {
  return action.intent.kind;
}

function hasValidInput(
  action: ActionDefinitionV1,
  input: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!action.input) return input === undefined;
  const values = input ?? {};
  const fields = new Map(action.input.fields.map((field) => [field.id, field]));
  if (Object.keys(values).some((id) => !fields.has(id))) return false;
  for (const field of action.input.fields) {
    const value = values[field.id];
    if (value === undefined) {
      if (field.required) return false;
      continue;
    }
    if (field.required && value.trim().length === 0) return false;
    if (field.type === "boolean" && field.required && value !== "true") return false;
    if (field.type === "text") {
      if (value.length < (field.minLength ?? 0) || value.length > field.maxLength) return false;
    } else if (field.type === "select" && !field.options.some((option) => option.id === value)) {
      return false;
    } else if (field.type === "boolean" && value !== "true" && value !== "false") {
      return false;
    }
  }
  return true;
}

export function createActionPaletteBackgroundHostV1(
  deps: ActionPaletteBackgroundDepsV1,
): ActionPaletteBackgroundHostV1 {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const executors = validateExecutorEntries(deps.executors);
  const modules = deps.modules ?? EXTENSION_ACTION_MODULES_V1;
  const allowedContributionIntentKinds = deps.allowedContributionIntentKinds ?? [];
  const capabilities = Object.freeze([...new Set(deps.executors.map((entry) => entry.capability))].sort());
  const leases = new Map<string, CatalogLeaseV1>();
  const executions = new Map<string, AbortController>();

  const cleanLeases = (): void => {
    const at = now();
    for (const [id, lease] of leases) if (lease.expiresAtMs <= at) leases.delete(id);
  };
  const leaseCount = (): number => {
    cleanLeases();
    return leases.size;
  };

  const derive = async (sender: ActionPaletteSenderV1, locale: string) => {
    const tab = await deps.getTab(sender.tabId);
    if (!tab) throw new ActionPaletteContextError("unsupported-context");
    return deriveActionPaletteContextV1({ sender, tab, locale, capabilities });
  };

  const list = async (
    request: Extract<ActionPaletteRequestV1, { kind: "action-palette:catalog" }>,
    sender: ActionPaletteSenderV1,
  ): Promise<ActionPaletteResponseV1> => {
    const derived = await derive(sender, request.locale);
    const catalog = createActionCatalog(modules, derived.context, {
      validationPolicy: { allowedContributionIntentKinds },
    });
    const revision = randomId();
    const expiresAtMs = now() + leaseMs;
    leases.set(revision, { revision, expiresAtMs, binding: derived.binding, locale: request.locale });
    cleanLeases();
    return {
      kind: "action-palette:catalog-result",
      requestId: request.requestId,
      catalog: {
        schemaVersion: 1,
        revision,
        expiresAt: new Date(expiresAtMs).toISOString(),
        context: catalog.context,
        modules: catalog.modules,
      },
    };
  };

  const execute = async (
    request: Extract<ActionPaletteRequestV1, { kind: "action-palette:execute" }>,
    sender: ActionPaletteSenderV1,
  ): Promise<ActionPaletteResponseV1> => {
    cleanLeases();
    const lease = leases.get(request.catalogRevision);
    if (!lease) return error(request.requestId, "catalog-expired", true);
    if (lease.locale !== request.locale) return error(request.requestId, "stale-context", true);
    const derived = await derive(sender, request.locale);
    if (!bindingsEqualV1(lease.binding, derived.binding)) return error(request.requestId, "stale-context", true);
    const catalog = createActionCatalog(modules, derived.context, {
      validationPolicy: { allowedContributionIntentKinds },
    });
    const resolved = catalog.actionsById[request.actionId];
    const executor = executors.get(request.actionId);
    if (!resolved || !executor) return error(request.requestId, "unknown-action");
    if (!resolved.availability.available) return error(request.requestId, "action-unavailable");
    if (!ALLOWED_EFFECTS.has(resolved.action.effect) || executor.effect !== resolved.action.effect) {
      return error(request.requestId, "effect-denied");
    }
    if (executor.intentKind !== intentKind(resolved.action)) return error(request.requestId, "unknown-action");
    if (!hasValidInput(resolved.action, request.input)) return error(request.requestId, "invalid-request");
    if (executions.has(request.requestId)) return error(request.requestId, "invalid-request");
    let executionRequest: ActionExecutionRequestV1;
    try {
      executionRequest = parseActionExecutionRequestV1({
        schemaVersion: 1,
        requestId: request.requestId,
        actionId: request.actionId,
        intent: resolved.action.intent,
        context: derived.context,
        ...(request.input ? { input: request.input } : {}),
      }, { allowedContributionIntentKinds });
    } catch {
      return error(request.requestId, "invalid-request");
    }
    const controller = new AbortController();
    executions.set(request.requestId, controller);
    try {
      const assertContextCurrent = async (): Promise<ActionPaletteContextBindingV1> => {
        const current = await derive(sender, request.locale);
        if (!bindingsEqualV1(lease.binding, current.binding)) {
          throw new ActionPaletteContextError("stale-context");
        }
        return current.binding;
      };
      const result = parseActionResultV1(await executor.execute(
        executionRequest,
        controller.signal,
        assertContextCurrent,
        async (event) => {
          await deps.emitStream?.(sender, {
            kind: "action-palette:stream-event",
            requestId: request.requestId,
            executionId: request.requestId,
            sequence: event.sequence,
            status: event.status,
            ...(event.delta === undefined ? {} : { delta: event.delta }),
          });
        },
      ), {
        allowedContributionIntentKinds,
      });
      return {
        kind: "action-palette:execute-result",
        requestId: request.requestId,
        executionId: request.requestId,
        result,
      };
    } catch (caught) {
      if (caught instanceof ActionPaletteContextError) {
        return error(request.requestId, caught.code, caught.code === "stale-context");
      }
      deps.reportExecutionError?.(caught, {
        requestId: executionRequest.requestId,
        actionId: executionRequest.actionId,
      });
      return error(request.requestId, "execution-failed", true);
    } finally {
      executions.delete(request.requestId);
    }
  };

  return {
    capabilities,
    leaseCount,
    async handle(message, sender) {
      if (!isActionPaletteRequestV1(message)) return actionPaletteInvalidRequest(requestIdOf(message));
      try {
        if (message.kind === "action-palette:catalog") return await list(message, sender);
        if (message.kind === "action-palette:execute") return await execute(message, sender);
        if (message.kind === "action-palette:stream-control") {
          const controller = executions.get(message.executionId);
          if (message.command === "abort") controller?.abort();
          return {
            kind: "action-palette:stream-control-result",
            requestId: message.requestId,
            executionId: message.executionId,
            accepted: controller !== undefined,
          };
        }
        if (message.kind === "action-palette:open-surface-ack") {
          const accepted = await deps.acknowledgeSurface?.(message.navigationId) ?? false;
          return {
            kind: "action-palette:open-surface-ack-result",
            requestId: message.requestId,
            navigationId: message.navigationId,
            accepted,
          };
        }
        if (message.kind === "action-palette:diagnostics") {
          return {
            kind: "action-palette:diagnostics-result",
            requestId: message.requestId,
            shortcut: await deps.shortcutStatus?.() ?? { status: "unbound", value: null },
            catalogLeaseCount: leaseCount(),
          };
        }
        // Toggle is a routing signal only; the top-frame content host decides presentation.
        await derive(sender, "en-US");
        return { kind: "action-palette:toggle-result", requestId: message.requestId, accepted: true };
      } catch (caught) {
        if (caught instanceof ActionPaletteContextError) {
          return error(message.requestId, caught.code, caught.code === "stale-context");
        }
        return error(message.requestId, "execution-failed", true);
      }
    },
  };
}
