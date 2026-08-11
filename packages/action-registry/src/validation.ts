import {
  ACTION_SCHEMA_VERSION,
  ACTION_UNAVAILABLE_TEXTS,
  type ActionAffordanceV1,
  type ActionAvailabilityV1,
  type ActionDefinitionV1,
  type ActionExecutionRequestV1,
  type ActionInputSchemaV1,
  type ActionInputValuesV1,
  type ActionIntentV1,
  type ActionModuleV1,
  type ActionReceiptV1,
  type ActionRequirementV1,
  type ActionResultV1,
  type ActionSurfaceContextV1,
  type ActionSurfaceTargetV1,
  type ActionTextV1,
  type JsonValue,
  type ResolvedActionDefinitionV1,
} from "./contracts.js";

export interface ActionValidationIssueV1 {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ActionValidationPolicyV1 {
  /** Exact compile-time contribution intent kinds accepted by this host. */
  readonly allowedContributionIntentKinds?: readonly string[];
}

export interface ActionLocaleDictionariesV1 {
  readonly [locale: string]: Readonly<Record<string, string>>;
}

export class ActionContractValidationError extends Error {
  readonly issues: readonly ActionValidationIssueV1[];

  constructor(issues: readonly ActionValidationIssueV1[]) {
    super(
      issues.length === 1
        ? `Invalid action contract: ${issues[0]?.path} ${issues[0]?.message}`
        : `Invalid action contract: ${issues.length} validation issues`,
    );
    this.name = "ActionContractValidationError";
    this.issues = issues;
  }
}

const NAMESPACED_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const FIELD_ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const ORIGIN_RE = /^https:\/\/[^/?#]+$/u;

const BUILT_IN_INTENT_KINDS = new Set([
  "export.current-page",
  "export.configure-docx",
  "surface.open",
  "ai.quick-ask",
]);
const ICON_TOKENS = new Set([
  "activity",
  "document-docx",
  "document-pdf",
  "extension",
  "research",
  "settings",
  "sidebar",
  "sparkles",
]);
const EFFECTS = new Set(["read", "download", "external-navigation", "write"]);
const PRODUCTS = new Set(["confluence", "jira", "atlassian"]);
const SIDEBAR_SCREENS = new Set(["export", "research", "activity", "settings"]);
const RECEIPT_STATUSES = new Set(["queued", "running", "completed", "failed"]);
const HOST_KINDS = new Set(["extension", "forge"]);
const JOB_KINDS = new Set(["pdf", "docx", "research"]);

const MAX_ACTIONS = 1_000;
const MAX_SECONDARY_ACTIONS = 24;
const MAX_KEYWORDS = 32;
const MAX_FIELDS = 12;
const MAX_SELECT_OPTIONS = 100;
const MAX_FALLBACK = 240;
const MAX_KEYWORD = 64;
const MAX_ID = 160;
const MAX_INPUT_VALUE = 10_000;

type MutableRecord = Record<string, unknown>;

function issue(
  issues: ActionValidationIssueV1[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path, code, message });
}

function isRecord(value: unknown): value is MutableRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkObject(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): MutableRecord | undefined {
  if (!isRecord(value)) {
    issue(issues, path, "expected-object", "must be a plain object");
    return undefined;
  }
  return value;
}

function checkExactKeys(
  value: MutableRecord,
  allowed: readonly string[],
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issue(issues, `${path}.${key}`, "unknown-field", "is not allowed");
    }
  }
}

function checkString(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
  options: {
    min?: number;
    max: number;
    pattern?: RegExp;
    code?: string;
  },
): value is string {
  if (typeof value !== "string") {
    issue(issues, path, "expected-string", "must be a string");
    return false;
  }
  const min = options.min ?? 1;
  if (value.length < min || value.length > options.max) {
    issue(
      issues,
      path,
      "string-length",
      `must contain between ${min} and ${options.max} characters`,
    );
    return false;
  }
  if (min > 0 && value.trim().length === 0) {
    issue(issues, path, "blank-string", "must not be blank");
    return false;
  }
  if (options.pattern && !options.pattern.test(value)) {
    issue(issues, path, options.code ?? "invalid-format", "has an invalid format");
    return false;
  }
  return true;
}

function checkNamespacedId(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): value is string {
  return checkString(value, path, issues, {
    max: MAX_ID,
    pattern: NAMESPACED_ID_RE,
    code: "invalid-namespaced-id",
  });
}

function checkInteger(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
  min: number,
  max: number,
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    issue(issues, path, "invalid-integer", `must be an integer from ${min} to ${max}`);
    return false;
  }
  return true;
}

function checkBoolean(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): value is boolean {
  if (typeof value !== "boolean") {
    issue(issues, path, "expected-boolean", "must be a boolean");
    return false;
  }
  return true;
}

function checkSchemaVersion(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  if (value !== ACTION_SCHEMA_VERSION) {
    issue(issues, path, "unsupported-schema-version", "must equal 1");
  }
}

function checkText(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(object, ["key", "fallback"], path, issues);
  checkNamespacedId(object.key, `${path}.key`, issues);
  checkString(object.fallback, `${path}.fallback`, issues, { max: MAX_FALLBACK });
}

function checkRequirement(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  if (object.kind === "capability") {
    checkExactKeys(object, ["kind", "capability"], path, issues);
    checkNamespacedId(object.capability, `${path}.capability`, issues);
    return;
  }
  if (object.kind === "product") {
    checkExactKeys(object, ["kind", "product"], path, issues);
    if (!PRODUCTS.has(String(object.product))) {
      issue(issues, `${path}.product`, "unknown-product", "is not a supported product");
    }
    return;
  }
  if (object.kind === "entity") {
    checkExactKeys(object, ["kind", "entityKind"], path, issues);
    if (object.entityKind !== undefined) {
      checkNamespacedId(object.entityKind, `${path}.entityKind`, issues);
    }
    return;
  }
  issue(issues, `${path}.kind`, "unknown-requirement", "is not a known requirement kind");
}

function checkRequirements(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "expected-array", "must be an array");
    return;
  }
  if (value.length > 64) {
    issue(issues, path, "too-many-requirements", "must contain at most 64 entries");
  }
  value.forEach((entry, index) => checkRequirement(entry, `${path}[${index}]`, issues));
}

function checkSurfaceTarget(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  if (object.kind === "sidebar") {
    checkExactKeys(object, ["kind", "screen", "continuationId"], path, issues);
    if (!SIDEBAR_SCREENS.has(String(object.screen))) {
      issue(issues, `${path}.screen`, "unknown-surface-target", "is not a supported sidebar screen");
    }
    if (object.continuationId !== undefined) {
      checkString(object.continuationId, `${path}.continuationId`, issues, {
        max: 128,
        pattern: OPAQUE_ID_RE,
      });
    }
    return;
  }
  if (object.kind === "forge-modal") {
    checkExactKeys(object, ["kind", "format", "sessionId"], path, issues);
    if (object.format !== "pdf" && object.format !== "docx") {
      issue(issues, `${path}.format`, "unknown-modal-format", "must be pdf or docx");
    }
    if (object.sessionId !== undefined) {
      checkString(object.sessionId, `${path}.sessionId`, issues, {
        max: 128,
        pattern: OPAQUE_ID_RE,
      });
    }
    return;
  }
  issue(issues, `${path}.kind`, "unknown-surface-target", "is not a supported surface target");
}

function checkIntent(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
  allowedContributionKinds: ReadonlySet<string>,
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  const kind = object.kind;
  if (kind === "export.current-page") {
    checkExactKeys(object, ["kind", "format"], path, issues);
    if (object.format !== "pdf" && object.format !== "docx") {
      issue(issues, `${path}.format`, "unknown-export-format", "must be pdf or docx");
    }
    return;
  }
  if (kind === "export.configure-docx" || kind === "ai.quick-ask") {
    checkExactKeys(object, ["kind"], path, issues);
    return;
  }
  if (kind === "surface.open") {
    checkExactKeys(object, ["kind", "target"], path, issues);
    checkSurfaceTarget(object.target, `${path}.target`, issues);
    return;
  }
  if (typeof kind !== "string" || !allowedContributionKinds.has(kind)) {
    issue(issues, `${path}.kind`, "unknown-intent", "is not allowed by this host");
    return;
  }
  if (!kind.startsWith("contribution.")) {
    issue(
      issues,
      `${path}.kind`,
      "invalid-contribution-intent",
      "must use the contribution namespace",
    );
  }
  checkNamespacedId(kind, `${path}.kind`, issues);
  checkExactKeys(object, ["kind", "payload"], path, issues);
}

function checkInputField(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  if (object.type === "text") {
    checkExactKeys(
      object,
      ["type", "id", "label", "placeholder", "required", "multiline", "minLength", "maxLength"],
      path,
      issues,
    );
    checkString(object.id, `${path}.id`, issues, { max: 64, pattern: FIELD_ID_RE });
    checkText(object.label, `${path}.label`, issues);
    if (object.placeholder !== undefined) checkText(object.placeholder, `${path}.placeholder`, issues);
    if (object.required !== undefined) checkBoolean(object.required, `${path}.required`, issues);
    if (object.multiline !== undefined) checkBoolean(object.multiline, `${path}.multiline`, issues);
    if (object.minLength !== undefined) {
      checkInteger(object.minLength, `${path}.minLength`, issues, 0, MAX_INPUT_VALUE);
    }
    if (checkInteger(object.maxLength, `${path}.maxLength`, issues, 1, MAX_INPUT_VALUE)) {
      if (
        typeof object.minLength === "number" &&
        Number.isSafeInteger(object.minLength) &&
        object.minLength > object.maxLength
      ) {
        issue(issues, `${path}.minLength`, "invalid-length-range", "must not exceed maxLength");
      }
    }
    return;
  }
  if (object.type === "select") {
    checkExactKeys(object, ["type", "id", "label", "required", "options"], path, issues);
    checkString(object.id, `${path}.id`, issues, { max: 64, pattern: FIELD_ID_RE });
    checkText(object.label, `${path}.label`, issues);
    if (object.required !== undefined) checkBoolean(object.required, `${path}.required`, issues);
    if (!Array.isArray(object.options)) {
      issue(issues, `${path}.options`, "expected-array", "must be an array");
      return;
    }
    if (object.options.length === 0 || object.options.length > MAX_SELECT_OPTIONS) {
      issue(
        issues,
        `${path}.options`,
        "invalid-option-count",
        `must contain between 1 and ${MAX_SELECT_OPTIONS} options`,
      );
    }
    const optionIds = new Set<string>();
    object.options.forEach((option, index) => {
      const optionPath = `${path}.options[${index}]`;
      const optionObject = checkObject(option, optionPath, issues);
      if (!optionObject) return;
      checkExactKeys(optionObject, ["id", "label"], optionPath, issues);
      if (
        checkString(optionObject.id, `${optionPath}.id`, issues, {
          max: 64,
          pattern: FIELD_ID_RE,
        })
      ) {
        if (optionIds.has(optionObject.id)) {
          issue(issues, `${optionPath}.id`, "duplicate-option-id", "must be unique");
        }
        optionIds.add(optionObject.id);
      }
      checkText(optionObject.label, `${optionPath}.label`, issues);
    });
    return;
  }
  issue(issues, `${path}.type`, "unknown-input-type", "must be text or select");
}

function checkInputSchema(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(object, ["schemaVersion", "fields", "submitLabel"], path, issues);
  checkSchemaVersion(object.schemaVersion, `${path}.schemaVersion`, issues);
  checkText(object.submitLabel, `${path}.submitLabel`, issues);
  if (!Array.isArray(object.fields)) {
    issue(issues, `${path}.fields`, "expected-array", "must be an array");
    return;
  }
  if (object.fields.length === 0 || object.fields.length > MAX_FIELDS) {
    issue(
      issues,
      `${path}.fields`,
      "invalid-field-count",
      `must contain between 1 and ${MAX_FIELDS} fields`,
    );
  }
  const fieldIds = new Set<string>();
  object.fields.forEach((field, index) => {
    checkInputField(field, `${path}.fields[${index}]`, issues);
    if (isRecord(field) && typeof field.id === "string") {
      if (fieldIds.has(field.id)) {
        issue(issues, `${path}.fields[${index}].id`, "duplicate-field-id", "must be unique");
      }
      fieldIds.add(field.id);
    }
  });
}

function checkAvailability(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(object, ["available", "reasons"], path, issues);
  if (!checkBoolean(object.available, `${path}.available`, issues)) return;
  if (!Array.isArray(object.reasons)) {
    issue(issues, `${path}.reasons`, "expected-array", "must be an array");
    return;
  }
  if (object.available && object.reasons.length !== 0) {
    issue(issues, `${path}.reasons`, "available-with-reasons", "must be empty when available");
  }
  if (!object.available && object.reasons.length === 0) {
    issue(issues, `${path}.reasons`, "unavailable-without-reason", "must not be empty");
  }
  object.reasons.forEach((reason, index) => {
    const reasonPath = `${path}.reasons[${index}]`;
    const reasonObject = checkObject(reason, reasonPath, issues);
    if (!reasonObject) return;
    checkExactKeys(reasonObject, ["code", "message", "requirement"], reasonPath, issues);
    if (!new Set([
      "missing-capability",
      "wrong-product",
      "missing-entity",
      "wrong-entity-kind",
    ]).has(String(reasonObject.code))) {
      issue(issues, `${reasonPath}.code`, "unknown-reason-code", "is not supported");
    }
    checkText(reasonObject.message, `${reasonPath}.message`, issues);
    checkRequirement(reasonObject.requirement, `${reasonPath}.requirement`, issues);
  });
}

function checkAffordance(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
  allowedContributionKinds: ReadonlySet<string>,
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(
    object,
    ["schemaVersion", "id", "title", "intent", "requirements", "effect", "availability"],
    path,
    issues,
  );
  checkSchemaVersion(object.schemaVersion, `${path}.schemaVersion`, issues);
  checkNamespacedId(object.id, `${path}.id`, issues);
  checkText(object.title, `${path}.title`, issues);
  checkIntent(object.intent, `${path}.intent`, issues, allowedContributionKinds);
  if (object.requirements !== undefined) {
    checkRequirements(object.requirements, `${path}.requirements`, issues);
  }
  if (!EFFECTS.has(String(object.effect))) {
    issue(issues, `${path}.effect`, "unknown-effect", "is not a supported effect");
  }
  if (object.availability !== undefined) {
    checkAvailability(object.availability, `${path}.availability`, issues);
  }
}

function checkAction(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
  moduleId: string | undefined,
  allowedContributionKinds: ReadonlySet<string>,
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(
    object,
    [
      "schemaVersion",
      "id",
      "moduleId",
      "title",
      "subtitle",
      "keywords",
      "group",
      "icon",
      "intent",
      "secondaryActions",
      "requirements",
      "effect",
      "input",
      "order",
    ],
    path,
    issues,
  );
  checkSchemaVersion(object.schemaVersion, `${path}.schemaVersion`, issues);
  checkNamespacedId(object.id, `${path}.id`, issues);
  if (checkNamespacedId(object.moduleId, `${path}.moduleId`, issues) && moduleId) {
    if (object.moduleId !== moduleId) {
      issue(issues, `${path}.moduleId`, "module-id-mismatch", "must equal the containing module id");
    }
  }
  checkText(object.title, `${path}.title`, issues);
  if (object.subtitle !== undefined) checkText(object.subtitle, `${path}.subtitle`, issues);
  if (object.keywords !== undefined) {
    if (!Array.isArray(object.keywords)) {
      issue(issues, `${path}.keywords`, "expected-array", "must be an array");
    } else {
      if (object.keywords.length > MAX_KEYWORDS) {
        issue(issues, `${path}.keywords`, "too-many-keywords", `must contain at most ${MAX_KEYWORDS}`);
      }
      const normalizedKeywords = new Set<string>();
      object.keywords.forEach((keyword, index) => {
        if (checkString(keyword, `${path}.keywords[${index}]`, issues, { max: MAX_KEYWORD })) {
          const normalized = keyword.normalize("NFKC").toLocaleLowerCase("en-US");
          if (normalizedKeywords.has(normalized)) {
            issue(issues, `${path}.keywords[${index}]`, "duplicate-keyword", "must be unique");
          }
          normalizedKeywords.add(normalized);
        }
      });
    }
  }
  checkNamespacedId(object.group, `${path}.group`, issues);
  if (!ICON_TOKENS.has(String(object.icon))) {
    issue(issues, `${path}.icon`, "unknown-icon", "is not a supported icon token");
  }
  checkIntent(object.intent, `${path}.intent`, issues, allowedContributionKinds);
  if (object.secondaryActions !== undefined) {
    if (!Array.isArray(object.secondaryActions)) {
      issue(issues, `${path}.secondaryActions`, "expected-array", "must be an array");
    } else {
      if (object.secondaryActions.length > MAX_SECONDARY_ACTIONS) {
        issue(
          issues,
          `${path}.secondaryActions`,
          "too-many-secondary-actions",
          `must contain at most ${MAX_SECONDARY_ACTIONS}`,
        );
      }
      const secondaryIds = new Set<string>();
      object.secondaryActions.forEach((action, index) => {
        const secondaryPath = `${path}.secondaryActions[${index}]`;
        checkAffordance(action, secondaryPath, issues, allowedContributionKinds);
        if (isRecord(action) && typeof action.id === "string") {
          if (secondaryIds.has(action.id)) {
            issue(issues, `${secondaryPath}.id`, "duplicate-affordance-id", "must be unique");
          }
          secondaryIds.add(action.id);
        }
      });
    }
  }
  if (object.requirements !== undefined) {
    checkRequirements(object.requirements, `${path}.requirements`, issues);
  }
  if (!EFFECTS.has(String(object.effect))) {
    issue(issues, `${path}.effect`, "unknown-effect", "is not a supported effect");
  }
  if (object.input !== undefined) checkInputSchema(object.input, `${path}.input`, issues);
  if (object.order !== undefined) checkInteger(object.order, `${path}.order`, issues, -100_000, 100_000);
}

function checkModule(
  value: unknown,
  issues: ActionValidationIssueV1[],
  policy: ActionValidationPolicyV1,
): void {
  const object = checkObject(value, "$", issues);
  if (!object) return;
  checkExactKeys(object, ["schemaVersion", "id", "actions"], "$", issues);
  checkSchemaVersion(object.schemaVersion, "$.schemaVersion", issues);
  const moduleId = checkNamespacedId(object.id, "$.id", issues) ? object.id : undefined;
  if (!Array.isArray(object.actions)) {
    issue(issues, "$.actions", "expected-array", "must be an array");
    return;
  }
  if (object.actions.length > MAX_ACTIONS) {
    issue(issues, "$.actions", "too-many-actions", `must contain at most ${MAX_ACTIONS}`);
  }
  const allowedContributionKinds = new Set(policy.allowedContributionIntentKinds ?? []);
  for (const kind of allowedContributionKinds) {
    if (
      BUILT_IN_INTENT_KINDS.has(kind) ||
      !kind.startsWith("contribution.") ||
      !NAMESPACED_ID_RE.test(kind)
    ) {
      issue(
        issues,
        "$.policy.allowedContributionIntentKinds",
        "invalid-contribution-intent",
        `${kind} must be a non-built-in namespaced id`,
      );
    }
  }
  const actionIds = new Set<string>();
  object.actions.forEach((action, index) => {
    const actionPath = `$.actions[${index}]`;
    checkAction(action, actionPath, issues, moduleId, allowedContributionKinds);
    if (isRecord(action) && typeof action.id === "string") {
      if (actionIds.has(action.id)) {
        issue(issues, `${actionPath}.id`, "duplicate-action-id", "must be unique in the module");
      }
      actionIds.add(action.id);
    }
  });
}

function checkEntity(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
  expectedOrigin: string | undefined,
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(object, ["kind", "id", "key", "title", "url"], path, issues);
  checkNamespacedId(object.kind, `${path}.kind`, issues);
  checkString(object.id, `${path}.id`, issues, { max: 256 });
  if (object.key !== undefined) {
    checkString(object.key, `${path}.key`, issues, { max: 128 });
  }
  if (object.title !== undefined) {
    checkString(object.title, `${path}.title`, issues, { max: 500 });
  }
  if (checkString(object.url, `${path}.url`, issues, { max: 2_048 })) {
    try {
      const url = new URL(object.url);
      if (url.protocol !== "https:") {
        issue(issues, `${path}.url`, "insecure-entity-url", "must use HTTPS");
      }
      if (expectedOrigin && url.origin !== expectedOrigin) {
        issue(
          issues,
          `${path}.url`,
          "cross-origin-entity-url",
          "must use the current site origin",
        );
      }
    } catch {
      issue(issues, `${path}.url`, "invalid-entity-url", "must be an absolute URL");
    }
  }
}

function checkContext(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(object, ["siteOrigin", "product", "entity", "locale", "capabilities"], path, issues);
  let siteOrigin: string | undefined;
  if (checkString(object.siteOrigin, `${path}.siteOrigin`, issues, { max: 2_048 })) {
    if (!isValidSiteOriginV1(object.siteOrigin)) {
      issue(
        issues,
        `${path}.siteOrigin`,
        "invalid-site-origin",
        "must be an exact HTTPS origin",
      );
    } else {
      siteOrigin = object.siteOrigin;
    }
  }
  if (!PRODUCTS.has(String(object.product))) {
    issue(issues, `${path}.product`, "unknown-product", "is not a supported product");
  }
  if (object.entity !== undefined) {
    checkEntity(object.entity, `${path}.entity`, issues, siteOrigin);
  }
  checkString(object.locale, `${path}.locale`, issues, {
    max: 64,
    pattern: LOCALE_RE,
    code: "invalid-locale",
  });
  if (!Array.isArray(object.capabilities)) {
    issue(issues, `${path}.capabilities`, "expected-array", "must be an array");
  } else {
    if (object.capabilities.length > 128) {
      issue(issues, `${path}.capabilities`, "too-many-capabilities", "must contain at most 128");
    }
    const capabilities = new Set<string>();
    object.capabilities.forEach((capability, index) => {
      if (checkNamespacedId(capability, `${path}.capabilities[${index}]`, issues)) {
        if (capabilities.has(capability)) {
          issue(
            issues,
            `${path}.capabilities[${index}]`,
            "duplicate-capability",
            "must be unique",
          );
        }
        capabilities.add(capability);
      }
    });
  }
}

function checkExecutionRequest(
  value: unknown,
  issues: ActionValidationIssueV1[],
  policy: ActionValidationPolicyV1,
): void {
  const object = checkObject(value, "$", issues);
  if (!object) return;
  checkExactKeys(
    object,
    ["schemaVersion", "requestId", "actionId", "intent", "context", "input"],
    "$",
    issues,
  );
  checkSchemaVersion(object.schemaVersion, "$.schemaVersion", issues);
  checkString(object.requestId, "$.requestId", issues, { max: 128, pattern: OPAQUE_ID_RE });
  checkNamespacedId(object.actionId, "$.actionId", issues);
  checkIntent(
    object.intent,
    "$.intent",
    issues,
    new Set(policy.allowedContributionIntentKinds ?? []),
  );
  checkContext(object.context, "$.context", issues);
  if (object.input !== undefined) {
    const input = checkObject(object.input, "$.input", issues);
    if (input) {
      for (const [key, inputValue] of Object.entries(input)) {
        checkString(key, `$.input.${key}`, issues, { max: 64, pattern: FIELD_ID_RE });
        checkString(inputValue, `$.input.${key}`, issues, { min: 0, max: MAX_INPUT_VALUE });
      }
    }
  }
}

function cloneJsonValue(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
  ancestors: WeakSet<object>,
): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issue(issues, path, "non-finite-number", "must be finite");
      return undefined;
    }
    return value;
  }
  if (typeof value !== "object") {
    issue(issues, path, "not-json-serializable", `contains unsupported ${typeof value}`);
    return undefined;
  }
  if (ancestors.has(value)) {
    issue(issues, path, "cyclic-value", "must not contain cycles");
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      value.forEach((entry, index) => {
        const cloned = cloneJsonValue(entry, `${path}[${index}]`, issues, ancestors);
        if (cloned !== undefined) output.push(cloned);
      });
      return output;
    }
    if (!isRecord(value)) {
      issue(issues, path, "not-plain-json-object", "must use a plain JSON object");
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      issue(issues, path, "symbol-key", "must not contain symbol keys");
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        issue(issues, `${path}.${key}`, "accessor-property", "must not use accessors");
        continue;
      }
      const cloned = cloneJsonValue(descriptor.value, `${path}.${key}`, issues, ancestors);
      if (cloned !== undefined) output[key] = cloned;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function validateActionModuleV1(
  value: unknown,
  policy: ActionValidationPolicyV1 = {},
): readonly ActionValidationIssueV1[] {
  const issues: ActionValidationIssueV1[] = [];
  const serializable = cloneJsonValue(value, "$", issues, new WeakSet());
  if (serializable !== undefined) checkModule(serializable, issues, policy);
  return deepFreeze(issues);
}

export function parseActionModuleV1(
  value: unknown,
  policy: ActionValidationPolicyV1 = {},
): ActionModuleV1 {
  const issues: ActionValidationIssueV1[] = [];
  const serializable = cloneJsonValue(value, "$", issues, new WeakSet());
  if (serializable !== undefined) checkModule(serializable, issues, policy);
  if (issues.length > 0 || serializable === undefined) {
    throw new ActionContractValidationError(deepFreeze(issues));
  }
  return deepFreeze(serializable as unknown as ActionModuleV1);
}

export function parseActionSurfaceContextV1(value: unknown): ActionSurfaceContextV1 {
  const issues: ActionValidationIssueV1[] = [];
  const serializable = cloneJsonValue(value, "$", issues, new WeakSet());
  if (serializable !== undefined) checkContext(serializable, "$", issues);
  if (issues.length > 0 || serializable === undefined) {
    throw new ActionContractValidationError(deepFreeze(issues));
  }
  return deepFreeze(serializable as unknown as ActionSurfaceContextV1);
}

export function parseActionExecutionRequestV1(
  value: unknown,
  policy: ActionValidationPolicyV1 = {},
): ActionExecutionRequestV1 {
  const issues: ActionValidationIssueV1[] = [];
  const serializable = cloneJsonValue(value, "$", issues, new WeakSet());
  if (serializable !== undefined) checkExecutionRequest(serializable, issues, policy);
  if (issues.length > 0 || serializable === undefined) {
    throw new ActionContractValidationError(deepFreeze(issues));
  }
  return deepFreeze(serializable as unknown as ActionExecutionRequestV1);
}

function unavailable(
  code: "missing-capability" | "wrong-product" | "missing-entity" | "wrong-entity-kind",
  requirement: ActionRequirementV1,
): { code: typeof code; message: ActionTextV1; requirement: ActionRequirementV1 } {
  return {
    code,
    message: ACTION_UNAVAILABLE_TEXTS[code],
    requirement,
  };
}

export function evaluateActionRequirementsV1(
  requirements: readonly ActionRequirementV1[] | undefined,
  context: ActionSurfaceContextV1,
): ActionAvailabilityV1 {
  const reasons: Array<ReturnType<typeof unavailable>> = [];
  const capabilities = new Set(context.capabilities);
  for (const requirement of requirements ?? []) {
    if (requirement.kind === "capability" && !capabilities.has(requirement.capability)) {
      reasons.push(unavailable("missing-capability", requirement));
    } else if (requirement.kind === "product" && context.product !== requirement.product) {
      reasons.push(unavailable("wrong-product", requirement));
    } else if (requirement.kind === "entity" && !context.entity) {
      reasons.push(unavailable("missing-entity", requirement));
    } else if (
      requirement.kind === "entity" &&
      requirement.entityKind !== undefined &&
      context.entity?.kind !== requirement.entityKind
    ) {
      reasons.push(unavailable("wrong-entity-kind", requirement));
    }
  }
  return reasons.length === 0
    ? deepFreeze({ available: true, reasons: [] as const })
    : deepFreeze({ available: false, reasons });
}

export function resolveActionAvailabilityV1(
  action: ActionDefinitionV1,
  context: ActionSurfaceContextV1,
): ResolvedActionDefinitionV1 {
  return deepFreeze({
    action,
    availability: evaluateActionRequirementsV1(action.requirements, context),
  });
}

function collectTextKeysFromText(text: ActionTextV1 | undefined, keys: Set<string>): void {
  if (text) keys.add(text.key);
}

function collectTextKeysFromInput(input: ActionInputSchemaV1 | undefined, keys: Set<string>): void {
  if (!input) return;
  collectTextKeysFromText(input.submitLabel, keys);
  for (const field of input.fields) {
    collectTextKeysFromText(field.label, keys);
    if (field.type === "text") collectTextKeysFromText(field.placeholder, keys);
    if (field.type === "select") {
      for (const option of field.options) collectTextKeysFromText(option.label, keys);
    }
  }
}

function collectTextKeysFromAffordance(affordance: ActionAffordanceV1, keys: Set<string>): void {
  collectTextKeysFromText(affordance.title, keys);
  if (affordance.availability && !affordance.availability.available) {
    for (const reason of affordance.availability.reasons) {
      collectTextKeysFromText(reason.message, keys);
    }
  }
}

export function collectActionTextKeysV1(
  modules: readonly ActionModuleV1[],
): readonly string[] {
  const keys = new Set<string>(
    Object.values(ACTION_UNAVAILABLE_TEXTS).map((text) => text.key),
  );
  for (const module of modules) {
    for (const action of module.actions) {
      collectTextKeysFromText(action.title, keys);
      collectTextKeysFromText(action.subtitle, keys);
      collectTextKeysFromInput(action.input, keys);
      for (const affordance of action.secondaryActions ?? []) {
        collectTextKeysFromAffordance(affordance, keys);
      }
    }
  }
  return deepFreeze([...keys].sort());
}

export function validateActionLocaleKeyParityV1(
  modules: readonly ActionModuleV1[],
  dictionaries: ActionLocaleDictionariesV1,
): readonly ActionValidationIssueV1[] {
  const issues: ActionValidationIssueV1[] = [];
  const requiredKeys = collectActionTextKeysV1(modules);
  const required = new Set(requiredKeys);
  const locales = Object.keys(dictionaries);
  if (locales.length === 0) {
    issue(issues, "$.locales", "missing-locales", "must contain at least one locale");
  }
  for (const locale of locales) {
    if (!LOCALE_RE.test(locale)) {
      issue(issues, `$.locales.${locale}`, "invalid-locale", "has an invalid locale identifier");
    }
    const dictionary = dictionaries[locale];
    if (!dictionary || !isRecord(dictionary)) {
      issue(issues, `$.locales.${locale}`, "expected-object", "must be a dictionary");
      continue;
    }
    for (const key of requiredKeys) {
      if (!(key in dictionary)) {
        issue(issues, `$.locales.${locale}.${key}`, "missing-text-key", "is required");
      } else {
        checkString(dictionary[key], `$.locales.${locale}.${key}`, issues, { max: MAX_FALLBACK });
      }
    }
    for (const key of Object.keys(dictionary)) {
      if (!required.has(key)) {
        issue(issues, `$.locales.${locale}.${key}`, "stale-text-key", "is not used by the modules");
      }
    }
  }
  return deepFreeze(issues);
}

export function validateActionInputValuesV1(
  schema: ActionInputSchemaV1,
  value: unknown,
): readonly ActionValidationIssueV1[] {
  const issues: ActionValidationIssueV1[] = [];
  const object = checkObject(value, "$", issues);
  if (!object) return deepFreeze(issues);
  const fields = new Map(schema.fields.map((field) => [field.id, field]));
  for (const key of Object.keys(object)) {
    if (!fields.has(key)) {
      issue(issues, `$.${key}`, "unknown-input-field", "is not declared by the input schema");
    }
  }
  for (const field of schema.fields) {
    const fieldValue = object[field.id];
    if (fieldValue === undefined || fieldValue === "") {
      if (field.required) issue(issues, `$.${field.id}`, "required-input", "is required");
      continue;
    }
    if (typeof fieldValue !== "string") {
      issue(issues, `$.${field.id}`, "expected-string", "must be a string");
      continue;
    }
    if (field.type === "text") {
      const minLength = field.minLength ?? 0;
      if (fieldValue.length < minLength || fieldValue.length > field.maxLength) {
        issue(
          issues,
          `$.${field.id}`,
          "input-length",
          `must contain between ${minLength} and ${field.maxLength} characters`,
        );
      }
    } else if (!field.options.some((option) => option.id === fieldValue)) {
      issue(issues, `$.${field.id}`, "unknown-select-option", "is not an allowed option");
    }
  }
  return deepFreeze(issues);
}

export function parseActionInputValuesV1(
  schema: ActionInputSchemaV1,
  value: unknown,
): ActionInputValuesV1 {
  const issues = validateActionInputValuesV1(schema, value);
  if (issues.length > 0) throw new ActionContractValidationError(issues);
  const output: Record<string, string> = {};
  for (const field of schema.fields) {
    const fieldValue = (value as Record<string, unknown>)[field.id];
    if (typeof fieldValue === "string") output[field.id] = fieldValue;
  }
  return deepFreeze(output);
}

export function projectActionReceiptV1(
  input: unknown,
): ActionReceiptV1 {
  const issues: ActionValidationIssueV1[] = [];
  const object = checkObject(input, "$", issues);
  if (!object) throw new ActionContractValidationError(deepFreeze(issues));
  const id = object.id;
  const actionId = object.actionId;
  const status = object.status;
  const host = object.host;
  const createdAt = object.createdAt;
  const completedAt = object.completedAt;
  const jobKind = object.jobKind;
  checkString(id, "$.id", issues, { max: 128, pattern: OPAQUE_ID_RE });
  checkNamespacedId(actionId, "$.actionId", issues);
  if (!RECEIPT_STATUSES.has(String(status))) {
    issue(issues, "$.status", "unknown-receipt-status", "is not supported");
  }
  if (!HOST_KINDS.has(String(host))) {
    issue(issues, "$.host", "unknown-host", "is not supported");
  }
  checkString(createdAt, "$.createdAt", issues, { max: 32, pattern: ISO_INSTANT_RE });
  if (completedAt !== undefined) {
    checkString(completedAt, "$.completedAt", issues, { max: 32, pattern: ISO_INSTANT_RE });
  }
  if (jobKind !== undefined && !JOB_KINDS.has(String(jobKind))) {
    issue(issues, "$.jobKind", "unknown-job-kind", "is not supported");
  }
  if (issues.length > 0) throw new ActionContractValidationError(deepFreeze(issues));
  const receipt: {
    schemaVersion: 1;
    id: string;
    actionId: string;
    status: ActionReceiptV1["status"];
    host: ActionReceiptV1["host"];
    createdAt: string;
    completedAt?: string;
    jobKind?: ActionReceiptV1["jobKind"];
  } = {
    schemaVersion: ACTION_SCHEMA_VERSION,
    id: id as string,
    actionId: actionId as string,
    status: status as ActionReceiptV1["status"],
    host: host as ActionReceiptV1["host"],
    createdAt: createdAt as string,
  };
  if (typeof completedAt === "string") receipt.completedAt = completedAt;
  if (jobKind === "pdf" || jobKind === "docx" || jobKind === "research") {
    receipt.jobKind = jobKind;
  }
  return deepFreeze(receipt);
}

function checkReceiptContract(
  value: unknown,
  path: string,
  issues: ActionValidationIssueV1[],
): void {
  const object = checkObject(value, path, issues);
  if (!object) return;
  checkExactKeys(
    object,
    ["schemaVersion", "id", "actionId", "status", "host", "createdAt", "completedAt", "jobKind"],
    path,
    issues,
  );
  checkSchemaVersion(object.schemaVersion, `${path}.schemaVersion`, issues);
  try {
    projectActionReceiptV1(object);
  } catch (error) {
    if (error instanceof ActionContractValidationError) {
      for (const nested of error.issues) {
        issue(issues, `${path}${nested.path.slice(1)}`, nested.code, nested.message);
      }
    } else throw error;
  }
}

function checkResult(
  value: unknown,
  issues: ActionValidationIssueV1[],
  policy: ActionValidationPolicyV1,
): void {
  const object = checkObject(value, "$", issues);
  if (!object) return;
  const allowedContributionKinds = new Set(policy.allowedContributionIntentKinds ?? []);
  if (object.status === "completed") {
    checkExactKeys(object, ["status", "messageKey", "actions"], "$", issues);
    checkNamespacedId(object.messageKey, "$.messageKey", issues);
  } else if (object.status === "queued") {
    checkExactKeys(object, ["status", "receipt", "actions"], "$", issues);
    checkReceiptContract(object.receipt, "$.receipt", issues);
  } else if (object.status === "input-required") {
    checkExactKeys(object, ["status", "input"], "$", issues);
    checkInputSchema(object.input, "$.input", issues);
  } else if (object.status === "open-surface") {
    checkExactKeys(object, ["status", "target"], "$", issues);
    checkSurfaceTarget(object.target, "$.target", issues);
  } else if (object.status === "failed") {
    checkExactKeys(object, ["status", "errorCode", "messageKey", "retryable"], "$", issues);
    checkNamespacedId(object.errorCode, "$.errorCode", issues);
    checkNamespacedId(object.messageKey, "$.messageKey", issues);
    checkBoolean(object.retryable, "$.retryable", issues);
  } else {
    issue(issues, "$.status", "unknown-result-status", "is not supported");
  }
  if (object.actions !== undefined) {
    if (!Array.isArray(object.actions)) {
      issue(issues, "$.actions", "expected-array", "must be an array");
    } else {
      const ids = new Set<string>();
      object.actions.forEach((action, index) => {
        checkAffordance(action, `$.actions[${index}]`, issues, allowedContributionKinds);
        if (isRecord(action) && typeof action.id === "string") {
          if (ids.has(action.id)) {
            issue(issues, `$.actions[${index}].id`, "duplicate-affordance-id", "must be unique");
          }
          ids.add(action.id);
        }
      });
    }
  }
}

export function parseActionResultV1(
  value: unknown,
  policy: ActionValidationPolicyV1 = {},
): ActionResultV1 {
  const issues: ActionValidationIssueV1[] = [];
  const serializable = cloneJsonValue(value, "$", issues, new WeakSet());
  if (serializable !== undefined) checkResult(serializable, issues, policy);
  if (issues.length > 0 || serializable === undefined) {
    throw new ActionContractValidationError(deepFreeze(issues));
  }
  return deepFreeze(serializable as unknown as ActionResultV1);
}

export function isSupportedBuiltInIntentKindV1(kind: string): boolean {
  return BUILT_IN_INTENT_KINDS.has(kind);
}

export function isValidSiteOriginV1(value: string): boolean {
  if (!ORIGIN_RE.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isStructuredCloneSafeV1(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

export function validateActionIntentV1(
  value: unknown,
  policy: ActionValidationPolicyV1 = {},
): readonly ActionValidationIssueV1[] {
  const issues: ActionValidationIssueV1[] = [];
  const serializable = cloneJsonValue(value, "$", issues, new WeakSet());
  if (serializable !== undefined) {
    checkIntent(
      serializable,
      "$",
      issues,
      new Set(policy.allowedContributionIntentKinds ?? []),
    );
  }
  return deepFreeze(issues);
}

export function assertValidActionIntentV1(
  value: unknown,
  policy: ActionValidationPolicyV1 = {},
): ActionIntentV1 {
  const issues = validateActionIntentV1(value, policy);
  if (issues.length > 0) throw new ActionContractValidationError(issues);
  return deepFreeze(structuredClone(value) as ActionIntentV1);
}

export function assertValidSurfaceTargetV1(value: unknown): ActionSurfaceTargetV1 {
  const issues: ActionValidationIssueV1[] = [];
  const serializable = cloneJsonValue(value, "$", issues, new WeakSet());
  if (serializable !== undefined) checkSurfaceTarget(serializable, "$", issues);
  if (issues.length > 0 || serializable === undefined) {
    throw new ActionContractValidationError(deepFreeze(issues));
  }
  return deepFreeze(serializable as unknown as ActionSurfaceTargetV1);
}
