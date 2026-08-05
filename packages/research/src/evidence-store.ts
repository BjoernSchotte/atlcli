import {
  ResearchContractError,
  normalizeResearchScopeV1,
  type ResearchProduct,
  type ResearchScopeBindingV1,
  type ResearchScopeV1,
  type ResearchSourceReferenceV1,
} from "./contracts.js";
import type { BoundedContentProjectionV1 } from "./capability-contracts.js";
import type { ResearchWorkspace } from "./workspace.js";

export const RESEARCH_EVIDENCE_RECORD_SCHEMA_V1 = "atlcli.research-evidence-record/v1" as const;
export const RESEARCH_EVIDENCE_CHUNK_SCHEMA_V1 = "atlcli.research-evidence-chunk/v1" as const;
export const RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1 = "atlcli.research-evidence-store-index/v1" as const;

const ROOT_PATH = "/.atlcli/evidence/v1";
const INDEX_PATH = `${ROOT_PATH}/index.json`;
const MAXIMUM_RECORDS = 4_096;
const MAXIMUM_CHUNKS_PER_RECORD = 128;
const MAXIMUM_CONTENT_CHARS = 1_500_000;
const MAXIMUM_CHUNK_CHARS = 12_000;
const MAXIMUM_LINK_TARGETS = 1_024;
const MAXIMUM_LINK_TARGET_CHARS = 4_096;
const MAXIMUM_INDEX_BYTES = 1_500_000;

export interface ResearchEvidenceIdentityV1 {
  tenantOrigin: string;
  product: ResearchProduct;
  entityKind: "issue" | "page";
  entityId: string;
  /** URL-independent, tenant-bound entity identity. */
  canonicalId: string;
}

export interface ResearchEvidenceAuthorityV1 {
  bindingId: string;
  authorityClass: "whole_scope" | "exact_entity";
}

/**
 * Body-free host provenance for a detail read. This remains distinct from
 * evidence authority: authority answers *why this source may be read*, while
 * retrieval answers *why this particular detail was selected*.
 */
export interface ResearchEvidenceRetrievalV1 {
  sourceId: string;
  reason: "question_relevance_rank" | "exact_anchor";
  rank: number;
}

export interface ResearchEvidenceVersionV1 {
  contentHash: string;
  capturedAt: string;
  updatedAt?: string;
  truncated: boolean;
  inputBytes: number;
}

export interface ResearchEvidenceChunkV1 {
  schema: typeof RESEARCH_EVIDENCE_CHUNK_SCHEMA_V1;
  id: string;
  evidenceId: string;
  ordinal: number;
  /** UTF-16 offsets into the retained projected source text. */
  start: number;
  end: number;
  text: string;
  textHash: string;
}

export interface ResearchEvidenceRecordV1 {
  schema: typeof RESEARCH_EVIDENCE_RECORD_SCHEMA_V1;
  id: string;
  identity: ResearchEvidenceIdentityV1;
  /** Display-only metadata; `identity`, not this URL, is the source key. */
  source: ResearchSourceReferenceV1;
  authority: ResearchEvidenceAuthorityV1;
  /** Optional for records created before ranked acquisition was introduced. */
  retrieval?: ResearchEvidenceRetrievalV1;
  version: ResearchEvidenceVersionV1;
  contentChars: number;
  linkTargets: string[];
  chunkIds: string[];
}

export interface ResearchEvidenceSpanV1 {
  evidenceId: string;
  chunkId: string;
  start: number;
  end: number;
  textHash: string;
}

export interface ResearchEvidenceStoreV1 {
  put(record: ResearchEvidenceRecordV1, chunks: readonly ResearchEvidenceChunkV1[]): Promise<ResearchEvidenceRecordV1>;
  get(evidenceId: string): Promise<ResearchEvidenceRecordV1 | undefined>;
  recordsForCanonicalIdentity(canonicalId: string): Promise<ResearchEvidenceRecordV1[]>;
  list(input?: { limit?: number; cursor?: string }): Promise<{ records: ResearchEvidenceRecordV1[]; nextCursor?: string }>;
  chunks(evidenceId: string): Promise<ResearchEvidenceChunkV1[]>;
  remove(evidenceId: string): Promise<boolean>;
  clear(): Promise<void>;
}

interface PersistedIndexV1 {
  schema: typeof RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1;
  recordIds: string[];
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\u0000")) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const text = boundedText(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) invalid(`${label} is invalid.`);
  return text;
}

function evidenceId(value: unknown): string {
  const id = boundedText(value, "Evidence ID", 96);
  if (!/^evidence:[a-f0-9]{48}$/.test(id)) invalid("Evidence ID is invalid.");
  return id;
}

function chunkId(value: unknown): string {
  const id = boundedText(value, "Evidence chunk ID", 128);
  if (!/^evidence:[a-f0-9]{48}:chunk:\d{3}$/.test(id)) invalid("Evidence chunk ID is invalid.");
  return id;
}

function hash(value: unknown, label: string): string {
  const result = boundedText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(`${label} is invalid.`);
  return result;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} is invalid.`);
  }
  return value as number;
}

function normalizedOrigin(value: unknown, label: string): string {
  let url: URL;
  try {
    url = new URL(boundedText(value, label, 512));
  } catch {
    invalid(`${label} is invalid.`);
  }
  if (url.protocol !== "https:" || url.origin !== value || !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname)) {
    invalid(`${label} is invalid.`);
  }
  return url.origin;
}

function hasExactEntityBinding(
  source: ResearchSourceReferenceV1,
  scope: ResearchScopeV1,
  bindings: readonly ResearchScopeBindingV1[],
): boolean {
  return bindings.some((binding) => {
    if (
      binding.tenantOrigin !== scope.siteOrigin ||
      (binding.authority !== "approved" && binding.authority !== "locked")
    ) {
      return false;
    }
    if (source.product === "jira") {
      return binding.product === "jira" &&
        binding.entityKind === "issue" &&
        binding.key?.toLocaleUpperCase("en-US") === source.issueKey?.toLocaleUpperCase("en-US");
    }
    return binding.product === "confluence" &&
      binding.entityKind === "page" &&
      binding.key === source.contentId;
  });
}

function sourceIdentity(
  source: ResearchSourceReferenceV1,
  scope: ResearchScopeV1,
  bindings: readonly ResearchScopeBindingV1[],
): ResearchEvidenceIdentityV1 {
  if (source.product === "jira") {
    const issueKey = boundedText(source.issueKey, "Jira source issue key", 32);
    const projectKey = boundedText(source.projectKey, "Jira source project key", 32);
    if (!scope.jiraProjectKeys.includes(projectKey) && !hasExactEntityBinding(source, scope, bindings)) {
      throw new ResearchContractError("access-denied", "Jira evidence source is outside the approved research scope.");
    }
    return {
      tenantOrigin: scope.siteOrigin,
      product: "jira",
      entityKind: "issue",
      entityId: issueKey,
      canonicalId: `${scope.siteOrigin}|jira|issue|${encodeURIComponent(issueKey)}`,
    };
  }
  const contentId = boundedText(source.contentId, "Confluence source content ID", 128);
  const spaceKey = boundedText(source.spaceKey, "Confluence source space key", 255);
  if (!scope.confluenceSpaceKeys.includes(spaceKey) && !hasExactEntityBinding(source, scope, bindings)) {
    throw new ResearchContractError("access-denied", "Confluence evidence source is outside the approved research scope.");
  }
  return {
    tenantOrigin: scope.siteOrigin,
    product: "confluence",
    entityKind: "page",
    entityId: contentId,
    canonicalId: `${scope.siteOrigin}|confluence|page|${encodeURIComponent(contentId)}`,
  };
}

function authorityFor(
  source: ResearchSourceReferenceV1,
  scope: ResearchScopeV1,
  bindings: readonly ResearchScopeBindingV1[],
): ResearchEvidenceAuthorityV1 {
  const exact = bindings.find((binding) => {
    if (binding.tenantOrigin !== scope.siteOrigin || (binding.authority !== "approved" && binding.authority !== "locked")) return false;
    if (source.product === "jira") {
      return binding.product === "jira" && binding.entityKind === "issue" &&
        binding.key?.toLocaleUpperCase("en-US") === source.issueKey?.toLocaleUpperCase("en-US");
    }
    return binding.product === "confluence" && binding.entityKind === "page" && binding.key === source.contentId;
  });
  if (exact) return { bindingId: exact.id, authorityClass: "exact_entity" };
  const matching = bindings.find((binding) => {
    if (binding.tenantOrigin !== scope.siteOrigin || (binding.authority !== "approved" && binding.authority !== "locked")) return false;
    if (source.product === "jira") {
      return binding.product === "jira" && binding.entityKind === "project" && binding.key === source.projectKey;
    }
    return binding.product === "confluence" && binding.entityKind === "space" && binding.key === source.spaceKey;
  });
  if (!matching) {
    throw new ResearchContractError("access-denied", "Evidence source has no approved scope binding.");
  }
  return { bindingId: matching.id, authorityClass: "whole_scope" };
}

function splitText(text: string): Array<{ start: number; end: number; text: string }> {
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + MAXIMUM_CHUNK_CHARS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
    if (end <= start) invalid("Evidence source contains an invalid Unicode boundary.");
    chunks.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateSource(source: ResearchSourceReferenceV1, identity: ResearchEvidenceIdentityV1): void {
  if (!source || typeof source !== "object" || source.id.length > 256 || source.title.length > 2_000 || source.url.length > 4_096) {
    invalid("Evidence source metadata is invalid.");
  }
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    invalid("Evidence source display URL is invalid.");
  }
  if (url.origin !== identity.tenantOrigin) invalid("Evidence source display URL is outside its tenant.");
  if (source.product !== identity.product) invalid("Evidence source product does not match its identity.");
  if (identity.product === "jira" && source.issueKey !== identity.entityId) invalid("Evidence issue identity is invalid.");
  if (identity.product === "confluence" && source.contentId !== identity.entityId) invalid("Evidence page identity is invalid.");
}

function validateRetrieval(
  value: unknown,
  sourceId: string,
): ResearchEvidenceRetrievalV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Evidence retrieval provenance is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => !["sourceId", "reason", "rank"].includes(key)) ||
    candidate.sourceId !== sourceId ||
    (candidate.reason !== "question_relevance_rank" && candidate.reason !== "exact_anchor")
  ) {
    invalid("Evidence retrieval provenance is invalid.");
  }
  return {
    sourceId,
    reason: candidate.reason,
    rank: boundedInteger(candidate.rank, "Evidence retrieval rank", 1, 4_096),
  };
}

function validateRecord(value: ResearchEvidenceRecordV1): ResearchEvidenceRecordV1 {
  if (!value || typeof value !== "object" || value.schema !== RESEARCH_EVIDENCE_RECORD_SCHEMA_V1) {
    invalid("Evidence record has an unsupported schema.");
  }
  const id = evidenceId(value.id);
  const identity = value.identity;
  if (!identity || typeof identity !== "object" || (identity.product !== "jira" && identity.product !== "confluence") ||
      (identity.entityKind !== "issue" && identity.entityKind !== "page")) invalid("Evidence identity is invalid.");
  const tenantOrigin = normalizedOrigin(identity.tenantOrigin, "Evidence tenant origin");
  const entityId = boundedText(identity.entityId, "Evidence entity ID", 255);
  const canonicalId = boundedText(identity.canonicalId, "Evidence canonical identity", 1_024);
  const expectedCanonicalId = `${tenantOrigin}|${identity.product}|${identity.entityKind}|${encodeURIComponent(entityId)}`;
  if (canonicalId !== expectedCanonicalId ||
      (identity.product === "jira" && identity.entityKind !== "issue") ||
      (identity.product === "confluence" && identity.entityKind !== "page")) invalid("Evidence canonical identity is invalid.");
  validateSource(value.source, { tenantOrigin, product: identity.product, entityKind: identity.entityKind, entityId, canonicalId });
  if (!value.authority || typeof value.authority !== "object" ||
      (value.authority.authorityClass !== "whole_scope" && value.authority.authorityClass !== "exact_entity") ||
      !/^scope-binding:[A-Za-z0-9._:%-]{1,240}$/.test(value.authority.bindingId)) invalid("Evidence authority is invalid.");
  const retrieval = validateRetrieval(value.retrieval, value.source.id);
  if (!value.version || typeof value.version !== "object" || typeof value.version.truncated !== "boolean") invalid("Evidence version is invalid.");
  const version: ResearchEvidenceVersionV1 = {
    contentHash: hash(value.version.contentHash, "Evidence content hash"),
    capturedAt: iso(value.version.capturedAt, "Evidence captured time"),
    ...(value.version.updatedAt === undefined ? {} : { updatedAt: iso(value.version.updatedAt, "Evidence updated time") }),
    truncated: value.version.truncated,
    inputBytes: boundedInteger(value.version.inputBytes, "Evidence input bytes", 0, MAXIMUM_CONTENT_CHARS * 4),
  };
  const contentChars = boundedInteger(value.contentChars, "Evidence content character count", 0, MAXIMUM_CONTENT_CHARS);
  if (!Array.isArray(value.linkTargets) || value.linkTargets.length > MAXIMUM_LINK_TARGETS ||
      value.linkTargets.some((target) => typeof target !== "string" || target.length > MAXIMUM_LINK_TARGET_CHARS || target.includes("\u0000"))) {
    invalid("Evidence link targets are invalid.");
  }
  if (!Array.isArray(value.chunkIds) || value.chunkIds.length > MAXIMUM_CHUNKS_PER_RECORD ||
      new Set(value.chunkIds).size !== value.chunkIds.length) invalid("Evidence chunk IDs are invalid.");
  const chunkIds = value.chunkIds.map(chunkId);
  return {
    schema: RESEARCH_EVIDENCE_RECORD_SCHEMA_V1,
    id,
    identity: { tenantOrigin, product: identity.product, entityKind: identity.entityKind, entityId, canonicalId },
    source: clone(value.source),
    authority: { bindingId: value.authority.bindingId, authorityClass: value.authority.authorityClass },
    ...(retrieval ? { retrieval } : {}),
    version,
    contentChars,
    linkTargets: [...value.linkTargets],
    chunkIds,
  };
}

function validateChunk(value: ResearchEvidenceChunkV1, record: ResearchEvidenceRecordV1, expectedOrdinal: number): ResearchEvidenceChunkV1 {
  if (!value || typeof value !== "object" || value.schema !== RESEARCH_EVIDENCE_CHUNK_SCHEMA_V1 || value.evidenceId !== record.id) {
    invalid("Evidence chunk has an unsupported schema.");
  }
  const id = chunkId(value.id);
  if (id !== record.chunkIds[expectedOrdinal] || value.ordinal !== expectedOrdinal) invalid("Evidence chunk ordering is invalid.");
  const start = boundedInteger(value.start, "Evidence chunk start", 0, record.contentChars);
  const end = boundedInteger(value.end, "Evidence chunk end", start, record.contentChars);
  const text = boundedText(value.text, "Evidence chunk text", MAXIMUM_CHUNK_CHARS, true);
  if (end - start !== text.length || (text.length === 0 && record.contentChars !== 0)) invalid("Evidence chunk text range is invalid.");
  return { schema: RESEARCH_EVIDENCE_CHUNK_SCHEMA_V1, id, evidenceId: record.id, ordinal: expectedOrdinal, start, end, text, textHash: hash(value.textHash, "Evidence chunk hash") };
}

function validateChunks(record: ResearchEvidenceRecordV1, chunks: readonly ResearchEvidenceChunkV1[]): ResearchEvidenceChunkV1[] {
  if (chunks.length !== record.chunkIds.length) invalid("Evidence record chunk count is invalid.");
  const validated = chunks.map((chunk, ordinal) => validateChunk(chunk, record, ordinal));
  let end = 0;
  for (const chunk of validated) {
    if (chunk.start !== end) invalid("Evidence chunks are not contiguous.");
    end = chunk.end;
  }
  if (end !== record.contentChars) invalid("Evidence chunks do not cover the projected content.");
  return validated;
}

async function validateEvidenceIntegrity(
  record: ResearchEvidenceRecordV1,
  chunks: readonly ResearchEvidenceChunkV1[],
): Promise<ResearchEvidenceChunkV1[]> {
  const validated = validateChunks(record, chunks);
  for (const chunk of validated) {
    if (chunk.textHash !== await sha256(chunk.text)) {
      invalid("Evidence chunk hash does not match its retained text.");
    }
  }
  const text = validated.map((chunk) => chunk.text).join("");
  const contentHash = await sha256(JSON.stringify({
    text,
    linkTargets: record.linkTargets,
    truncated: record.version.truncated,
    inputBytes: record.version.inputBytes,
  }));
  if (contentHash !== record.version.contentHash) {
    invalid("Evidence content hash does not match its retained projection.");
  }
  return validated;
}

function recordPath(id: string): string {
  return `${ROOT_PATH}/records/${id}.json`;
}

function chunkPath(id: string): string {
  return `${ROOT_PATH}/chunks/${id}.json`;
}

function parseIndex(contents: string): PersistedIndexV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    invalid("Evidence store index is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") invalid("Evidence store index is invalid.");
  const candidate = parsed as Partial<PersistedIndexV1>;
  if (candidate.schema !== RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1 || !Array.isArray(candidate.recordIds) ||
      candidate.recordIds.length > MAXIMUM_RECORDS || new Set(candidate.recordIds).size !== candidate.recordIds.length) {
    invalid("Evidence store index is invalid.");
  }
  return { schema: RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1, recordIds: candidate.recordIds.map(evidenceId).sort() };
}

/**
 * Builds immutable, private evidence records from a host-fetched projection.
 * The display URL is validated for tenant consistency but deliberately does not
 * participate in the canonical identity or content-addressed evidence ID.
 */
export async function createResearchEvidenceRecordV1(input: {
  source: ResearchSourceReferenceV1;
  content: BoundedContentProjectionV1;
  scope: ResearchScopeV1;
  scopeBindings: readonly ResearchScopeBindingV1[];
  capturedAt: string;
  retrieval?: ResearchEvidenceRetrievalV1;
}): Promise<{ record: ResearchEvidenceRecordV1; chunks: ResearchEvidenceChunkV1[] }> {
  const scope = normalizeResearchScopeV1(input.scope);
  const identity = sourceIdentity(input.source, scope, input.scopeBindings);
  validateSource(input.source, identity);
  const authority = authorityFor(input.source, scope, input.scopeBindings);
  const retrieval = validateRetrieval(input.retrieval, input.source.id);
  if (!input.content || typeof input.content !== "object" || typeof input.content.truncated !== "boolean") {
    invalid("Evidence content projection is invalid.");
  }
  const text = boundedText(input.content.text, "Evidence content text", MAXIMUM_CONTENT_CHARS, true);
  if (!Array.isArray(input.content.linkTargets) || input.content.linkTargets.length > MAXIMUM_LINK_TARGETS ||
      input.content.linkTargets.some((target) => typeof target !== "string" || target.length > MAXIMUM_LINK_TARGET_CHARS || target.includes("\u0000"))) {
    invalid("Evidence content link targets are invalid.");
  }
  const inputBytes = boundedInteger(input.content.inputBytes, "Evidence content input bytes", 0, MAXIMUM_CONTENT_CHARS * 4);
  const contentHash = await sha256(JSON.stringify({ text, linkTargets: input.content.linkTargets, truncated: input.content.truncated, inputBytes }));
  const sourceVersion = input.source.updatedAt ?? "";
  const id = `evidence:${(await sha256(`${identity.canonicalId}\n${contentHash}\n${sourceVersion}`)).slice(0, 48)}`;
  const parts = splitText(text);
  if (parts.length > MAXIMUM_CHUNKS_PER_RECORD) invalid("Evidence source exceeds its chunk limit.");
  const chunks = await Promise.all(parts.map(async (part, ordinal) => ({
    schema: RESEARCH_EVIDENCE_CHUNK_SCHEMA_V1,
    id: `${id}:chunk:${String(ordinal).padStart(3, "0")}`,
    evidenceId: id,
    ordinal,
    start: part.start,
    end: part.end,
    text: part.text,
    textHash: await sha256(part.text),
  } satisfies ResearchEvidenceChunkV1)));
  const record: ResearchEvidenceRecordV1 = {
    schema: RESEARCH_EVIDENCE_RECORD_SCHEMA_V1,
    id,
    identity,
    source: clone(input.source),
    authority,
    ...(retrieval ? { retrieval } : {}),
    version: {
      contentHash,
      capturedAt: iso(input.capturedAt, "Evidence captured time"),
      ...(input.source.updatedAt ? { updatedAt: iso(input.source.updatedAt, "Evidence source update time") } : {}),
      truncated: input.content.truncated,
      inputBytes,
    },
    contentChars: text.length,
    linkTargets: [...input.content.linkTargets],
    chunkIds: chunks.map((chunk) => chunk.id),
  };
  const validatedRecord = validateRecord(record);
  return { record: validatedRecord, chunks: await validateEvidenceIntegrity(validatedRecord, chunks) };
}

/** Validate a stored span and bind its hash to the exact retained text. */
export async function validateResearchEvidenceSpanV1(
  record: ResearchEvidenceRecordV1,
  chunks: readonly ResearchEvidenceChunkV1[],
  span: ResearchEvidenceSpanV1,
): Promise<ResearchEvidenceSpanV1> {
  const validatedRecord = validateRecord(record);
  const validatedChunks = await validateEvidenceIntegrity(validatedRecord, chunks);
  if (!span || typeof span !== "object" || span.evidenceId !== validatedRecord.id) invalid("Evidence span is invalid.");
  const chunk = validatedChunks.find((candidate) => candidate.id === span.chunkId);
  if (!chunk) invalid("Evidence span references an unknown chunk.");
  const start = boundedInteger(span.start, "Evidence span start", chunk.start, chunk.end);
  const end = boundedInteger(span.end, "Evidence span end", start, chunk.end);
  if (end === start) invalid("Evidence span must not be empty.");
  const textHash = hash(span.textHash, "Evidence span hash");
  if (textHash !== await sha256(chunk.text.slice(start - chunk.start, end - chunk.start))) {
    invalid("Evidence span hash does not match its retained text.");
  }
  return { evidenceId: validatedRecord.id, chunkId: chunk.id, start, end, textHash };
}

/**
 * A host-neutral private evidence store. It writes chunks and the record before
 * publishing the compact index; a fresh store therefore recovers the last
 * complete index after an interrupted publication. Orphaned private chunks are
 * intentionally unreachable and removed by retention/deletion.
 */
export class WorkspaceResearchEvidenceStoreV1 implements ResearchEvidenceStoreV1 {
  readonly #workspace: ResearchWorkspace;
  #index: PersistedIndexV1 = { schema: RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1, recordIds: [] };
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();
  #writeFailure: unknown;

  constructor(workspace: ResearchWorkspace) {
    this.#workspace = workspace;
  }

  async #exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#writeFailure) throw this.#writeFailure;
      return await callback();
    } finally {
      release();
    }
  }

  async #hydrate(): Promise<void> {
    if (this.#loaded) return;
    const contents = await this.#workspace.readFile(INDEX_PATH);
    this.#index = contents === undefined
      ? { schema: RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1, recordIds: [] }
      : parseIndex(contents);
    this.#loaded = true;
  }

  async #persistIndex(): Promise<void> {
    const contents = JSON.stringify(this.#index);
    if (textBytes(contents) > MAXIMUM_INDEX_BYTES) {
      throw new ResearchContractError("limit-exceeded", "Evidence store index is too large.");
    }
    await this.#workspace.writeFile(INDEX_PATH, contents);
  }

  async #readRecord(id: string): Promise<ResearchEvidenceRecordV1 | undefined> {
    const contents = await this.#workspace.readFile(recordPath(id));
    if (contents === undefined) return undefined;
    try {
      return validateRecord(JSON.parse(contents) as ResearchEvidenceRecordV1);
    } catch (error) {
      if (error instanceof ResearchContractError) throw error;
      invalid("Stored evidence record is not JSON.");
    }
  }

  async #readChunks(record: ResearchEvidenceRecordV1): Promise<ResearchEvidenceChunkV1[]> {
    const chunks: ResearchEvidenceChunkV1[] = [];
    for (let ordinal = 0; ordinal < record.chunkIds.length; ordinal += 1) {
      const id = record.chunkIds[ordinal]!;
      const contents = await this.#workspace.readFile(chunkPath(id));
      if (contents === undefined) invalid("Stored evidence chunk is missing.");
      try {
        chunks.push(validateChunk(JSON.parse(contents) as ResearchEvidenceChunkV1, record, ordinal));
      } catch (error) {
        if (error instanceof ResearchContractError) throw error;
        invalid("Stored evidence chunk is not JSON.");
      }
    }
    return validateEvidenceIntegrity(record, chunks);
  }

  async put(record: ResearchEvidenceRecordV1, chunks: readonly ResearchEvidenceChunkV1[]): Promise<ResearchEvidenceRecordV1> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validatedRecord = validateRecord(record);
      const validatedChunks = await validateEvidenceIntegrity(validatedRecord, chunks);
      const existing = await this.#readRecord(validatedRecord.id);
      if (existing) {
        const existingChunks = await this.#readChunks(existing);
        if (existing.identity.canonicalId !== validatedRecord.identity.canonicalId ||
            existing.version.contentHash !== validatedRecord.version.contentHash ||
            JSON.stringify(existingChunks) !== JSON.stringify(validatedChunks)) {
          invalid("Evidence ID collides with a different retained source.");
        }
        return clone(existing);
      }
      if (this.#index.recordIds.length >= MAXIMUM_RECORDS) {
        throw new ResearchContractError("limit-exceeded", "Evidence store record limit is exhausted.");
      }
      try {
        for (const chunk of validatedChunks) {
          await this.#workspace.writeFile(chunkPath(chunk.id), JSON.stringify(chunk));
        }
        await this.#workspace.writeFile(recordPath(validatedRecord.id), JSON.stringify(validatedRecord));
        this.#index = {
          schema: RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1,
          recordIds: [...this.#index.recordIds, validatedRecord.id].sort(),
        };
        await this.#persistIndex();
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
      return clone(validatedRecord);
    });
  }

  async get(id: string): Promise<ResearchEvidenceRecordV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validatedId = evidenceId(id);
      if (!this.#index.recordIds.includes(validatedId)) return undefined;
      const record = await this.#readRecord(validatedId);
      if (!record) invalid("Evidence store index references a missing record.");
      return clone(record);
    });
  }

  async recordsForCanonicalIdentity(canonicalId: string): Promise<ResearchEvidenceRecordV1[]> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const identity = boundedText(canonicalId, "Evidence canonical identity", 1_024);
      const records: ResearchEvidenceRecordV1[] = [];
      for (const id of this.#index.recordIds) {
        const record = await this.#readRecord(id);
        if (!record) invalid("Evidence store index references a missing record.");
        if (record.identity.canonicalId === identity) records.push(clone(record));
      }
      return records.sort((left, right) =>
        (right.version.updatedAt ?? right.version.capturedAt).localeCompare(
          left.version.updatedAt ?? left.version.capturedAt,
        ) || right.id.localeCompare(left.id),
      );
    });
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<{ records: ResearchEvidenceRecordV1[]; nextCursor?: string }> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const limit = boundedInteger(input.limit ?? 100, "Evidence list limit", 1, 500);
      const cursor = input.cursor === undefined ? undefined : evidenceId(input.cursor);
      const start = cursor === undefined ? 0 : this.#index.recordIds.indexOf(cursor) + 1;
      if (cursor !== undefined && start === 0) invalid("Evidence list cursor is invalid.");
      const ids = this.#index.recordIds.slice(start, start + limit);
      const records: ResearchEvidenceRecordV1[] = [];
      for (const id of ids) {
        const record = await this.#readRecord(id);
        if (!record) invalid("Evidence store index references a missing record.");
        records.push(clone(record));
      }
      return {
        records,
        ...(start + limit < this.#index.recordIds.length ? { nextCursor: ids.at(-1)! } : {}),
      };
    });
  }

  async chunks(id: string): Promise<ResearchEvidenceChunkV1[]> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validatedId = evidenceId(id);
      if (!this.#index.recordIds.includes(validatedId)) return [];
      const record = await this.#readRecord(validatedId);
      if (!record) invalid("Evidence store index references a missing record.");
      return clone(await this.#readChunks(record));
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validatedId = evidenceId(id);
      if (!this.#index.recordIds.includes(validatedId)) return false;
      const record = await this.#readRecord(validatedId);
      if (!record) invalid("Evidence store index references a missing record.");
      try {
        this.#index = {
          schema: RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1,
          recordIds: this.#index.recordIds.filter((candidate) => candidate !== validatedId),
        };
        await this.#persistIndex();
        await this.#workspace.remove(recordPath(validatedId));
        for (const chunk of record.chunkIds) await this.#workspace.remove(chunkPath(chunk));
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
      return true;
    });
  }

  async clear(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      try {
        await this.#workspace.remove(ROOT_PATH);
        this.#index = { schema: RESEARCH_EVIDENCE_STORE_INDEX_SCHEMA_V1, recordIds: [] };
        this.#loaded = true;
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
    });
  }
}
