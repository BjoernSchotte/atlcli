import { ResearchContractError } from "./contracts.js";
import {
  validateResearchEvidenceSpanV1,
  type ResearchEvidenceSpanV1,
  type ResearchEvidenceStoreV1,
} from "./evidence-store.js";
import type { ResearchWorkspace } from "./workspace.js";

export const RESEARCH_CLAIM_SCHEMA_V1 = "atlcli.research-claim/v1" as const;
export const RESEARCH_CLAIM_LEDGER_SCHEMA_V1 = "atlcli.research-claim-ledger/v1" as const;

const ROOT_PATH = "/.atlcli/claims/v1";
const INDEX_PATH = `${ROOT_PATH}/index.json`;
const MAXIMUM_CLAIMS = 4_096;
const MAXIMUM_SPANS_PER_CLAIM = 24;
const MAXIMUM_STATEMENT_CHARS = 2_000;
const MAXIMUM_INDEX_BYTES = 1_500_000;

export type ResearchClaimClassificationV1 = "fact" | "inference";
export type ResearchClaimFreshnessV1 = "current" | "stale" | "invalidated";

export interface ResearchClaimV1 {
  schema: typeof RESEARCH_CLAIM_SCHEMA_V1;
  id: string;
  classification: ResearchClaimClassificationV1;
  statement: string;
  evidenceIds: string[];
  evidenceSpans: ResearchEvidenceSpanV1[];
  scopeBindingIds: string[];
  freshness: ResearchClaimFreshnessV1;
  createdAt: string;
  freshnessCheckedAt: string;
  invalidatedAt?: string;
  invalidationReason?: "evidence_changed" | "evidence_missing" | "scope_revoked" | "provider_unavailable";
}

interface PersistedLedgerV1 {
  schema: typeof RESEARCH_CLAIM_LEDGER_SCHEMA_V1;
  claims: ResearchClaimV1[];
}

export interface ResearchClaimLedgerV1 {
  put(claim: ResearchClaimV1): Promise<ResearchClaimV1>;
  get(claimId: string): Promise<ResearchClaimV1 | undefined>;
  list(input?: { limit?: number; cursor?: string; freshness?: ResearchClaimFreshnessV1 }): Promise<{ claims: ResearchClaimV1[]; nextCursor?: string }>;
  /**
   * Revalidates the exact spans and marks claims stale or invalidated without
   * trusting any model-provided freshness status.
   */
  refresh(claimId: string, checkedAt: string): Promise<ResearchClaimV1 | undefined>;
  invalidateByEvidenceIds(input: {
    evidenceIds: readonly string[];
    at: string;
    reason: NonNullable<ResearchClaimV1["invalidationReason"]>;
  }): Promise<ResearchClaimV1[]>;
  clear(): Promise<void>;
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
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maximum || value.includes("\u0000")) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const result = boundedText(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) invalid(`${label} is invalid.`);
  return result;
}

function claimId(value: unknown): string {
  const result = boundedText(value, "Claim ID", 96);
  if (!/^claim:[a-f0-9]{48}$/.test(result)) invalid("Claim ID is invalid.");
  return result;
}

function evidenceId(value: unknown): string {
  const result = boundedText(value, "Evidence ID", 96);
  if (!/^evidence:[a-f0-9]{48}$/.test(result)) invalid("Evidence ID is invalid.");
  return result;
}

function distinctStrings(value: unknown, label: string, maximum: number, pattern: (entry: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) invalid(`${label} is invalid.`);
  const result = value.map(pattern);
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicates.`);
  return result;
}

function normalizeSpans(value: unknown): ResearchEvidenceSpanV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_SPANS_PER_CLAIM) {
    invalid("Claim evidence spans are invalid.");
  }
  const spans = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") invalid("Claim evidence span is invalid.");
    const span = candidate as Partial<ResearchEvidenceSpanV1>;
    if (typeof span.chunkId !== "string" || typeof span.textHash !== "string" ||
        !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)) {
      invalid("Claim evidence span is invalid.");
    }
    const start = span.start as number;
    const end = span.end as number;
    return {
      evidenceId: evidenceId(span.evidenceId),
      chunkId: boundedText(span.chunkId, "Claim evidence chunk ID", 128),
      start,
      end,
      textHash: boundedText(span.textHash, "Claim evidence span hash", 64),
    };
  });
  const identities = spans.map((span) => `${span.evidenceId}\u0000${span.chunkId}\u0000${span.start}\u0000${span.end}\u0000${span.textHash}`);
  if (new Set(identities).size !== identities.length) invalid("Claim evidence spans contain duplicates.");
  return spans;
}

function validateClaim(value: ResearchClaimV1): ResearchClaimV1 {
  if (!value || typeof value !== "object" || value.schema !== RESEARCH_CLAIM_SCHEMA_V1) invalid("Claim has an unsupported schema.");
  if (value.classification !== "fact" && value.classification !== "inference") invalid("Claim classification is invalid.");
  if (value.freshness !== "current" && value.freshness !== "stale" && value.freshness !== "invalidated") invalid("Claim freshness is invalid.");
  const spans = normalizeSpans(value.evidenceSpans);
  const evidenceIds = distinctStrings(value.evidenceIds, "Claim evidence IDs", MAXIMUM_SPANS_PER_CLAIM, evidenceId).sort();
  const spanEvidenceIds = [...new Set(spans.map((span) => span.evidenceId))].sort();
  if (JSON.stringify(evidenceIds) !== JSON.stringify(spanEvidenceIds)) invalid("Claim evidence IDs do not match its spans.");
  const scopeBindingIds = distinctStrings(value.scopeBindingIds, "Claim scope binding IDs", 64, (entry) => {
    const id = boundedText(entry, "Claim scope binding ID", 240);
    if (!/^scope-binding:[A-Za-z0-9._:%~-]{1,240}$/.test(id)) invalid("Claim scope binding ID is invalid.");
    return id;
  }).sort();
  if (value.freshness === "invalidated") {
    if (value.invalidatedAt === undefined || value.invalidationReason === undefined) invalid("Invalidated claim metadata is missing.");
  } else if (value.invalidatedAt !== undefined || value.invalidationReason !== undefined) {
    invalid("Current or stale claim has invalidation metadata.");
  }
  if (value.invalidationReason !== undefined && !["evidence_changed", "evidence_missing", "scope_revoked", "provider_unavailable"].includes(value.invalidationReason)) {
    invalid("Claim invalidation reason is invalid.");
  }
  return {
    schema: RESEARCH_CLAIM_SCHEMA_V1,
    id: claimId(value.id),
    classification: value.classification,
    statement: boundedText(value.statement, "Claim statement", MAXIMUM_STATEMENT_CHARS),
    evidenceIds,
    evidenceSpans: spans,
    scopeBindingIds,
    freshness: value.freshness,
    createdAt: iso(value.createdAt, "Claim created time"),
    freshnessCheckedAt: iso(value.freshnessCheckedAt, "Claim freshness check time"),
    ...(value.invalidatedAt === undefined ? {} : { invalidatedAt: iso(value.invalidatedAt, "Claim invalidated time") }),
    ...(value.invalidationReason === undefined ? {} : { invalidationReason: value.invalidationReason }),
  };
}

function parseLedger(contents: string): PersistedLedgerV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    invalid("Claim ledger index is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") invalid("Claim ledger index is invalid.");
  const candidate = parsed as Partial<PersistedLedgerV1>;
  if (candidate.schema !== RESEARCH_CLAIM_LEDGER_SCHEMA_V1 || !Array.isArray(candidate.claims) || candidate.claims.length > MAXIMUM_CLAIMS) {
    invalid("Claim ledger index is invalid.");
  }
  const claims = candidate.claims.map((claim) => validateClaim(claim as ResearchClaimV1));
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) invalid("Claim ledger contains duplicate IDs.");
  return { schema: RESEARCH_CLAIM_LEDGER_SCHEMA_V1, claims: claims.sort((left, right) => left.id.localeCompare(right.id)) };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateCurrentSupport(
  evidenceStore: ResearchEvidenceStoreV1,
  claim: ResearchClaimV1,
): Promise<{ stale: boolean; missing: boolean }> {
  let stale = false;
  let missing = false;
  const bindings = new Set<string>();
  for (const span of claim.evidenceSpans) {
    const record = await evidenceStore.get(span.evidenceId);
    if (!record) {
      missing = true;
      continue;
    }
    bindings.add(record.authority.bindingId);
    const chunks = await evidenceStore.chunks(record.id);
    await validateResearchEvidenceSpanV1(record, chunks, span);
    if (record.version.truncated) stale = true;
  }
  if (!missing && JSON.stringify([...bindings].sort()) !== JSON.stringify([...claim.scopeBindingIds].sort())) {
    invalid("Claim scope bindings do not match its retained evidence.");
  }
  return { stale, missing };
}

/**
 * Builds a claim ID only after its exact host-retained evidence spans verify.
 * A truncated evidence projection can support an explicitly cautious inference,
 * but never a factual claim.
 */
export async function createResearchClaimV1(input: {
  evidenceStore: ResearchEvidenceStoreV1;
  classification: ResearchClaimClassificationV1;
  statement: string;
  evidenceSpans: readonly ResearchEvidenceSpanV1[];
  createdAt: string;
}): Promise<ResearchClaimV1> {
  if (input.classification !== "fact" && input.classification !== "inference") invalid("Claim classification is invalid.");
  const statement = boundedText(input.statement, "Claim statement", MAXIMUM_STATEMENT_CHARS);
  const createdAt = iso(input.createdAt, "Claim created time");
  const spans = normalizeSpans(input.evidenceSpans).sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId) ||
    left.chunkId.localeCompare(right.chunkId) ||
    left.start - right.start ||
    left.end - right.end ||
    left.textHash.localeCompare(right.textHash)
  );
  const sourceBindings = new Set<string>();
  let truncated = false;
  for (const span of spans) {
    const record = await input.evidenceStore.get(span.evidenceId);
    if (!record) throw new ResearchContractError("invalid-report", "Claim references evidence that is not retained.");
    sourceBindings.add(record.authority.bindingId);
    const chunks = await input.evidenceStore.chunks(record.id);
    await validateResearchEvidenceSpanV1(record, chunks, span);
    truncated ||= record.version.truncated;
  }
  if (input.classification === "fact" && truncated) {
    throw new ResearchContractError("invalid-report", "A factual claim cannot rely on truncated evidence.");
  }
  const evidenceIds = [...new Set(spans.map((span) => span.evidenceId))].sort();
  const scopeBindingIds = [...sourceBindings].sort();
  const id = `claim:${(await sha256(JSON.stringify({ classification: input.classification, statement, spans, evidenceIds, scopeBindingIds }))).slice(0, 48)}`;
  return validateClaim({
    schema: RESEARCH_CLAIM_SCHEMA_V1,
    id,
    classification: input.classification,
    statement,
    evidenceIds,
    evidenceSpans: spans,
    scopeBindingIds,
    freshness: truncated ? "stale" : "current",
    createdAt,
    freshnessCheckedAt: createdAt,
  });
}

/** Private immutable-claim ledger backed by the portable session workspace. */
export class WorkspaceResearchClaimLedgerV1 implements ResearchClaimLedgerV1 {
  readonly #workspace: ResearchWorkspace;
  readonly #evidenceStore: ResearchEvidenceStoreV1;
  #ledger: PersistedLedgerV1 = { schema: RESEARCH_CLAIM_LEDGER_SCHEMA_V1, claims: [] };
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();
  #writeFailure: unknown;

  constructor(workspace: ResearchWorkspace, evidenceStore: ResearchEvidenceStoreV1) {
    this.#workspace = workspace;
    this.#evidenceStore = evidenceStore;
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
    this.#ledger = contents === undefined
      ? { schema: RESEARCH_CLAIM_LEDGER_SCHEMA_V1, claims: [] }
      : parseLedger(contents);
    this.#loaded = true;
  }

  async #persist(): Promise<void> {
    const contents = JSON.stringify(this.#ledger);
    if (textBytes(contents) > MAXIMUM_INDEX_BYTES) {
      throw new ResearchContractError("limit-exceeded", "Claim ledger index is too large.");
    }
    await this.#workspace.writeFile(INDEX_PATH, contents);
  }

  async put(claim: ResearchClaimV1): Promise<ResearchClaimV1> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validated = validateClaim(claim);
      const existing = this.#ledger.claims.find((candidate) => candidate.id === validated.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(validated)) invalid("Claim ID collides with a different claim.");
        return clone(existing);
      }
      if (this.#ledger.claims.length >= MAXIMUM_CLAIMS) {
        throw new ResearchContractError("limit-exceeded", "Claim ledger limit is exhausted.");
      }
      const support = await validateCurrentSupport(this.#evidenceStore, validated);
      if (support.missing) invalid("Claim references evidence that is not retained.");
      if (validated.classification === "fact" && support.stale) {
        invalid("A factual claim cannot rely on truncated evidence.");
      }
      const expectedFreshness: ResearchClaimFreshnessV1 = support.stale ? "stale" : "current";
      if (validated.freshness !== expectedFreshness) {
        invalid("Claim freshness must be derived from its retained evidence.");
      }
      try {
        this.#ledger = {
          schema: RESEARCH_CLAIM_LEDGER_SCHEMA_V1,
          claims: [...this.#ledger.claims, validated].sort((left, right) => left.id.localeCompare(right.id)),
        };
        await this.#persist();
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
      return clone(validated);
    });
  }

  async get(id: string): Promise<ResearchClaimV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validatedId = claimId(id);
      const found = this.#ledger.claims.find((claim) => claim.id === validatedId);
      return found ? clone(found) : undefined;
    });
  }

  async list(input: { limit?: number; cursor?: string; freshness?: ResearchClaimFreshnessV1 } = {}): Promise<{ claims: ResearchClaimV1[]; nextCursor?: string }> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      if (input.freshness !== undefined && input.freshness !== "current" && input.freshness !== "stale" && input.freshness !== "invalidated") {
        invalid("Claim list freshness filter is invalid.");
      }
      const limit = typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 500
        ? input.limit
        : input.limit === undefined ? 100 : invalid("Claim list limit is invalid.");
      const filtered = this.#ledger.claims.filter((claim) => input.freshness === undefined || claim.freshness === input.freshness);
      const cursor = input.cursor === undefined ? undefined : claimId(input.cursor);
      const start = cursor === undefined ? 0 : filtered.findIndex((claim) => claim.id === cursor) + 1;
      if (cursor !== undefined && start === 0) invalid("Claim list cursor is invalid.");
      const claims = filtered.slice(start, start + limit).map(clone);
      return { claims, ...(start + limit < filtered.length ? { nextCursor: claims.at(-1)!.id } : {}) };
    });
  }

  async refresh(id: string, checkedAt: string): Promise<ResearchClaimV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validatedId = claimId(id);
      const current = this.#ledger.claims.find((claim) => claim.id === validatedId);
      if (!current || current.freshness === "invalidated") return current ? clone(current) : undefined;
      const at = iso(checkedAt, "Claim freshness check time");
      let next: ResearchClaimV1;
      try {
        const support = await validateCurrentSupport(this.#evidenceStore, current);
        if (support.missing) {
          next = { ...current, freshness: "invalidated", freshnessCheckedAt: at, invalidatedAt: at, invalidationReason: "evidence_missing" };
        } else if (support.stale) {
          next = { ...current, freshness: "stale", freshnessCheckedAt: at };
        } else {
          next = { ...current, freshness: "current", freshnessCheckedAt: at };
        }
      } catch (error) {
        if (error instanceof ResearchContractError && error.code === "invalid-request") {
          next = { ...current, freshness: "invalidated", freshnessCheckedAt: at, invalidatedAt: at, invalidationReason: "evidence_changed" };
        } else {
          throw error;
        }
      }
      try {
        this.#ledger = {
          schema: RESEARCH_CLAIM_LEDGER_SCHEMA_V1,
          claims: this.#ledger.claims.map((claim) => claim.id === current.id ? validateClaim(next) : claim),
        };
        await this.#persist();
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
      return clone(next);
    });
  }

  async invalidateByEvidenceIds(input: {
    evidenceIds: readonly string[];
    at: string;
    reason: NonNullable<ResearchClaimV1["invalidationReason"]>;
  }): Promise<ResearchClaimV1[]> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const invalidatedIds = new Set(input.evidenceIds.map(evidenceId));
      const at = iso(input.at, "Claim invalidated time");
      if (!["evidence_changed", "evidence_missing", "scope_revoked", "provider_unavailable"].includes(input.reason)) {
        invalid("Claim invalidation reason is invalid.");
      }
      const changed: ResearchClaimV1[] = [];
      const claims = this.#ledger.claims.map((claim) => {
        if (claim.freshness === "invalidated" || !claim.evidenceIds.some((id) => invalidatedIds.has(id))) return claim;
        const next = validateClaim({ ...claim, freshness: "invalidated", freshnessCheckedAt: at, invalidatedAt: at, invalidationReason: input.reason });
        changed.push(next);
        return next;
      });
      if (changed.length === 0) return [];
      try {
        this.#ledger = { schema: RESEARCH_CLAIM_LEDGER_SCHEMA_V1, claims };
        await this.#persist();
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
      return clone(changed);
    });
  }

  async clear(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      try {
        await this.#workspace.remove(ROOT_PATH);
        this.#ledger = { schema: RESEARCH_CLAIM_LEDGER_SCHEMA_V1, claims: [] };
        this.#loaded = true;
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
    });
  }
}
