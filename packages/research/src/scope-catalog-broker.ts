import { ResearchContractError } from "./contracts.js";
import {
  decodeResearchReferenceResolveIntentV1,
  decodeResearchScopeCatalogIntentV1,
  type ResearchReferenceResolveIntentV1,
  type ResearchReferenceResolveOutputV1,
  type ResearchScopeCatalogCapabilityId,
  type ResearchScopeCatalogIntentV1,
  type ResearchScopeCatalogPageV1,
} from "./scope-catalog.js";
import type { ResearchScopeCandidateV1 } from "./scope-discovery.js";
import { RESEARCH_SCOPE_CANDIDATE_SCHEMA_V1 } from "./scope-discovery.js";

export interface ResearchScopeCatalogProviderPageV1 {
  candidates: ResearchScopeCandidateV1[];
  nextProviderCursor?: string;
}

export interface ResearchScopeCatalogProvidersV1 {
  jira: {
    listProjects(input: {
      query?: string;
      includeArchived: boolean;
      providerCursor?: string;
      maxCandidates: number;
      signal: AbortSignal;
    }): Promise<ResearchScopeCatalogProviderPageV1>;
  };
  confluence: {
    listSpaces(input: {
      query?: string;
      includeArchived: boolean;
      providerCursor?: string;
      maxCandidates: number;
      signal: AbortSignal;
    }): Promise<ResearchScopeCatalogProviderPageV1>;
  };
  resolveReference(input: ResearchReferenceResolveIntentV1 & { signal: AbortSignal }): Promise<ResearchScopeCandidateV1 | undefined>;
}

export interface ResearchScopeCatalogBrokerLimitsV1 {
  /** Provider calls across catalog pages and exact-reference resolution. */
  maxCalls: number;
  maxPages: number;
  maxCandidates: number;
  maxResultBytes: number;
  maxCursorEntries: number;
  cursorTtlMs: number;
  /** Per-provider-call ceiling; separate from the run-wide content deadline. */
  maxCallDurationMs: number;
}

const DEFAULT_LIMITS: ResearchScopeCatalogBrokerLimitsV1 = {
  maxCalls: 32,
  maxPages: 10,
  maxCandidates: 100,
  maxResultBytes: 128_000,
  maxCursorEntries: 32,
  cursorTtlMs: 120_000,
  maxCallDurationMs: 10_000,
};

interface CursorEntry {
  capability: "jira.project.search" | "wiki.space.search";
  providerCursor: string;
  expiresAt: number;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function assertCandidate(candidate: ResearchScopeCandidateV1, tenantOrigin: string, intent: ResearchScopeCatalogIntentV1 | ResearchReferenceResolveIntentV1): void {
  if (candidate.schema !== RESEARCH_SCOPE_CANDIDATE_SCHEMA_V1) invalid("Scope catalog candidate schema is unsupported.");
  if (candidate.tenantOrigin !== tenantOrigin || candidate.accessible !== true) invalid("Scope catalog candidate is outside the active tenant or inaccessible.");
  if (!/^research-scope-candidate:[A-Za-z0-9-]{1,200}$/.test(candidate.id)) invalid("Scope catalog candidate id is not opaque.");
  if (!/^research-scope-entity:[A-Za-z0-9-]{1,200}$/.test(candidate.entityRef)) invalid("Scope catalog entity reference is not opaque.");
  if ("entityKind" in intent && (candidate.product !== intent.product || candidate.entityKind !== intent.entityKind)) invalid("Scope catalog candidate does not match the requested capability.");
  if ("expectedKinds" in intent && !intent.expectedKinds.includes(candidate.entityKind)) invalid("Resolved reference has an unexpected entity kind.");
}

export class ResearchScopeCatalogBroker {
  readonly #tenantOrigin: string;
  readonly #providers: ResearchScopeCatalogProvidersV1;
  readonly #limits: ResearchScopeCatalogBrokerLimitsV1;
  readonly #controller = new AbortController();
  readonly #cursors = new Map<string, CursorEntry>();
  #cursorSequence = 0;
  #calls = 0;
  #pages = 0;
  #candidates = 0;

  constructor(input: {
    tenantOrigin: string;
    providers: ResearchScopeCatalogProvidersV1;
    limits?: Partial<ResearchScopeCatalogBrokerLimitsV1>;
  }) {
    this.#tenantOrigin = input.tenantOrigin;
    this.#providers = input.providers;
    this.#limits = { ...DEFAULT_LIMITS, ...input.limits };
  }

  cancel(reason = new DOMException("Cancelled", "AbortError")): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    this.#cursors.clear();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  async invoke(capability: ResearchScopeCatalogCapabilityId, value: unknown): Promise<ResearchScopeCatalogPageV1 | ResearchReferenceResolveOutputV1> {
    if (capability === "atlassian.reference.resolve") {
      const input = decodeResearchReferenceResolveIntentV1(value);
      const candidate = await this.#invokeProvider((signal) =>
        this.#providers.resolveReference({ ...input, signal }),
      );
      if (!candidate) return { schema: "atlcli.ptc/atlassian.reference.resolve.output/v1", unavailable: true };
      assertCandidate(candidate, this.#tenantOrigin, input);
      return { schema: "atlcli.ptc/atlassian.reference.resolve.output/v1", candidate, unavailable: false };
    }
    const input = decodeResearchScopeCatalogIntentV1(capability, value, this.#limits.maxCandidates);
    if (this.#pages >= this.#limits.maxPages) return { schema: ResearchScopeCatalogPageSchema(capability), candidates: [], truncated: true };
    this.#pages += 1;
    const providerCursor = input.cursorRef ? this.takeCursor(input.cursorRef, capability) : undefined;
    const page = input.product === "jira"
      ? await this.#invokeProvider((signal) => this.#providers.jira.listProjects({
          query: input.normalizedQuery,
          includeArchived: input.includeArchived,
          providerCursor,
          maxCandidates: Math.min(input.maxCandidates, this.#limits.maxCandidates - this.#candidates),
          signal,
        }))
      : await this.#invokeProvider((signal) => this.#providers.confluence.listSpaces({
          query: input.normalizedQuery,
          includeArchived: input.includeArchived,
          providerCursor,
          maxCandidates: Math.min(input.maxCandidates, this.#limits.maxCandidates - this.#candidates),
          signal,
        }));
    const candidates = page.candidates.slice(0, Math.max(0, this.#limits.maxCandidates - this.#candidates));
    for (const candidate of candidates) assertCandidate(candidate, this.#tenantOrigin, input);
    this.#candidates += candidates.length;
    const output: ResearchScopeCatalogPageV1 = {
      schema: ResearchScopeCatalogPageSchema(capability),
      candidates,
      truncated: Boolean(page.nextProviderCursor) || candidates.length < page.candidates.length || this.#pages >= this.#limits.maxPages || this.#candidates >= this.#limits.maxCandidates,
    };
    if (page.nextProviderCursor && this.#pages < this.#limits.maxPages && this.#candidates < this.#limits.maxCandidates) {
      output.nextCursorRef = this.putCursor(capability, page.nextProviderCursor);
    }
    if (new TextEncoder().encode(JSON.stringify(output)).byteLength > this.#limits.maxResultBytes) invalid("Scope catalog result exceeds the byte limit.");
    return output;
  }

  private putCursor(capability: CursorEntry["capability"], providerCursor: string): string {
    if (this.#cursors.size >= this.#limits.maxCursorEntries) invalid("Scope catalog cursor budget exhausted.");
    const ref = `research-scope-cursor:${++this.#cursorSequence}`;
    this.#cursors.set(ref, { capability, providerCursor, expiresAt: Date.now() + this.#limits.cursorTtlMs });
    return ref;
  }

  private takeCursor(ref: string, capability: CursorEntry["capability"]): string {
    const entry = this.#cursors.get(ref);
    if (!entry || entry.capability !== capability || entry.expiresAt < Date.now()) invalid("Scope catalog cursor is invalid or expired.");
    this.#cursors.delete(ref);
    return entry.providerCursor;
  }

  /**
   * Catalog metadata is intentionally budgeted independently from content
   * search, but it still needs one run-wide call and per-call time fence. The
   * local controller lets an expired catalog call fail without cancelling a
   * later, still-valid catalog request; a host-wide cancellation propagates
   * through the same signal immediately.
   */
  async #invokeProvider<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#calls >= this.#limits.maxCalls) {
      invalid("Scope catalog call budget exhausted.");
    }
    this.#calls += 1;
    const controller = new AbortController();
    const onHostAbort = (): void => controller.abort(this.signal.reason);
    if (this.signal.aborted) onHostAbort();
    else this.signal.addEventListener("abort", onHostAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(
      new ResearchContractError("limit-exceeded", "Scope catalog call timed out."),
    ), this.#limits.maxCallDurationMs);
    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(
          controller.signal.reason ?? new DOMException("Cancelled", "AbortError"),
        ), { once: true });
      });
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener("abort", onHostAbort);
    }
  }
}

function ResearchScopeCatalogPageSchema(capability: "jira.project.search" | "wiki.space.search"): string {
  return capability === "jira.project.search" ? "atlcli.ptc/jira.project.search.output/v1" : "atlcli.ptc/wiki.space.search.output/v1";
}
