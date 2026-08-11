import type {
  ActionInputValuesV1,
  ActionModuleV1,
  ActionResultV1,
  ActionSurfaceContextV1,
} from "@atlcli/action-registry";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACTION_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const MAX_INPUT_FIELDS = 12;
const MAX_INPUT_VALUE = 10_000;

export type ActionPaletteControlCommandV1 = "abort" | "detach";

export type ActionPaletteRequestV1 =
  | { readonly kind: "action-palette:toggle"; readonly requestId: string }
  | {
      readonly kind: "action-palette:catalog";
      readonly requestId: string;
      readonly locale: string;
    }
  | {
      readonly kind: "action-palette:execute";
      readonly requestId: string;
      readonly catalogRevision: string;
      readonly actionId: string;
      readonly locale: string;
      readonly input?: ActionInputValuesV1;
    }
  | {
      readonly kind: "action-palette:stream-control";
      readonly requestId: string;
      readonly executionId: string;
      readonly command: ActionPaletteControlCommandV1;
    }
  | {
      readonly kind: "action-palette:open-surface-ack";
      readonly requestId: string;
      readonly navigationId: string;
    }
  | { readonly kind: "action-palette:diagnostics"; readonly requestId: string };

export interface ActionPaletteCatalogProjectionV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly expiresAt: string;
  readonly context: ActionSurfaceContextV1;
  readonly modules: readonly ActionModuleV1[];
}

export type ActionPaletteResponseV1 =
  | {
      readonly kind: "action-palette:toggle-result";
      readonly requestId: string;
      readonly accepted: true;
    }
  | {
      readonly kind: "action-palette:catalog-result";
      readonly requestId: string;
      readonly catalog: ActionPaletteCatalogProjectionV1;
    }
  | {
      readonly kind: "action-palette:execute-result";
      readonly requestId: string;
      readonly executionId: string;
      readonly result: ActionResultV1;
    }
  | {
      readonly kind: "action-palette:stream-control-result";
      readonly requestId: string;
      readonly executionId: string;
      readonly accepted: boolean;
    }
  | {
      readonly kind: "action-palette:stream-event";
      readonly requestId: string;
      readonly executionId: string;
      readonly sequence: number;
      readonly status: "started" | "delta" | "reset" | "completed";
      readonly delta?: string;
    }
  | {
      readonly kind: "action-palette:open-surface-request";
      readonly requestId: string;
      readonly navigationId: string;
      readonly screen: "export" | "research" | "activity" | "settings";
      readonly continuationId?: string;
      readonly createdAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "action-palette:open-surface-ack-result";
      readonly requestId: string;
      readonly navigationId: string;
      readonly accepted: boolean;
    }
  | {
      readonly kind: "action-palette:diagnostics-result";
      readonly requestId: string;
      readonly shortcut: { readonly status: "assigned" | "unbound"; readonly value: string | null };
      readonly catalogLeaseCount: number;
    }
  | {
      readonly kind: "action-palette:error";
      readonly requestId: string;
      readonly code: ActionPaletteErrorCodeV1;
      readonly retryable: boolean;
    };

export type ActionPaletteMessageV1 = ActionPaletteRequestV1 | ActionPaletteResponseV1;

export type ActionPaletteErrorCodeV1 =
  | "invalid-request"
  | "unsupported-context"
  | "stale-context"
  | "catalog-expired"
  | "unknown-action"
  | "action-unavailable"
  | "effect-denied"
  | "execution-failed";

const REQUEST_KINDS = new Set<ActionPaletteRequestV1["kind"]>([
  "action-palette:toggle",
  "action-palette:catalog",
  "action-palette:execute",
  "action-palette:stream-control",
  "action-palette:open-surface-ack",
  "action-palette:diagnostics",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function validInput(value: unknown): value is ActionInputValuesV1 {
  if (!isRecord(value) || Object.keys(value).length > MAX_INPUT_FIELDS) return false;
  return Object.entries(value).every(([key, item]) =>
    /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u.test(key) &&
    typeof item === "string" && item.length <= MAX_INPUT_VALUE,
  );
}

/** Exact, fail-closed validator. Unknown fields are rejected, including authority fields. */
export function isActionPaletteRequestV1(value: unknown): value is ActionPaletteRequestV1 {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "action-palette:toggle" || value.kind === "action-palette:diagnostics") {
    return hasExactKeys(value, ["kind", "requestId"]) && opaque(value.requestId);
  }
  if (value.kind === "action-palette:catalog") {
    return hasExactKeys(value, ["kind", "requestId", "locale"]) &&
      opaque(value.requestId) && typeof value.locale === "string" && LOCALE.test(value.locale);
  }
  if (value.kind === "action-palette:execute") {
    const keys = value.input === undefined
      ? ["kind", "requestId", "catalogRevision", "actionId", "locale"]
      : ["kind", "requestId", "catalogRevision", "actionId", "locale", "input"];
    return hasExactKeys(value, keys) && opaque(value.requestId) &&
      opaque(value.catalogRevision) && typeof value.actionId === "string" && ACTION_ID.test(value.actionId) &&
      typeof value.locale === "string" && LOCALE.test(value.locale) &&
      (value.input === undefined || validInput(value.input));
  }
  if (value.kind === "action-palette:stream-control") {
    return hasExactKeys(value, ["kind", "requestId", "executionId", "command"]) &&
      opaque(value.requestId) && opaque(value.executionId) &&
      (value.command === "abort" || value.command === "detach");
  }
  if (value.kind === "action-palette:open-surface-ack") {
    return hasExactKeys(value, ["kind", "requestId", "navigationId"]) &&
      opaque(value.requestId) && opaque(value.navigationId);
  }
  return false;
}

/** Routes malformed known request variants to the fail-closed validator/error response. */
export function isActionPaletteRequestCandidateV1(value: unknown): boolean {
  return isRecord(value) && typeof value.kind === "string" &&
    REQUEST_KINDS.has(value.kind as ActionPaletteRequestV1["kind"]);
}

export function actionPaletteInvalidRequest(
  requestId: string = "invalid",
): Extract<ActionPaletteResponseV1, { kind: "action-palette:error" }> {
  return { kind: "action-palette:error", requestId, code: "invalid-request", retryable: false };
}

/** Exact validator for ephemeral AI presentation events. */
export function isActionPaletteStreamEventV1(value: unknown): value is Extract<
  ActionPaletteResponseV1,
  { kind: "action-palette:stream-event" }
> {
  if (!isRecord(value) || value.kind !== "action-palette:stream-event") return false;
  const keys = value.delta === undefined
    ? ["kind", "requestId", "executionId", "sequence", "status"]
    : ["kind", "requestId", "executionId", "sequence", "status", "delta"];
  return hasExactKeys(value, keys) && opaque(value.requestId) && opaque(value.executionId) &&
    Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 0 &&
    ["started", "delta", "reset", "completed"].includes(String(value.status)) &&
    (value.delta === undefined || (typeof value.delta === "string" && value.delta.length <= 2_000)) &&
    (value.status === "delta" ? typeof value.delta === "string" && value.delta.length > 0 : value.delta === undefined);
}
