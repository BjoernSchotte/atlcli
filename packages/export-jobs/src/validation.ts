import type {
  DocxExportJobRequestV1,
  ExportJobRequestV1,
  PdfExportJobRequestV1,
} from "./request.js";
import type { ExportJobSnapshotV1 } from "./snapshot.js";
import type { ExportJobEventV1 } from "./event.js";
import type { ExportReportSummaryV1 } from "./statistics.js";
import { InvalidCodeThemeError, resolveCodeThemeId } from "@atlcli/code-highlight/registry";

const MAX_TEXT_LENGTH = 16_384;
const MAX_REF_LENGTH = 4_096;
const MAX_COLLECTION_SIZE = 10_000;
const MAX_PAGES = 1_000_000;
const MAX_FOLDERS = 1_000_000;
const MAX_DEPTH = 10_000;
const MAX_CODE_LENGTH = 256;
const SHA256 = /^[a-f0-9]{64}$/i;

export class ExportJobValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ExportJobValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new ExportJobValidationError(path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain data object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "is not part of this contract shape");
  }
}

function text(value: unknown, path: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  if (value.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
  return value;
}

function optionalText(value: unknown, path: string, maxLength = MAX_TEXT_LENGTH): void {
  if (value !== undefined) text(value, path, maxLength);
}

function choice<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    fail(path, `must be one of ${values.join(", ")}`);
  }
  return value as Values[number];
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
}

function optionalCodeTheme(value: unknown, path: string): void {
  if (value === undefined) return;
  try {
    resolveCodeThemeId(value);
  } catch (error) {
    if (error instanceof InvalidCodeThemeError) fail(path, error.message);
    throw error;
  }
}

function integer(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): number {
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `must be a safe integer between ${min} and ${max}`);
  }
  return value as number;
}

function optionalInteger(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): void {
  if (value !== undefined) integer(value, path, options);
}

function httpOrigin(value: unknown, path: string): string {
  const origin = text(value, path, MAX_REF_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    fail(path, "must be a valid HTTP(S) origin");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/" ||
    parsed.origin !== origin
  ) {
    fail(path, "must be a canonical HTTP(S) origin without credentials, path, query, or hash");
  }
  return origin;
}

function sha256(value: unknown, path: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(path, "must be a 64-character hexadecimal SHA-256 digest");
  }
}

function validateSource(value: unknown, path: string): void {
  const source = record(value, path);
  onlyKeys(
    source,
    [
      "kind",
      "siteOrigin",
      "locator",
      "scope",
      "labels",
      "completenessMode",
      "maxPages",
      "maxFolders",
    ],
    path,
  );
  if (source.kind !== "confluence") fail(`${path}.kind`, "must be confluence");
  httpOrigin(source.siteOrigin, `${path}.siteOrigin`);

  const locator = record(source.locator, `${path}.locator`);
  const locatorKind = choice(
    locator.kind,
    ["page-id", "content-key", "space-key"] as const,
    `${path}.locator.kind`,
  );
  if (locatorKind === "page-id") {
    onlyKeys(locator, ["kind", "id", "version"], `${path}.locator`);
    text(locator.id, `${path}.locator.id`, MAX_REF_LENGTH);
    optionalInteger(locator.version, `${path}.locator.version`, { min: 1 });
  } else if (locatorKind === "content-key") {
    onlyKeys(locator, ["kind", "value"], `${path}.locator`);
    text(locator.value, `${path}.locator.value`, MAX_REF_LENGTH);
  } else {
    onlyKeys(locator, ["kind", "spaceKey"], `${path}.locator`);
    text(locator.spaceKey, `${path}.locator.spaceKey`, MAX_REF_LENGTH);
  }

  const scope = record(source.scope, `${path}.scope`);
  const scopeKind = choice(scope.kind, ["page", "tree", "space"] as const, `${path}.scope.kind`);
  if (scopeKind === "tree") {
    onlyKeys(scope, ["kind", "includeRoot", "maxDepth"], `${path}.scope`);
    if (scope.includeRoot !== undefined) boolean(scope.includeRoot, `${path}.scope.includeRoot`);
    optionalInteger(scope.maxDepth, `${path}.scope.maxDepth`, { max: MAX_DEPTH });
  } else {
    onlyKeys(scope, ["kind"], `${path}.scope`);
  }
  if (scopeKind === "space" && locatorKind !== "space-key") {
    fail(`${path}.scope`, "space scope requires a space-key locator");
  }
  if (scopeKind !== "space" && locatorKind === "space-key") {
    fail(`${path}.scope`, "a space-key locator requires space scope");
  }

  if (source.labels !== undefined) {
    const labels = record(source.labels, `${path}.labels`);
    onlyKeys(labels, ["include", "exclude", "excludeMode"], `${path}.labels`);
    for (const key of ["include", "exclude"] as const) {
      if (labels[key] === undefined) continue;
      if (!Array.isArray(labels[key]) || labels[key].length > MAX_COLLECTION_SIZE) {
        fail(`${path}.labels.${key}`, `must be an array with at most ${MAX_COLLECTION_SIZE} entries`);
      }
      labels[key].forEach((entry, index) => text(entry, `${path}.labels.${key}[${index}]`));
    }
    if (labels.excludeMode !== undefined) {
      choice(
        labels.excludeMode,
        ["prune-subtree", "page-only"] as const,
        `${path}.labels.excludeMode`,
      );
    }
  }

  if (source.completenessMode !== undefined) {
    choice(source.completenessMode, ["strict", "partial"] as const, `${path}.completenessMode`);
  }
  optionalInteger(source.maxPages, `${path}.maxPages`, { min: 1, max: MAX_PAGES });
  optionalInteger(source.maxFolders, `${path}.maxFolders`, { min: 1, max: MAX_FOLDERS });
}

function finiteNumber(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; exclusiveMin?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be finite");
  if (
    (options.min !== undefined &&
      (options.exclusiveMin ? value <= options.min : value < options.min)) ||
    (options.max !== undefined && value > options.max)
  ) {
    fail(path, "is outside the supported range");
  }
  return value;
}

function validateScalarSettings(value: unknown, path: string): void {
  const settings = record(value, path);
  const entries = Object.entries(settings);
  if (entries.length > MAX_COLLECTION_SIZE) {
    fail(path, `must contain at most ${MAX_COLLECTION_SIZE} entries`);
  }
  for (const [key, setting] of entries) {
    text(key, `${path} key`, MAX_REF_LENGTH);
    if (setting === null || typeof setting === "boolean") continue;
    if (typeof setting === "string") {
      if (setting.length > MAX_TEXT_LENGTH) fail(`${path}.${key}`, "string value is too long");
      continue;
    }
    if (typeof setting === "number" && Number.isFinite(setting)) continue;
    fail(`${path}.${key}`, "must be a JSON-safe string, finite number, boolean, or null");
  }
}

function validateSettings(value: unknown, path: string): void {
  const settings = record(value, path);
  onlyKeys(
    settings,
    ["page", "orientation", "cover", "outline", "headerText", "footerText", "accentColor", "organizationName", "watermark", "logo", "custom"],
    path,
  );
  if (settings.page !== undefined) choice(settings.page, ["a4", "letter"] as const, `${path}.page`);
  if (settings.orientation !== undefined) {
    choice(settings.orientation, ["portrait", "landscape"] as const, `${path}.orientation`);
  }
  for (const key of ["cover", "outline"] as const) {
    if (settings[key] !== undefined) boolean(settings[key], `${path}.${key}`);
  }
  for (const key of ["headerText", "footerText", "organizationName"] as const) {
    optionalText(settings[key], `${path}.${key}`);
  }
  if (settings.accentColor !== undefined) {
    const color = text(settings.accentColor, `${path}.accentColor`, 7);
    if (!/^#[a-f0-9]{6}$/i.test(color)) fail(`${path}.accentColor`, "must be #RRGGBB");
  }
  if (settings.watermark !== undefined) {
    const watermark = record(settings.watermark, `${path}.watermark`);
    onlyKeys(watermark, ["text", "color", "opacity", "angle", "size"], `${path}.watermark`);
    text(watermark.text, `${path}.watermark.text`);
    if (watermark.color !== undefined) {
      const color = text(watermark.color, `${path}.watermark.color`, 7);
      if (!/^#[a-f0-9]{6}$/i.test(color)) fail(`${path}.watermark.color`, "must be #RRGGBB");
    }
    if (watermark.opacity !== undefined) {
      finiteNumber(watermark.opacity, `${path}.watermark.opacity`, { min: 0, max: 1, exclusiveMin: true });
    }
    if (watermark.angle !== undefined) {
      finiteNumber(watermark.angle, `${path}.watermark.angle`, { min: -180, max: 180 });
    }
    if (watermark.size !== undefined) {
      finiteNumber(watermark.size, `${path}.watermark.size`, { min: 8, max: 400 });
    }
  }
  if (settings.logo !== undefined) {
    const logo = record(settings.logo, `${path}.logo`);
    onlyKeys(logo, ["assetRef", "sha256", "byteLength", "mediaType", "alt"], `${path}.logo`);
    text(logo.assetRef, `${path}.logo.assetRef`, MAX_REF_LENGTH);
    sha256(logo.sha256, `${path}.logo.sha256`);
    integer(logo.byteLength, `${path}.logo.byteLength`, { min: 1 });
    choice(logo.mediaType, ["image/png", "image/svg+xml"] as const, `${path}.logo.mediaType`);
    text(logo.alt, `${path}.logo.alt`);
  }
  if (settings.custom !== undefined) validateScalarSettings(settings.custom, `${path}.custom`);
}

function validateRequestBaseV1(request: Record<string, unknown>): void {
  if (request.schema !== "atlcli.export-job-request/1") {
    fail("request.schema", "must be atlcli.export-job-request/1");
  }
  text(request.id, "request.id", MAX_REF_LENGTH);
  text(request.idempotencyKey, "request.idempotencyKey", MAX_REF_LENGTH);
  text(request.authRef, "request.authRef", MAX_REF_LENGTH);
  text(request.displayName, "request.displayName");
  optionalText(request.requestedFilename, "request.requestedFilename", MAX_REF_LENGTH);
  integer(request.createdAt, "request.createdAt");
  choice(request.priority, ["interactive", "retry"] as const, "request.priority");
  validateSource(request.source, "request.source");

  const output = record(request.output, "request.output");
  onlyKeys(output, ["policy", "targetRef", "targetKind", "overwriteExisting"], "request.output");
  choice(output.policy, ["collect", "path", "host"] as const, "request.output.policy");
  optionalText(output.targetRef, "request.output.targetRef", MAX_REF_LENGTH);
  if (output.targetKind !== undefined) {
    choice(output.targetKind, ["file", "directory"] as const, "request.output.targetKind");
  }
  if (output.overwriteExisting !== undefined) {
    boolean(output.overwriteExisting, "request.output.overwriteExisting");
  }
}

function validatePdfExportJobRequestV1(request: Record<string, unknown>): void {
  if (request.format !== "pdf") fail("request.format", "must be pdf");
  onlyKeys(
    request,
    [
      "schema", "id", "idempotencyKey", "format", "renderer", "source", "authRef",
      "displayName", "requestedFilename", "createdAt", "priority", "output", "template",
      "options", "settings",
    ],
    "request",
  );
  if (request.renderer !== "pdf-typst") fail("request.renderer", "PDF requires pdf-typst");
  const template = record(request.template, "request.template");
  if (template.kind === undefined) {
    // Historical schema-v1 PDF records predate the explicit discriminant.
    // They remain readable and are normalized by the public parser below.
    onlyKeys(template, ["id", "manifestVersion"], "request.template");
    text(template.id, "request.template.id", MAX_REF_LENGTH);
    text(template.manifestVersion, "request.template.manifestVersion", MAX_REF_LENGTH);
  } else if (template.kind === "builtin") {
    onlyKeys(template, ["kind", "id", "manifestVersion"], "request.template");
    text(template.id, "request.template.id", MAX_REF_LENGTH);
    text(template.manifestVersion, "request.template.manifestVersion", MAX_REF_LENGTH);
  } else if (template.kind === "pack") {
    onlyKeys(template, ["kind", "archiveSha256", "recordKey"], "request.template");
    sha256(template.archiveSha256, "request.template.archiveSha256");
    text(template.recordKey, "request.template.recordKey", MAX_REF_LENGTH);
    if (
      template.recordKey !==
      `template-pack:sha256:${template.archiveSha256}`
    ) {
      fail(
        "request.template.recordKey",
        "must be the content-addressed key for archiveSha256"
      );
    }
  } else {
    fail("request.template.kind", 'must be "builtin" or "pack"');
  }
  validateSettings(request.settings, "request.settings");
  const options = record(request.options, "request.options");
  onlyKeys(
    options,
    ["resolveMacros", "codeTheme", "profile", "strict", "noCache", "exportedAt", "imageProfile", "imagePpi", "outputPolicy"],
    "request.options",
  );
  boolean(options.resolveMacros, "request.options.resolveMacros");
  optionalCodeTheme(options.codeTheme, "request.options.codeTheme");
  optionalText(options.profile, "request.options.profile", MAX_REF_LENGTH);
  if (options.strict !== undefined) boolean(options.strict, "request.options.strict");
  if (options.noCache !== undefined) boolean(options.noCache, "request.options.noCache");
  optionalInteger(options.exportedAt, "request.options.exportedAt");
  if (options.imageProfile !== undefined) {
    if (
      options.imageProfile !== "original" &&
      options.imageProfile !== "standard" &&
      options.imageProfile !== "print"
    ) {
      fail("request.options.imageProfile", "must be original, standard, or print");
    }
  }
  if (options.imagePpi !== undefined) {
    optionalInteger(options.imagePpi, "request.options.imagePpi");
    const ppi = options.imagePpi as number;
    if (ppi < 72 || ppi > 1200) {
      fail("request.options.imagePpi", "must be in [72, 1200]");
    }
    if ((options.imageProfile ?? "original") === "original") {
      fail("request.options.imagePpi", "cannot combine with the original profile");
    }
  }
  if (options.outputPolicy !== undefined) {
    const policy = record(options.outputPolicy, "request.options.outputPolicy");
    onlyKeys(policy, ["schema", "standards"], "request.options.outputPolicy");
    if (policy.schema !== "atlcli.pdf-output-policy/1") {
      fail("request.options.outputPolicy.schema", "must be atlcli.pdf-output-policy/1");
    }
    if (!Array.isArray(policy.standards) || policy.standards.length !== 1) {
      fail("request.options.outputPolicy.standards", "must contain exactly one standard");
    }
    const allowed = [
      "a-1b", "a-1a", "a-2b", "a-2u", "a-2a", "a-3b", "a-3u", "a-3a",
      "a-4", "a-4f", "a-4e", "ua-1",
    ];
    if (!allowed.includes(String(policy.standards[0]))) {
      fail("request.options.outputPolicy.standards[0]", "is unsupported");
    }
  }
}

function validateDocxExportJobRequestV1(request: Record<string, unknown>): void {
  if (request.format !== "docx") fail("request.format", "must be docx");
  onlyKeys(
    request,
    [
      "schema", "id", "idempotencyKey", "format", "renderer", "source", "authRef",
      "displayName", "requestedFilename", "createdAt", "priority", "output", "template",
      "options",
    ],
    "request",
  );
  if (request.renderer !== "docx-typescript") {
    fail("request.renderer", "DOCX requires docx-typescript");
  }
  const template = record(request.template, "request.template");
  onlyKeys(template, ["recordKey", "sha256", "name", "uploadedAt"], "request.template");
  text(template.recordKey, "request.template.recordKey", MAX_REF_LENGTH);
  sha256(template.sha256, "request.template.sha256");
  text(template.name, "request.template.name");
  optionalInteger(template.uploadedAt, "request.template.uploadedAt");
  const options = record(request.options, "request.options");
  onlyKeys(
    options,
    [
      "embedImages",
      "resolveMacros",
      "codeTheme",
      "keepIgnored",
      "strict",
      "updateFields",
      "captionLang",
    ],
    "request.options",
  );
  boolean(options.embedImages, "request.options.embedImages");
  boolean(options.resolveMacros, "request.options.resolveMacros");
  optionalCodeTheme(options.codeTheme, "request.options.codeTheme");
  if (options.keepIgnored !== undefined) {
    boolean(options.keepIgnored, "request.options.keepIgnored");
  }
  if (options.strict !== undefined) boolean(options.strict, "request.options.strict");
  if (options.updateFields !== undefined) {
    choice(options.updateFields, ["auto", "always", "never"] as const, "request.options.updateFields");
  }
  optionalText(options.captionLang, "request.options.captionLang", 256);
}

/** Validate and narrow a PDF request read at a format-specific persistence boundary. */
export function parsePdfExportJobRequestV1(value: unknown): PdfExportJobRequestV1 {
  const request = record(value, "request");
  validateRequestBaseV1(request);
  validatePdfExportJobRequestV1(request);

  const template = request.template as Record<string, unknown>;
  if (template.kind === undefined) {
    return {
      ...(value as Omit<PdfExportJobRequestV1, "template">),
      template: {
        kind: "builtin",
        id: template.id as string,
        manifestVersion: template.manifestVersion as string,
      },
    };
  }
  return value as PdfExportJobRequestV1;
}

/** Validate and narrow a TypeScript-DOCX request at a format-specific persistence boundary. */
export function parseDocxExportJobRequestV1(value: unknown): DocxExportJobRequestV1 {
  const request = record(value, "request");
  validateRequestBaseV1(request);
  validateDocxExportJobRequestV1(request);

  return value as DocxExportJobRequestV1;
}

/** Validate and narrow a value read at a request persistence boundary. */
export function parseExportJobRequestV1(value: unknown): ExportJobRequestV1 {
  const request = record(value, "request");
  validateRequestBaseV1(request);
  const format = choice(request.format, ["docx", "pdf"] as const, "request.format");
  if (format === "pdf") return parsePdfExportJobRequestV1(value);
  validateDocxExportJobRequestV1(request);
  return value as ExportJobRequestV1;
}

const STATES = [
  "queued",
  "running",
  "waiting",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const STAGES = ["discover", "fetch", "compose", "resolve", "assets", "render", "validate", "commit"] as const;
const TERMINAL = new Set<ExportJobSnapshotV1["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

function validateProgress(value: unknown, path: string): void {
  const progress = record(value, path);
  onlyKeys(progress, ["stage", "done", "total", "detail", "updatedAt"], path);
  choice(progress.stage, STAGES, `${path}.stage`);
  const done = integer(progress.done, `${path}.done`);
  if (progress.total !== null) {
    const total = integer(progress.total, `${path}.total`);
    if (done > total) fail(path, "done must not exceed total");
  }
  optionalText(progress.detail, `${path}.detail`);
  integer(progress.updatedAt, `${path}.updatedAt`);
}

function validateArtifact(value: unknown, format: "docx" | "pdf", path: string): void {
  const artifact = record(value, path);
  onlyKeys(artifact, ["ref", "mediaType", "filename", "byteLength", "sha256", "committedAt"], path);
  text(artifact.ref, `${path}.ref`, MAX_REF_LENGTH);
  const expectedMediaType =
    format === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (artifact.mediaType !== expectedMediaType) fail(`${path}.mediaType`, `must be ${expectedMediaType}`);
  text(artifact.filename, `${path}.filename`, MAX_REF_LENGTH);
  integer(artifact.byteLength, `${path}.byteLength`, { min: 1 });
  sha256(artifact.sha256, `${path}.sha256`);
  integer(artifact.committedAt, `${path}.committedAt`);
}

function validateIssueSource(value: unknown, path: string): void {
  const source = record(value, path);
  onlyKeys(source, ["pageId", "pageTitle", "blockId", "assetRef"], path);
  optionalText(source.pageId, `${path}.pageId`, MAX_REF_LENGTH);
  optionalText(source.pageTitle, `${path}.pageTitle`);
  optionalText(source.blockId, `${path}.blockId`, MAX_REF_LENGTH);
  optionalText(source.assetRef, `${path}.assetRef`, MAX_REF_LENGTH);
}

function validateError(value: unknown, path: string): void {
  const error = record(value, path);
  onlyKeys(error, ["code", "message", "category", "retryable", "stage", "source", "occurredAt"], path);
  text(error.code, `${path}.code`, MAX_REF_LENGTH);
  text(error.message, `${path}.message`);
  choice(
    error.category,
    [
      "auth",
      "permission",
      "network",
      "rate-limit",
      "quota",
      "source",
      "template",
      "render",
      "validation",
      "commit",
      "worker",
      "unknown",
    ] as const,
    `${path}.category`,
  );
  boolean(error.retryable, `${path}.retryable`);
  if (error.stage !== undefined) choice(error.stage, STAGES, `${path}.stage`);
  if (error.source !== undefined) validateIssueSource(error.source, `${path}.source`);
  integer(error.occurredAt, `${path}.occurredAt`);
}

function validateStats(value: unknown, path: string): void {
  const stats = record(value, path);
  onlyKeys(
    stats,
    ["pages", "assets", "diagrams", "macros", "retries", "storage", "memory", "metricSupport", "durationsMs", "warnings", "errors"],
    path,
  );
  const groups: Record<string, readonly string[]> = {
    pages: ["discovered", "fetched", "composed", "skipped"],
    assets: [
      "discovered",
      "fetched",
      "embedded",
      "skipped",
      "deduplicated",
      "logicalBytes",
      "physicalBytes",
    ],
    diagrams: ["discovered", "rendered", "rasterized", "failed"],
    macros: ["discovered", "rendered", "approximated", "unresolved"],
    retries: ["total", "rateLimited", "network", "worker"],
    storage: ["spoolBytes", "outputBytes"],
  };
  for (const [groupName, fields] of Object.entries(groups)) {
    const group = record(stats[groupName], `${path}.${groupName}`);
    onlyKeys(group, groupName === "storage" ? [...fields, "spoolPeakBytes"] : fields, `${path}.${groupName}`);
    for (const field of fields) integer(group[field], `${path}.${groupName}.${field}`);
  }
  const storage = record(stats.storage, `${path}.storage`);
  if (storage.spoolPeakBytes !== null) integer(storage.spoolPeakBytes, `${path}.storage.spoolPeakBytes`);
  const memory = record(stats.memory, `${path}.memory`);
  onlyKeys(memory, ["heapPeakBytes", "rendererPeakBytes"], `${path}.memory`);
  for (const field of ["heapPeakBytes", "rendererPeakBytes"] as const) {
    if (memory[field] !== null) integer(memory[field], `${path}.memory.${field}`);
  }
  const support = record(stats.metricSupport, `${path}.metricSupport`);
  for (const [metric, kind] of Object.entries(support)) {
    choice(
      metric,
      ["storage.spoolPeakBytes", "memory.heapPeakBytes", "memory.rendererPeakBytes"] as const,
      `${path}.metricSupport key`,
    );
    choice(kind, ["measured", "derived", "unavailable"] as const, `${path}.metricSupport.${metric}`);
  }
  const measurements = {
    "storage.spoolPeakBytes": storage.spoolPeakBytes,
    "memory.heapPeakBytes": memory.heapPeakBytes,
    "memory.rendererPeakBytes": memory.rendererPeakBytes,
  } as const;
  for (const [metric, measurement] of Object.entries(measurements)) {
    const kind = support[metric];
    // Missing support remains accepted for persisted v1 rows written before
    // telemetry became productive. All newly created rows set it explicitly.
    if (kind === undefined) continue;
    if (kind === "unavailable" && measurement !== null) {
      fail(
        `${path}.metricSupport.${metric}`,
        "unavailable metrics must retain a null measurement",
      );
    }
    if ((kind === "measured" || kind === "derived") && measurement === null) {
      fail(
        `${path}.metricSupport.${metric}`,
        `${kind} metrics require a numeric measurement`,
      );
    }
  }
  const durations = record(stats.durationsMs, `${path}.durationsMs`);
  for (const [stage, duration] of Object.entries(durations)) {
    choice(stage, [...STAGES, "queue"] as const, `${path}.durationsMs key`);
    integer(duration, `${path}.durationsMs.${stage}`);
  }
  integer(stats.warnings, `${path}.warnings`);
  integer(stats.errors, `${path}.errors`);
}

/** Validate and narrow a format-neutral report summary at any persistence boundary. */
export function parseExportReportSummaryV1(
  value: unknown,
  path = "reportSummary",
): ExportReportSummaryV1 {
  const summary = record(value, path);
  onlyKeys(summary, ["issues", "topCodes", "completeness", "failurePhase"], path);
  const issues = record(summary.issues, `${path}.issues`);
  onlyKeys(issues, ["info", "warning", "error"], `${path}.issues`);
  for (const level of ["info", "warning", "error"] as const) {
    integer(issues[level], `${path}.issues.${level}`);
  }
  if (!Array.isArray(summary.topCodes) || summary.topCodes.length > MAX_COLLECTION_SIZE) {
    fail(`${path}.topCodes`, `must be an array with at most ${MAX_COLLECTION_SIZE} entries`);
  }
  summary.topCodes.forEach((item, index) => {
    const code = record(item, `${path}.topCodes[${index}]`);
    onlyKeys(code, ["code", "count"], `${path}.topCodes[${index}]`);
    text(code.code, `${path}.topCodes[${index}].code`, MAX_REF_LENGTH);
    integer(code.count, `${path}.topCodes[${index}].count`);
  });
  choice(summary.completeness, ["complete", "partial", "unknown"] as const, `${path}.completeness`);
  optionalText(summary.failurePhase, `${path}.failurePhase`, MAX_REF_LENGTH);
  return summary as unknown as ExportReportSummaryV1;
}

/** Validate and narrow a value read at a snapshot persistence boundary. */
export function parseExportJobSnapshotV1(value: unknown): ExportJobSnapshotV1 {
  const snapshot = record(value, "snapshot");
  onlyKeys(
    snapshot,
    [
      "schema", "id", "revision", "requestRef", "format", "renderer", "summary", "queue",
      "state", "stage", "progress", "waiting", "attempt", "recoveryCount", "leaseEpoch",
      "lease", "cancelRequestedAt", "checkpointRef", "artifact", "artifactReleasedAt",
      "reportRef", "reportReleasedAt", "reportSummary",
      "stats", "error", "createdAt", "startedAt", "finishedAt", "deliveredAt",
      "acknowledgedAt", "dismissedAt", "derivedFrom",
    ],
    "snapshot",
  );
  if (snapshot.schema !== "atlcli.export-job/1") fail("snapshot.schema", "must be atlcli.export-job/1");
  text(snapshot.id, "snapshot.id", MAX_REF_LENGTH);
  integer(snapshot.revision, "snapshot.revision");
  text(snapshot.requestRef, "snapshot.requestRef", MAX_REF_LENGTH);

  const format = choice(snapshot.format, ["docx", "pdf"] as const, "snapshot.format");
  const expectedRenderer = format === "docx" ? "docx-typescript" : "pdf-typst";
  if (snapshot.renderer !== expectedRenderer) fail("snapshot.renderer", `${format} requires ${expectedRenderer}`);

  const summary = record(snapshot.summary, "snapshot.summary");
  onlyKeys(summary, ["displayName", "sourceLabel", "siteOrigin", "profileLabel", "scopeKind"], "snapshot.summary");
  text(summary.displayName, "snapshot.summary.displayName");
  text(summary.sourceLabel, "snapshot.summary.sourceLabel");
  httpOrigin(summary.siteOrigin, "snapshot.summary.siteOrigin");
  optionalText(summary.profileLabel, "snapshot.summary.profileLabel");
  choice(summary.scopeKind, ["page", "tree", "space"] as const, "snapshot.summary.scopeKind");

  const queue = record(snapshot.queue, "snapshot.queue");
  onlyKeys(queue, ["priority", "enqueuedAt", "groupKey"], "snapshot.queue");
  choice(queue.priority, ["interactive", "retry"] as const, "snapshot.queue.priority");
  integer(queue.enqueuedAt, "snapshot.queue.enqueuedAt");
  text(queue.groupKey, "snapshot.queue.groupKey", MAX_REF_LENGTH);

  const state = choice(snapshot.state, STATES, "snapshot.state");
  if (snapshot.stage !== undefined) choice(snapshot.stage, STAGES, "snapshot.stage");
  if (snapshot.progress !== undefined) {
    validateProgress(snapshot.progress, "snapshot.progress");
    const progress = snapshot.progress as Record<string, unknown>;
    if (snapshot.stage !== undefined && progress.stage !== snapshot.stage) {
      fail("snapshot.progress.stage", "must match snapshot.stage");
    }
  }

  if (state === "waiting") {
    const waiting = record(snapshot.waiting, "snapshot.waiting");
    onlyKeys(waiting, ["reason", "until"], "snapshot.waiting");
    choice(waiting.reason, ["queue", "backoff", "auth", "quota", "host"] as const, "snapshot.waiting.reason");
    optionalInteger(waiting.until, "snapshot.waiting.until");
    if (snapshot.lease !== undefined) fail("snapshot.lease", "waiting jobs must not retain a lease");
    if (snapshot.checkpointRef === undefined) {
      fail("snapshot.checkpointRef", "waiting jobs require a resumable checkpoint ref");
    }
  } else if (snapshot.waiting !== undefined) {
    fail("snapshot.waiting", "is only valid for waiting jobs");
  }

  const attempt = integer(snapshot.attempt, "snapshot.attempt");
  integer(snapshot.recoveryCount, "snapshot.recoveryCount");
  const leaseEpoch = integer(snapshot.leaseEpoch, "snapshot.leaseEpoch");
  if (leaseEpoch !== attempt) fail("snapshot.leaseEpoch", "must equal snapshot.attempt in contract v1");
  if (snapshot.lease !== undefined) {
    const lease = record(snapshot.lease, "snapshot.lease");
    onlyKeys(lease, ["ownerId", "epoch", "acquiredAt", "heartbeatAt", "expiresAt"], "snapshot.lease");
    text(lease.ownerId, "snapshot.lease.ownerId", MAX_REF_LENGTH);
    const epoch = integer(lease.epoch, "snapshot.lease.epoch", { min: 1 });
    if (epoch !== leaseEpoch) fail("snapshot.lease.epoch", "must equal snapshot.leaseEpoch");
    const acquiredAt = integer(lease.acquiredAt, "snapshot.lease.acquiredAt");
    const heartbeatAt = integer(lease.heartbeatAt, "snapshot.lease.heartbeatAt");
    const expiresAt = integer(lease.expiresAt, "snapshot.lease.expiresAt");
    if (acquiredAt > heartbeatAt || heartbeatAt >= expiresAt) {
      fail("snapshot.lease", "must satisfy acquiredAt <= heartbeatAt < expiresAt");
    }
  }
  if (state === "running" && snapshot.lease === undefined) {
    fail("snapshot.lease", "running jobs require an active lease");
  }
  if (state === "cancelling" && snapshot.lease === undefined) {
    fail("snapshot.lease", "cancelling jobs require an active lease until cancellation is reconciled");
  }
  if (snapshot.lease !== undefined && state !== "running" && state !== "cancelling") {
    fail("snapshot.lease", "is only valid for running or cancelling jobs");
  }

  optionalInteger(snapshot.cancelRequestedAt, "snapshot.cancelRequestedAt");
  optionalText(snapshot.checkpointRef, "snapshot.checkpointRef", MAX_REF_LENGTH);
  optionalText(snapshot.reportRef, "snapshot.reportRef", MAX_REF_LENGTH);
  if (snapshot.reportSummary !== undefined) {
    parseExportReportSummaryV1(snapshot.reportSummary, "snapshot.reportSummary");
  }
  validateStats(snapshot.stats, "snapshot.stats");
  if (snapshot.error !== undefined) validateError(snapshot.error, "snapshot.error");

  const createdAt = integer(snapshot.createdAt, "snapshot.createdAt");
  const timestamps: Partial<
    Record<
      | "startedAt"
      | "finishedAt"
      | "deliveredAt"
      | "acknowledgedAt"
      | "dismissedAt"
      | "artifactReleasedAt"
      | "reportReleasedAt",
      number
    >
  > = {};
  for (const field of [
    "startedAt",
    "finishedAt",
    "deliveredAt",
    "acknowledgedAt",
    "dismissedAt",
    "artifactReleasedAt",
    "reportReleasedAt",
  ] as const) {
    if (snapshot[field] !== undefined) {
      timestamps[field] = integer(snapshot[field], `snapshot.${field}`);
    }
    if (timestamps[field] !== undefined && timestamps[field] < createdAt) {
      fail(`snapshot.${field}`, "must not precede createdAt");
    }
  }
  if (
    timestamps.finishedAt !== undefined &&
    timestamps.startedAt !== undefined &&
    timestamps.finishedAt < timestamps.startedAt
  ) {
    fail("snapshot.finishedAt", "must not precede startedAt");
  }
  if (attempt === 0 && timestamps.startedAt !== undefined) {
    fail("snapshot.startedAt", "an unclaimed job must not have startedAt");
  }
  if (attempt > 0 && timestamps.startedAt === undefined) {
    fail("snapshot.startedAt", "a claimed job requires startedAt");
  }

  if (TERMINAL.has(state)) {
    if (timestamps.finishedAt === undefined) fail("snapshot.finishedAt", "terminal jobs require finishedAt");
    if (snapshot.lease !== undefined) fail("snapshot.lease", "terminal jobs must not retain a lease");
  } else if (snapshot.finishedAt !== undefined) {
    fail("snapshot.finishedAt", "non-terminal jobs must not have finishedAt");
  }
  if (state === "succeeded") {
    if (snapshot.artifact === undefined && snapshot.artifactReleasedAt === undefined) {
      fail("snapshot.artifact", "succeeded jobs require an artifact or an artifact release marker");
    }
    if (snapshot.artifact !== undefined) {
      validateArtifact(snapshot.artifact, format, "snapshot.artifact");
      const artifact = snapshot.artifact as Record<string, unknown>;
      if (artifact.committedAt !== timestamps.finishedAt) {
        fail("snapshot.artifact.committedAt", "must equal snapshot.finishedAt");
      }
    }
  } else if (snapshot.artifact !== undefined) {
    fail("snapshot.artifact", "is only valid for succeeded jobs");
  }
  if (snapshot.artifact !== undefined && snapshot.artifactReleasedAt !== undefined) {
    fail("snapshot.artifactReleasedAt", "cannot coexist with a retained artifact");
  }
  if (snapshot.artifactReleasedAt !== undefined && state !== "succeeded") {
    fail("snapshot.artifactReleasedAt", "is only valid for succeeded jobs");
  }
  if (snapshot.reportRef !== undefined && snapshot.reportReleasedAt !== undefined) {
    fail("snapshot.reportReleasedAt", "cannot coexist with a retained report ref");
  }
  if (snapshot.reportReleasedAt !== undefined && !TERMINAL.has(state)) {
    fail("snapshot.reportReleasedAt", "is only valid for terminal jobs");
  }
  if ((state === "failed" || state === "interrupted") && snapshot.error === undefined) {
    fail("snapshot.error", `${state} jobs require an error`);
  }
  if (state === "cancelled" && snapshot.cancelRequestedAt === undefined) {
    fail("snapshot.cancelRequestedAt", "cancelled jobs require cancelRequestedAt");
  }
  if (state === "cancelling" && snapshot.cancelRequestedAt === undefined) {
    fail("snapshot.cancelRequestedAt", "cancelling jobs require cancelRequestedAt");
  }
  if (snapshot.deliveredAt !== undefined && state !== "succeeded") {
    fail("snapshot.deliveredAt", "is only valid for succeeded jobs");
  }
  if ((snapshot.acknowledgedAt !== undefined || snapshot.dismissedAt !== undefined) && !TERMINAL.has(state)) {
    fail("snapshot", "only terminal jobs may be acknowledged or dismissed");
  }
  for (const field of [
    "deliveredAt",
    "acknowledgedAt",
    "dismissedAt",
    "artifactReleasedAt",
    "reportReleasedAt",
  ] as const) {
    if (
      timestamps[field] !== undefined &&
      timestamps.finishedAt !== undefined &&
      timestamps[field] < timestamps.finishedAt
    ) {
      fail(`snapshot.${field}`, "must not precede finishedAt");
    }
  }

  if (snapshot.derivedFrom !== undefined) {
    const derived = record(snapshot.derivedFrom, "snapshot.derivedFrom");
    onlyKeys(derived, ["jobId", "relation", "actionKey"], "snapshot.derivedFrom");
    text(derived.jobId, "snapshot.derivedFrom.jobId", MAX_REF_LENGTH);
    choice(derived.relation, ["retry", "rerun"] as const, "snapshot.derivedFrom.relation");
    text(derived.actionKey, "snapshot.derivedFrom.actionKey", MAX_REF_LENGTH);
  }

  return value as ExportJobSnapshotV1;
}

function validateEventArtifact(value: unknown, path: string): void {
  const artifact = record(value, path);
  const mediaType = choice(
    artifact.mediaType,
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ] as const,
    `${path}.mediaType`,
  );
  validateArtifact(
    value,
    mediaType === "application/pdf" ? "pdf" : "docx",
    path,
  );
}

/** Validate and narrow a value read at an event persistence boundary. */
export function parseExportJobEventV1(value: unknown): ExportJobEventV1 {
  const event = record(value, "event");
  const kind = choice(
    event.kind,
    ["state", "stage", "progress", "retry", "issue", "recovery", "artifact"] as const,
    "event.kind",
  );
  integer(event.seq, "event.seq", { min: 1 });
  const at = integer(event.at, "event.at");

  switch (kind) {
    case "state":
      onlyKeys(event, ["kind", "seq", "at", "from", "to"], "event");
      choice(event.from, STATES, "event.from");
      choice(event.to, STATES, "event.to");
      break;
    case "stage":
      onlyKeys(event, ["kind", "seq", "at", "stage"], "event");
      choice(event.stage, STAGES, "event.stage");
      break;
    case "progress":
      onlyKeys(event, ["kind", "seq", "at", "progress"], "event");
      validateProgress(event.progress, "event.progress");
      break;
    case "retry": {
      onlyKeys(event, ["kind", "seq", "at", "code", "nextAttemptAt"], "event");
      text(event.code, "event.code", MAX_CODE_LENGTH);
      const nextAttemptAt = integer(event.nextAttemptAt, "event.nextAttemptAt");
      if (nextAttemptAt < at) fail("event.nextAttemptAt", "must not precede event.at");
      break;
    }
    case "issue":
      onlyKeys(event, ["kind", "seq", "at", "level", "code", "source"], "event");
      choice(event.level, ["info", "warning", "error"] as const, "event.level");
      text(event.code, "event.code", MAX_CODE_LENGTH);
      if (event.source !== undefined) validateIssueSource(event.source, "event.source");
      break;
    case "recovery":
      onlyKeys(event, ["kind", "seq", "at", "fromCheckpoint", "leaseEpoch"], "event");
      optionalText(event.fromCheckpoint, "event.fromCheckpoint", MAX_REF_LENGTH);
      integer(event.leaseEpoch, "event.leaseEpoch", { min: 1 });
      break;
    case "artifact":
      onlyKeys(event, ["kind", "seq", "at", "artifact"], "event");
      validateEventArtifact(event.artifact, "event.artifact");
      break;
  }

  return value as ExportJobEventV1;
}
