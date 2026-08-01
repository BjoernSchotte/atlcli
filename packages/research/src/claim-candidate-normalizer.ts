import { ResearchContractError } from "./contracts.js";
import type { ResearchDetailEvidenceV1 } from "./broker.js";
import {
  createResearchClaimV1,
  type ResearchClaimClassificationV1,
  type ResearchClaimLedgerV1,
  type ResearchClaimV1,
} from "./claim-ledger.js";
import type {
  ResearchEvidenceSpanV1,
  ResearchEvidenceStoreV1,
} from "./evidence-store.js";

const MAXIMUM_CANDIDATES = 20;
const MAXIMUM_SUPPORTS_PER_CANDIDATE = 12;
const MAXIMUM_QUOTE_CHARS = 640;

/**
 * Ephemeral model output. `quote` is deliberately absent from the normalized
 * packet and from every durable return value: the host resolves it to an exact
 * private evidence span before accepting the candidate.
 */
export interface ResearchEvidenceQuoteCandidateV2 {
  sourceId: string;
  quote: string;
}

export interface ResearchClaimCandidateV2 {
  id: string;
  classification: ResearchClaimClassificationV1;
  summary: string;
  support: ResearchEvidenceQuoteCandidateV2[];
}

export interface NormalizedResearchClaimCandidateV2 {
  candidateId: string;
  claim: ResearchClaimV1;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-report", message);
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\u0000")) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resolveQuoteToSpan(input: {
  candidate: ResearchEvidenceQuoteCandidateV2;
  detailsBySourceId: ReadonlyMap<string, ResearchDetailEvidenceV1>;
  evidenceStore: ResearchEvidenceStoreV1;
}): Promise<ResearchEvidenceSpanV1> {
  const sourceId = bounded(input.candidate.sourceId, "Claim quote source ID", 200);
  const quote = bounded(input.candidate.quote, "Claim quote", MAXIMUM_QUOTE_CHARS);
  const detail = input.detailsBySourceId.get(sourceId);
  if (!detail?.evidenceId) {
    invalid("Claim quote does not reference durably retained detail evidence.");
  }
  const record = await input.evidenceStore.get(detail.evidenceId);
  if (!record || record.source.id !== sourceId) {
    invalid("Claim quote evidence identity is unavailable or mismatched.");
  }
  const versions = await input.evidenceStore.recordsForCanonicalIdentity(record.identity.canonicalId);
  if (versions[0]?.id !== record.id) {
    invalid("Claim quote references a superseded evidence version.");
  }
  const chunks = await input.evidenceStore.chunks(record.id);
  const matches: Array<{ chunkId: string; start: number; end: number }> = [];
  for (const chunk of chunks) {
    let index = chunk.text.indexOf(quote);
    while (index >= 0) {
      matches.push({
        chunkId: chunk.id,
        start: chunk.start + index,
        end: chunk.start + index + quote.length,
      });
      if (matches.length > 1) invalid("Claim quote is ambiguous in retained evidence.");
      index = chunk.text.indexOf(quote, index + 1);
    }
  }
  const match = matches[0];
  if (!match) invalid("Claim quote does not exactly match retained evidence.");
  return {
    evidenceId: record.id,
    chunkId: match.chunkId,
    start: match.start,
    end: match.end,
    textHash: await sha256(quote),
  };
}

/**
 * Resolves untrusted model quote candidates at the host boundary. The returned
 * values contain only deterministic ClaimV1 IDs and verified evidence spans;
 * never caller-provided offsets, hashes, or the private quoted text.
 */
export async function normalizeResearchClaimCandidatesV2(input: {
  candidates: readonly ResearchClaimCandidateV2[];
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  evidenceStore: ResearchEvidenceStoreV1;
  claimLedger: ResearchClaimLedgerV1;
  createdAt: string;
}): Promise<NormalizedResearchClaimCandidateV2[]> {
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > MAXIMUM_CANDIDATES) {
    invalid("Research claim candidates are invalid.");
  }
  const detailsBySourceId = new Map<string, ResearchDetailEvidenceV1>();
  for (const detail of input.detailEvidence) {
    if (detailsBySourceId.has(detail.source.id)) invalid("Detail evidence contains duplicate source IDs.");
    detailsBySourceId.set(detail.source.id, detail);
  }
  const seenCandidateIds = new Set<string>();
  const seenClaimIds = new Set<string>();
  const normalized: NormalizedResearchClaimCandidateV2[] = [];
  for (const candidate of input.candidates) {
    const candidateId = bounded(candidate?.id, "Research claim candidate ID", 160);
    if (seenCandidateIds.has(candidateId)) invalid("Research claim candidate IDs are duplicated.");
    seenCandidateIds.add(candidateId);
    if (candidate.classification !== "fact" && candidate.classification !== "inference") {
      invalid("Research claim candidate classification is invalid.");
    }
    const summary = bounded(candidate.summary, "Research claim candidate summary", 2_000);
    if (!Array.isArray(candidate.support) || candidate.support.length === 0 || candidate.support.length > MAXIMUM_SUPPORTS_PER_CANDIDATE) {
      invalid("Research claim candidate support is invalid.");
    }
    const spans = await Promise.all(candidate.support.map((support: ResearchEvidenceQuoteCandidateV2) =>
      resolveQuoteToSpan({ candidate: support, detailsBySourceId, evidenceStore: input.evidenceStore }),
    ));
    const identities = new Set(spans.map((span) => `${span.evidenceId}\u0000${span.chunkId}\u0000${span.start}\u0000${span.end}`));
    if (identities.size !== spans.length) invalid("Research claim candidate support is duplicated.");
    const claim = await createResearchClaimV1({
      evidenceStore: input.evidenceStore,
      classification: candidate.classification,
      statement: summary,
      evidenceSpans: spans,
      createdAt: input.createdAt,
    });
    if (seenClaimIds.has(claim.id)) invalid("Research claim candidates normalize to duplicate claims.");
    seenClaimIds.add(claim.id);
    normalized.push({ candidateId, claim: await input.claimLedger.put(claim) });
  }
  return normalized;
}
