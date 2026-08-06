import {
  RESEARCH_SCOPE_BINDING_SCHEMA_V1,
  RESEARCH_TOOL_IDS,
  ResearchContractError,
  type ResearchProduct,
  type ResearchRequestV1,
  type ResearchScopeBindingV1,
  type ResearchSourceReferenceV1,
  type ResearchToolId,
} from "./contracts.js";
import {
  RESEARCH_CAPABILITY_SCHEMAS,
  BOUND_ENTITY_READ_OUTPUT_SCHEMA_V1,
  BOUND_ENTITY_SECTION_READ_OUTPUT_SCHEMA_V1,
  decodeResearchCandidateRankInputV1,
  decodeBoundEntityReadInputV1,
  decodeBoundEntitySectionReadInputV1,
  decodeResearchGetInputV1,
  decodeResearchSearchInputV1,
  type BoundedContentProjectionV1,
  type BoundEntityAnchorV1,
  type BoundEntityReadOutputV1,
  type BoundEntitySectionReadOutputV1,
  type BoundDocumentCoverageIssueV1,
  type BoundDocumentOutlineV1,
  type ResearchCandidateRankOutputV1,
  type ResearchEntitySummaryV1,
  type ResearchGetOutputV1,
  type ResearchSearchOutputV1,
  type ResearchSearchQueryV1,
  type ResearchTerminationCode,
} from "./capability-contracts.js";
import type { BoundedDocumentSourceV1 } from "./document-navigation.js";
import type { ChatAuxiliaryReadNeedV1 } from "./chat-agent/auxiliary.js";
import { rankResearchCandidatesV1 } from "./candidate-ranking.js";
import { ResearchRunBudget } from "./budget.js";
import {
  ResearchCursorVault,
  type ResearchCursorChain,
} from "./cursor-vault.js";
import { ResearchEntityVault } from "./entity-vault.js";
import {
  createResearchEvidenceRecordV1,
  type ResearchEvidenceRecordV1,
  type ResearchEvidenceRetrievalV1,
  type ResearchEvidenceStoreV1,
} from "./evidence-store.js";
import type { ResearchClaimLedgerV1 } from "./claim-ledger.js";
import {
  assessResearchRetrievalV1,
  type ResearchRetrievalAssessmentV1,
} from "./retrieval-assessment.js";
import {
  buildResearchCql,
  buildResearchJql,
  parseResearchQueryFingerprint,
  researchQueryFingerprint,
} from "./query.js";

export interface JiraResearchSummary {
  issueKey: string;
  projectKey: string;
  title: string;
  updatedAt?: string;
  excerpt?: string;
}

export interface WikiResearchSummary {
  contentId: string;
  spaceKey: string;
  title: string;
  updatedAt?: string;
  excerpt?: string;
}

export interface JiraResearchDetail extends JiraResearchSummary {
  content: BoundedContentProjectionV1;
}

export interface WikiResearchDetail extends WikiResearchSummary {
  content: BoundedContentProjectionV1;
  /** Host-private parsed document snapshot; never returned directly to QuickJS. */
  navigation?: BoundedDocumentSourceV1;
}

export interface ResearchProviderPage<T> {
  items: T[];
  nextProviderCursor?: string;
}

export interface ResearchReadProviders {
  jira: {
    searchPage(input: {
      jql: string;
      pageSize: number;
      providerCursor?: string;
      signal: AbortSignal;
    }): Promise<ResearchProviderPage<JiraResearchSummary>>;
    getIssue(input: {
      issueKey: string;
      includeComments?: boolean;
      includeMetadata?: boolean;
      signal: AbortSignal;
    }): Promise<JiraResearchDetail>;
  };
  wiki: {
    searchPage(input: {
      cql: string;
      pageSize: number;
      providerCursor?: string;
      signal: AbortSignal;
    }): Promise<ResearchProviderPage<WikiResearchSummary>>;
    getPage(input: {
      contentId: string;
      includeComments?: boolean;
      includeMetadata?: boolean;
      signal: AbortSignal;
    }): Promise<WikiResearchDetail>;
  };
}

export interface ResearchDetailEvidenceV1 {
  source: ResearchSourceReferenceV1;
  content: BoundedContentProjectionV1;
  /** Host-recorded selection rationale, never model-supplied text. */
  retrieval?: ResearchEvidenceRetrievalV1;
  /** Present only when the detail is durably retained under an approved binding. */
  evidenceId?: string;
  /** Exact section identity for a navigated page projection. */
  section?: { sectionId: string; heading: string; order: number };
  coverage?: {
    snapshot?: BoundDocumentOutlineV1["snapshot"];
    issues: BoundDocumentCoverageIssueV1[];
    sourceTruncated: boolean;
    outlineTruncated: boolean;
    projectionTruncated: boolean;
    unreadSections: number;
    completeDocumentRead: boolean;
  };
}

/** Body-free host proof that one Confluence section was included in a detail read. */
export interface ResearchReadSectionReferenceV1 {
  sourceId: string;
  sectionId: string;
  heading: string;
  order: number;
}

/** Body-free outcome of host-side freshness checks before report finalization. */
export interface ResearchEvidenceRevalidationOutcomeV1 {
  /** Retained records inspected for possible reuse. */
  considered: number;
  /** Records still inside the configured freshness interval. */
  fresh: number;
  /** Older records successfully re-read through the scoped provider. */
  revalidated: number;
  /** Records whose dependent claims were excluded because revalidation failed. */
  invalidated: number;
}

/** Body-free host result for staging retained evidence as a turn-local read. */
export interface ResearchRetainedEvidenceRestoreOutcomeV1 {
  considered: number;
  staged: number;
  stale: number;
  unauthorized: number;
  missing: number;
}

export interface ResearchExactAnchorResumeV1 {
  anchorRef: string;
  bindingId: string;
}

interface BrokerOptions {
  createCursorId?: () => string;
  createEntityId?: () => string;
  createAnchorId?: () => string;
  /** Host-private opaque refs restored only for the same durable turn. */
  exactAnchorResume?: readonly ResearchExactAnchorResumeV1[];
  createSectionId?: () => string;
  createCaptureId?: () => string;
  exactAuxiliaryNeeds?: readonly ChatAuxiliaryReadNeedV1[];
  /** Optional Chat workflow fence evaluated before any budget or provider work. */
  beforeContentOperation?: () => void;
  /**
   * Host-only observer for an exact tenant-local relationship whose parent
   * scope is not currently admitted. Observing this metadata grants no read
   * capability; Chat may persist it as a user-review proposal.
   */
  onRelatedScopeCandidate?: (
    candidate: ResearchRelatedScopeCandidateV1,
  ) => void | Promise<void>;
  budget?: ResearchRunBudget;
  /** Optional private evidence sink for durable session-backed detail reads. */
  evidence?: {
    store: ResearchEvidenceStoreV1;
    claimLedger?: ResearchClaimLedgerV1;
    scopeBindings: readonly ResearchScopeBindingV1[];
    capturedAt?: () => string;
  };
  /** Host-owned bindings for a durable turn; never exposed to QuickJS. */
  scopeBindings?: readonly ResearchScopeBindingV1[];
}

/** Body-free relationship metadata that is not itself a scope binding. */
export interface ResearchRelatedScopeCandidateV1 {
  product: "confluence";
  entityKind: "page";
  key: string;
  scopeKey: string;
  name: string;
  canonicalUrl: string;
  discoveredFromProduct: "jira";
  discoveredFromSourceId: string;
  reason: "explicit-link-outside-bound-scope";
}

interface RankedDetailAdmissionV1 {
  product: ResearchProduct;
  retrieval: ResearchEvidenceRetrievalV1;
}

interface ExactEntityBindingV1 {
  binding: ResearchScopeBindingV1;
  product: ResearchProduct;
  entityId: string;
}

interface ExactDocumentStateV1 {
  source: ResearchSourceReferenceV1;
  snapshot: BoundDocumentOutlineV1["snapshot"];
  coverageIssues: BoundDocumentCoverageIssueV1[];
  sourceTruncated: boolean;
  outlineTruncated: boolean;
  projectionTruncated: boolean;
  genuinelyEmpty: boolean;
  totalSections: number;
  sectionRefs: string[];
  readSectionIds: Set<string>;
}

interface ExactSectionBindingV1 {
  document: ExactDocumentStateV1;
  section: BoundedDocumentSourceV1["sections"][number];
}

class ConcurrencyGate {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = this.#waiters.indexOf(start);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        const start = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        this.#waiters.push(start);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    signal.throwIfAborted();
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

function cleanOptionalText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  return cleaned || undefined;
}

function navigableInitialProjection(
  content: BoundedContentProjectionV1,
  navigation: BoundedDocumentSourceV1 | undefined,
): BoundedContentProjectionV1 {
  if (!navigation || !content.truncated) return content;
  const text = [...content.text].slice(0, 1_200).join("");
  return {
    text,
    linkTargets: content.linkTargets.slice(0, 20),
    truncated: true,
    inputBytes: content.inputBytes,
  };
}

const OBSERVED_JIRA_KEY_PATTERN_V1 = /\b[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}\b/g;

function observedJiraKeysFromWikiDetail(
  content: BoundedContentProjectionV1,
  tenantOrigin: string,
  maximum: number,
): string[] {
  const keys = new Set<string>();
  for (const match of content.text.matchAll(OBSERVED_JIRA_KEY_PATTERN_V1)) {
    keys.add(match[0]);
    if (keys.size >= maximum) return [...keys];
  }
  for (const target of content.linkTargets) {
    try {
      const url = new URL(target);
      if (url.origin !== tenantOrigin) continue;
      const match = url.pathname.match(/(?:^|\/)(?:browse\/)?([A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18})(?:\/|$)/);
      if (match?.[1]) keys.add(match[1]);
      if (keys.size >= maximum) break;
    } catch {
      // Invalid projected links are ignored; they never become capabilities.
    }
  }
  return [...keys];
}

function observedConfluencePagesFromJiraDetail(
  content: BoundedContentProjectionV1,
  tenantOrigin: string,
  maximum: number,
): Array<{ contentId: string; spaceKey?: string; canonicalUrl: string }> {
  const pages = new Map<
    string,
    { contentId: string; spaceKey?: string; canonicalUrl: string }
  >();
  for (const target of content.linkTargets) {
    try {
      const url = new URL(target);
      if (url.origin !== tenantOrigin) continue;
      const scoped = url.pathname.match(
        /\/wiki\/spaces\/([^/]+)\/pages\/([1-9][0-9]{0,127})(?:\/|$)/u,
      );
      const unscoped = url.pathname.match(
        /\/wiki\/(?:pages|viewpage\.action\/pages)\/([1-9][0-9]{0,127})(?:\/|$)/u,
      );
      const contentId = scoped?.[2] ?? unscoped?.[1];
      const spaceKey = scoped?.[1] ? decodeURIComponent(scoped[1]) : undefined;
      if (!contentId) continue;
      url.hash = "";
      url.search = "";
      pages.set(contentId, {
        contentId,
        ...(spaceKey ? { spaceKey } : {}),
        canonicalUrl: url.toString(),
      });
      if (pages.size >= maximum) break;
    } catch {
      // Invalid or foreign links never become exact capabilities.
    }
  }
  return [...pages.values()];
}

function publicSource(
  source: ResearchSourceReferenceV1
): Omit<ResearchEntitySummaryV1, "entityRef" | "excerpt"> {
  return {
    sourceId: source.id,
    product: source.product,
    title: source.title,
    url: source.url,
    ...(source.issueKey ? { issueKey: source.issueKey } : {}),
    ...(source.contentId ? { contentId: source.contentId } : {}),
    ...(source.projectKey ? { projectKey: source.projectKey } : {}),
    ...(source.spaceKey ? { spaceKey: source.spaceKey } : {}),
    ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
  };
}

function exactEntityBinding(
  binding: ResearchScopeBindingV1,
  tenantOrigin: string,
): ExactEntityBindingV1 | undefined {
  if (binding.entityKind !== "issue" && binding.entityKind !== "page") return undefined;
  if (
    binding.tenantOrigin !== tenantOrigin ||
    (binding.authority !== "approved" && binding.authority !== "locked") ||
    !/^research-scope-entity:[A-Za-z0-9._-]{1,200}$/.test(binding.entityRef) ||
    typeof binding.key !== "string"
  ) {
    throw new ResearchContractError("invalid-request", "Approved exact research scope binding is invalid.");
  }
  if (binding.entityKind === "issue") {
    const issueKey = binding.key.toLocaleUpperCase("en-US");
    if (binding.product !== "jira" || !/^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}$/.test(issueKey)) {
      throw new ResearchContractError("invalid-request", "Approved exact Jira scope binding is invalid.");
    }
    return { binding: { ...binding, key: issueKey }, product: "jira", entityId: issueKey };
  }
  if (binding.product !== "confluence" || !/^[1-9][0-9]{0,127}$/.test(binding.key)) {
    throw new ResearchContractError("invalid-request", "Approved exact Confluence scope binding is invalid.");
  }
  return { binding: { ...binding }, product: "confluence", entityId: binding.key };
}

export class ResearchCapabilityBroker {
  readonly budget: ResearchRunBudget;
  readonly #request: ResearchRequestV1;
  readonly #providers: ResearchReadProviders;
  readonly #cursorVault: ResearchCursorVault;
  readonly #entityVault: ResearchEntityVault;
  readonly #gate: ConcurrencyGate;
  readonly #sources = new Map<string, ResearchSourceReferenceV1>();
  readonly #detailEvidence = new Map<string, ResearchDetailEvidenceV1>();
  readonly #rankedEntityRefs = new Map<string, RankedDetailAdmissionV1>();
  readonly #scopeBindings: ResearchScopeBindingV1[];
  readonly #exactEntityBindings = new Map<string, ExactEntityBindingV1>();
  readonly #exactAnchorBindings = new Map<string, ExactEntityBindingV1>();
  readonly #exactAnchorRefs = new Map<string, string>();
  readonly #createAnchorId: () => string;
  readonly #exactSectionBindings = new Map<string, ExactSectionBindingV1>();
  readonly #activeExactDocuments = new Map<string, ExactDocumentStateV1>();
  readonly #readSectionReferences = new Map<string, ResearchReadSectionReferenceV1>();
  readonly #captureRefs = new Set<string>();
  readonly #createSectionId: () => string;
  readonly #createCaptureId: () => string;
  readonly #exactAuxiliaryNeeds: ReadonlySet<ChatAuxiliaryReadNeedV1>;
  readonly #beforeContentOperation?: () => void;
  readonly #onRelatedScopeCandidate?: BrokerOptions["onRelatedScopeCandidate"];
  readonly #exactSearchEmitted = new Set<ResearchProduct>();
  readonly #successfulDetailReads: Array<{ product: ResearchProduct; sourceId: string }> = [];
  readonly #searchAttempts: Record<ResearchProduct, number> = {
    jira: 0,
    confluence: 0,
  };
  readonly #evidence?: NonNullable<BrokerOptions["evidence"]>;
  readonly #retainedExactEvidence = new Map<string, {
    record: ResearchEvidenceRecordV1;
    content: BoundedContentProjectionV1;
  }>();
  readonly #controller = new AbortController();
  readonly #searchCompletion: Record<
    "jira" | "confluence",
    { complete: boolean; termination?: ResearchTerminationCode }
  > = {
    jira: { complete: false },
    confluence: { complete: false },
  };

  constructor(
    request: ResearchRequestV1,
    providers: ResearchReadProviders,
    options: BrokerOptions = {}
  ) {
    this.#request = request;
    this.#providers = providers;
    this.budget = options.budget ?? new ResearchRunBudget(request.limits);
    this.#cursorVault = new ResearchCursorVault({
      maxEntries:
        request.limits.maxSearchPagesPerProduct * 2,
      createId: options.createCursorId,
      ttlMs: request.limits.maxRunMs,
    });
    this.#entityVault = new ResearchEntityVault({
      maxEntries: request.limits.maxItemsPerProduct * 2,
      createId: options.createEntityId,
    });
    this.#createAnchorId = options.createAnchorId ?? (() => {
      if (typeof crypto?.randomUUID !== "function") {
        throw new ResearchContractError("unknown", "Secure exact-anchor refs are unavailable.");
      }
      return crypto.randomUUID();
    });
    this.#createSectionId = options.createSectionId ?? (() => {
      if (typeof crypto?.randomUUID !== "function") {
        throw new ResearchContractError("unknown", "Secure exact-section refs are unavailable.");
      }
      return crypto.randomUUID();
    });
    this.#createCaptureId = options.createCaptureId ?? (() => {
      if (typeof crypto?.randomUUID !== "function") {
        throw new ResearchContractError("unknown", "Secure document capture refs are unavailable.");
      }
      return crypto.randomUUID();
    });
    this.#exactAuxiliaryNeeds = new Set(options.exactAuxiliaryNeeds ?? []);
    this.#beforeContentOperation = options.beforeContentOperation;
    this.#onRelatedScopeCandidate = options.onRelatedScopeCandidate;
    this.#evidence = options.evidence;
    this.#scopeBindings = [...(options.scopeBindings ?? options.evidence?.scopeBindings ??
      request.scopeSeeds?.map((seed) => seed.binding) ?? [])];
    this.#scopeBindings.forEach((binding) => this.#registerExactEntityBinding(binding));
    if (options.exactAnchorResume) {
      const exactByBindingId = new Map(
        [...this.#exactEntityBindings.entries()].map(([key, exact]) => [
          exact.binding.id,
          { key, exact },
        ]),
      );
      for (const resumed of options.exactAnchorResume) {
        if (!/^research-anchor:[A-Za-z0-9-]{1,200}$/.test(resumed.anchorRef) ||
            typeof resumed.bindingId !== "string" || resumed.bindingId.length > 512) {
          throw new ResearchContractError("invalid-request", "A resumed exact-anchor binding is invalid.");
        }
        const registered = exactByBindingId.get(resumed.bindingId);
        if (!registered || this.#exactAnchorBindings.has(resumed.anchorRef) ||
            this.#exactAnchorRefs.has(registered.key)) {
          throw new ResearchContractError(
            "access-denied",
            "A resumed exact-anchor binding is unavailable for this turn.",
          );
        }
        this.#exactAnchorRefs.set(registered.key, resumed.anchorRef);
        this.#exactAnchorBindings.set(resumed.anchorRef, registered.exact);
      }
    }
    this.#gate = new ConcurrencyGate(request.limits.maxConcurrentCalls);
  }

  /**
   * Add one host-derived exact-entity binding after the durable session reducer
   * has accepted an `exact-linked` policy transition. The caller cannot widen
   * a project/space or replace an existing exact entity.
   */
  allowPreauthorizedExactEntity(binding: ResearchScopeBindingV1): void {
    if (binding.source !== "research_discovery" || binding.authority !== "approved" ||
        !binding.candidateId || binding.id !== `scope-binding:preauthorized:${binding.candidateId}` ||
        !binding.approvedAt || !Number.isFinite(Date.parse(binding.approvedAt))) {
      throw new ResearchContractError("invalid-request", "Preauthorized exact research scope binding is invalid.");
    }
    const exact = exactEntityBinding(binding, this.#request.scope.siteOrigin);
    if (!exact) {
      throw new ResearchContractError("invalid-request", "Preauthorized binding must name one exact page or issue.");
    }
    if (this.#scopeBindings.some((candidate) => candidate.id === binding.id)) {
      throw new ResearchContractError("invalid-request", "Preauthorized exact research scope binding is duplicated.");
    }
    this.#scopeBindings.push({ ...binding });
    this.#registerExactEntityBinding(binding);
    this.#exactSearchEmitted.delete(exact.product);
  }

  #registerExactEntityBinding(binding: ResearchScopeBindingV1): void {
    const exact = exactEntityBinding(binding, this.#request.scope.siteOrigin);
    if (!exact) return;
    const key = `${exact.product}:${exact.entityId}`;
    if (this.#exactEntityBindings.has(key)) {
      throw new ResearchContractError("invalid-request", "Approved exact research scope binding is duplicated.");
    }
    this.#exactEntityBindings.set(key, exact);
  }

  #registerObservedJiraReferences(content: BoundedContentProjectionV1): void {
    const keys = observedJiraKeysFromWikiDetail(
      content,
      this.#request.scope.siteOrigin,
      Math.min(this.#request.limits.maxItemsPerProduct, 20),
    );
    for (const issueKey of keys) {
      const exactKey = `jira:${issueKey}`;
      if (this.#exactEntityBindings.has(exactKey)) continue;
      const binding: ResearchScopeBindingV1 = {
        schema: RESEARCH_SCOPE_BINDING_SCHEMA_V1,
        id: `scope-binding:observed-link:jira:${issueKey}`,
        tenantOrigin: this.#request.scope.siteOrigin,
        product: "jira",
        entityKind: "issue",
        entityRef: `research-scope-entity:observed-jira-${issueKey}`,
        key: issueKey,
        name: issueKey,
        source: "exact_link",
        authority: "approved",
      };
      this.#scopeBindings.push(binding);
      this.#registerExactEntityBinding(binding);
      this.#exactSearchEmitted.delete("jira");
    }
  }

  async #registerObservedConfluenceReferences(
    content: BoundedContentProjectionV1,
    discoveredFromSourceId: string,
  ): Promise<void> {
    const pages = observedConfluencePagesFromJiraDetail(
      content,
      this.#request.scope.siteOrigin,
      Math.min(this.#request.limits.maxItemsPerProduct, 20),
    );
    for (const page of pages) {
      const allowedSpaces = this.#request.scope.confluenceSpaceKeys;
      if (allowedSpaces.length > 0 &&
          (!page.spaceKey || !allowedSpaces.includes(page.spaceKey))) {
        if (page.spaceKey) {
          await this.#onRelatedScopeCandidate?.({
            product: "confluence",
            entityKind: "page",
            key: page.contentId,
            scopeKey: page.spaceKey,
            name: `Confluence ${page.contentId}`,
            canonicalUrl: page.canonicalUrl,
            discoveredFromProduct: "jira",
            discoveredFromSourceId,
            reason: "explicit-link-outside-bound-scope",
          });
        }
        continue;
      }
      const exactKey = `confluence:${page.contentId}`;
      if (this.#exactEntityBindings.has(exactKey)) continue;
      const binding: ResearchScopeBindingV1 = {
        schema: RESEARCH_SCOPE_BINDING_SCHEMA_V1,
        id: `scope-binding:observed-link:confluence:${page.contentId}`,
        tenantOrigin: this.#request.scope.siteOrigin,
        product: "confluence",
        entityKind: "page",
        entityRef: `research-scope-entity:observed-confluence-${page.contentId}`,
        key: page.contentId,
        name: `Confluence ${page.contentId}`,
        source: "exact_link",
        authority: "approved",
      };
      this.#scopeBindings.push(binding);
      this.#registerExactEntityBinding(binding);
      this.#exactSearchEmitted.delete("confluence");
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  cancel(reason: unknown = new DOMException("Cancelled", "AbortError")): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    this.#cursorVault.clear();
    this.#entityVault.clear();
    this.#sources.clear();
    this.#detailEvidence.clear();
    this.#rankedEntityRefs.clear();
    this.#exactAnchorBindings.clear();
    this.#exactAnchorRefs.clear();
    this.#exactSectionBindings.clear();
    this.#activeExactDocuments.clear();
    this.#readSectionReferences.clear();
    this.#successfulDetailReads.length = 0;
    this.#retainedExactEvidence.clear();
  }

  #retainedSourceIsAuthorized(record: ResearchEvidenceRecordV1): boolean {
    if (record.identity.tenantOrigin !== this.#request.scope.siteOrigin) return false;
    const source = record.source;
    const exact = this.#exactEntityBindings.get(
      `${record.identity.product}:${record.identity.entityId}`,
    );
    if (exact) return true;
    return this.#scopeBindings.some((binding) => {
      if (
        binding.tenantOrigin !== this.#request.scope.siteOrigin ||
        (binding.authority !== "approved" && binding.authority !== "locked")
      ) return false;
      if (source.product === "jira") {
        return binding.product === "jira" &&
          binding.entityKind === "project" &&
          binding.key === source.projectKey &&
          this.#request.scope.jiraProjectKeys.includes(source.projectKey ?? "");
      }
      return binding.product === "confluence" &&
        binding.entityKind === "space" &&
        binding.key === source.spaceKey &&
        this.#request.scope.confluenceSpaceKeys.includes(source.spaceKey ?? "");
    });
  }

  #registerRetainedExactCapability(record: ResearchEvidenceRecordV1): void {
    const key = `${record.identity.product}:${record.identity.entityId}`;
    if (this.#exactEntityBindings.has(key)) return;
    const product = record.identity.product;
    const entityKind = product === "jira" ? "issue" : "page";
    this.#exactEntityBindings.set(key, {
      product,
      entityId: record.identity.entityId,
      binding: {
        schema: "atlcli.research-scope-binding/v1",
        id: `scope-binding:retained:${record.id.slice("evidence:".length)}`,
        tenantOrigin: record.identity.tenantOrigin,
        product,
        entityKind,
        entityRef: `research-scope-entity:retained-${record.id.slice("evidence:".length)}`,
        key: record.identity.entityId,
        name: record.source.title,
        source: "research_discovery",
        authority: "approved",
      },
    });
  }

  /**
   * Stage fresh, integrity-checked evidence for the current turn. Staging does
   * not enter it into the source/evidence ledger and therefore cannot support
   * an answer until the model performs the corresponding opaque bound read.
   */
  async restoreRetainedEvidence(input: {
    evidenceIds: readonly string[];
    checkedAt: string;
  }): Promise<ResearchRetainedEvidenceRestoreOutcomeV1> {
    if (!this.#evidence) {
      throw new ResearchContractError(
        "invalid-request",
        "Retained evidence restore requires a durable evidence store.",
      );
    }
    if (this.#sources.size > 0 || this.#detailEvidence.size > 0) {
      throw new ResearchContractError(
        "invalid-request",
        "Retained evidence must be staged before current-turn detail reads.",
      );
    }
    const checkedAtMs = Date.parse(input.checkedAt);
    if (!Number.isFinite(checkedAtMs)) {
      throw new ResearchContractError("invalid-request", "Evidence restore time is invalid.");
    }
    const outcome: ResearchRetainedEvidenceRestoreOutcomeV1 = {
      considered: 0,
      staged: 0,
      stale: 0,
      unauthorized: 0,
      missing: 0,
    };
    for (const evidenceId of [...new Set(input.evidenceIds)].sort()) {
      const record = await this.#evidence.store.get(evidenceId);
      if (!record) {
        outcome.missing += 1;
        continue;
      }
      outcome.considered += 1;
      if (!this.#retainedSourceIsAuthorized(record)) {
        outcome.unauthorized += 1;
        continue;
      }
      const capturedAtMs = Date.parse(record.version.capturedAt);
      if (
        !Number.isFinite(capturedAtMs) ||
        checkedAtMs < capturedAtMs ||
        checkedAtMs - capturedAtMs > this.#request.limits.maxEvidenceAgeMs
      ) {
        outcome.stale += 1;
        continue;
      }
      const chunks = await this.#evidence.store.chunks(record.id);
      const content: BoundedContentProjectionV1 = {
        text: chunks.map((chunk) => chunk.text).join(""),
        linkTargets: [...record.linkTargets],
        truncated: record.version.truncated,
        inputBytes: record.version.inputBytes,
      };
      const key = `${record.identity.product}:${record.identity.entityId}`;
      const current = this.#retainedExactEvidence.get(key);
      if (!current || current.record.version.capturedAt < record.version.capturedAt) {
        this.#retainedExactEvidence.set(key, { record, content });
      }
      this.#registerRetainedExactCapability(record);
      outcome.staged += 1;
    }
    return outcome;
  }

  async #readRetainedExactEvidence(
    exact: ExactEntityBindingV1,
  ): Promise<BoundEntityReadOutputV1 | undefined> {
    const retained = this.#retainedExactEvidence.get(
      `${exact.product}:${exact.entityId}`,
    );
    if (!retained) return undefined;
    const source = retained.record.source;
    const content = {
      ...retained.content,
      linkTargets: [...retained.content.linkTargets],
    };
    this.#sources.set(source.id, { ...source });
    this.#detailEvidence.set(source.id, {
      source: { ...source },
      content,
      ...(retained.record.retrieval
        ? { retrieval: { ...retained.record.retrieval } }
        : {}),
      evidenceId: retained.record.id,
      coverage: {
        issues: content.truncated ? ["projection_limit"] : [],
        sourceTruncated: false,
        outlineTruncated: false,
        projectionTruncated: content.truncated,
        unreadSections: 0,
        completeDocumentRead: !content.truncated,
      },
    });
    this.#successfulDetailReads.push({ product: source.product, sourceId: source.id });
    if (source.product === "confluence") {
      this.#registerObservedJiraReferences(content);
    } else {
      await this.#registerObservedConfluenceReferences(content, source.id);
    }
    return {
      schema: BOUND_ENTITY_READ_OUTPUT_SCHEMA_V1,
      source: publicSource(source),
      content,
      relatedAnchors: this.exactAnchors().filter((anchor) =>
        anchor.product === (source.product === "jira" ? "confluence" : "jira")
      ),
      budget: this.budget.snapshot(),
    };
  }

  /**
   * Rehydrate only host-observed detail identities for a fresh evaluator after
   * a durable checkpoint. This deliberately restores neither source bodies nor
   * entity references, so it cannot create another read capability; it only
   * keeps the host's marginal-evidence decision cumulative across generations.
   */
  restoreDetailedSourceObservations(
    observations: readonly { product: ResearchProduct; sourceId: string }[],
  ): void {
    if (this.#successfulDetailReads.length > 0) {
      throw new ResearchContractError(
        "invalid-request",
        "Historical detail observations must be restored before new reads.",
      );
    }
    const restored = new Map<string, { product: ResearchProduct; sourceId: string }>();
    for (const observation of observations) {
      if (
        !observation ||
        (observation.product !== "jira" && observation.product !== "confluence") ||
        typeof observation.sourceId !== "string" ||
        observation.sourceId.length === 0 ||
        observation.sourceId.length > 256 ||
        observation.sourceId.includes("\u0000")
      ) {
        throw new ResearchContractError(
          "invalid-request",
          "Historical detail observation is invalid.",
        );
      }
      restored.set(`${observation.product}:${observation.sourceId}`, {
        product: observation.product,
        sourceId: observation.sourceId,
      });
    }
    this.#successfulDetailReads.push(
      ...[...restored.values()].sort((left, right) =>
        `${left.product}:${left.sourceId}`.localeCompare(
          `${right.product}:${right.sourceId}`,
        ),
      ),
    );
  }

  sourceLedger(): ResearchSourceReferenceV1[] {
    return [...this.#sources.values()].map((source) => ({ ...source }));
  }

  detailEvidenceLedger(): ResearchDetailEvidenceV1[] {
    return [...this.#detailEvidence.values()].map((entry) => ({
      source: { ...entry.source },
      content: {
        ...entry.content,
        linkTargets: [...entry.content.linkTargets],
      },
      ...(entry.retrieval ? { retrieval: { ...entry.retrieval } } : {}),
      ...(entry.evidenceId === undefined ? {} : { evidenceId: entry.evidenceId }),
      ...(entry.section ? { section: { ...entry.section } } : {}),
      ...(entry.coverage ? {
        coverage: {
          ...entry.coverage,
          issues: [...entry.coverage.issues],
          ...(entry.coverage.snapshot
            ? { snapshot: { ...entry.coverage.snapshot } }
            : {}),
        },
      } : {}),
    }));
  }

  readSectionReferenceLedger(): ResearchReadSectionReferenceV1[] {
    return [...this.#readSectionReferences.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Issue body-free, turn-local capabilities for host-accepted exact bindings.
   * The binding's raw page ID, issue key, URL, tenant, and containing scope are
   * deliberately absent; QuickJS receives only the opaque ref and display data.
   */
  exactAnchors(): BoundEntityAnchorV1[] {
    return [...this.#exactEntityBindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, exact]) => {
        let anchorRef = this.#exactAnchorRefs.get(key);
        if (!anchorRef) {
          anchorRef = `research-anchor:${this.#createAnchorId()}`;
          if (!/^research-anchor:[A-Za-z0-9-]{1,200}$/.test(anchorRef) ||
              this.#exactAnchorBindings.has(anchorRef)) {
            throw new ResearchContractError("unknown", "A secure exact-anchor ref is invalid or reused.");
          }
          this.#exactAnchorRefs.set(key, anchorRef);
          this.#exactAnchorBindings.set(anchorRef, exact);
        }
        return {
          anchorRef,
          product: exact.product,
          entityKind: exact.product === "jira" ? "issue" : "page",
          name: cleanOptionalText(exact.binding.name, 2_000) ??
            (exact.product === "jira" ? "Bound Jira issue" : "Bound Confluence page"),
        };
      });
  }

  /** Host-private continuation state; never include this mapping in model input. */
  exactAnchorResume(): ResearchExactAnchorResumeV1[] {
    return [...this.#exactAnchorRefs.entries()]
      .map(([key, anchorRef]) => {
        const exact = this.#exactEntityBindings.get(key);
        if (!exact) {
          throw new ResearchContractError("unknown", "An exact-anchor continuation binding is missing.");
        }
        return { anchorRef, bindingId: exact.binding.id };
      })
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId, "en-US"));
  }

  #invalidateExactDocument(sourceId: string): void {
    const previous = this.#activeExactDocuments.get(sourceId);
    if (!previous) return;
    for (const sectionRef of previous.sectionRefs) {
      this.#exactSectionBindings.delete(sectionRef);
    }
    for (const key of this.#readSectionReferences.keys()) {
      if (key.startsWith(`${sourceId}#`)) this.#readSectionReferences.delete(key);
    }
    this.#activeExactDocuments.delete(sourceId);
  }

  #registerExactDocument(
    source: ResearchSourceReferenceV1,
    navigation: BoundedDocumentSourceV1 | undefined,
    projectionTruncated: boolean,
  ): BoundDocumentOutlineV1 | undefined {
    this.#invalidateExactDocument(source.id);
    if (!navigation) return undefined;
    const captureRef = `research-capture:${this.#createCaptureId()}`;
    if (!/^research-capture:[A-Za-z0-9-]{1,200}$/.test(captureRef) ||
        this.#captureRefs.has(captureRef)) {
      throw new ResearchContractError("unknown", "A secure document capture ref is invalid or reused.");
    }
    this.#captureRefs.add(captureRef);
    const document: ExactDocumentStateV1 = {
      source,
      snapshot: {
        sourceId: source.id,
        ...navigation.snapshot,
        captureRef,
      },
      coverageIssues: [...navigation.coverageIssues],
      sourceTruncated: navigation.sourceTruncated,
      outlineTruncated: navigation.outlineTruncated,
      projectionTruncated,
      genuinelyEmpty: navigation.genuinelyEmpty,
      totalSections: navigation.totalSections,
      sectionRefs: [],
      readSectionIds: new Set(
        projectionTruncated ? [] : navigation.sections.map((section) => section.sectionId),
      ),
    };
    const sections = navigation.sections.map((section) => {
      const sectionRef = `research-section:${this.#createSectionId()}`;
      if (!/^research-section:[A-Za-z0-9-]{1,200}$/.test(sectionRef) ||
          this.#exactSectionBindings.has(sectionRef)) {
        throw new ResearchContractError("unknown", "A secure exact-section ref is invalid or reused.");
      }
      document.sectionRefs.push(sectionRef);
      this.#exactSectionBindings.set(sectionRef, { document, section });
      if (!projectionTruncated) {
        this.#readSectionReferences.set(`${source.id}#${section.sectionId}`, {
          sourceId: source.id,
          sectionId: section.sectionId,
          heading: section.heading,
          order: section.order,
        });
      }
      return {
        sectionRef,
        sectionId: section.sectionId,
        heading: section.heading,
        level: section.level,
        order: section.order,
        contentBytes: section.contentBytes,
        metadata: {
          ...section.metadata,
          macroNames: [...section.metadata.macroNames],
          jiraIssueKeys: [...section.metadata.jiraIssueKeys],
          structures: { ...section.metadata.structures },
        },
      };
    });
    this.#activeExactDocuments.set(source.id, document);
    return {
      snapshot: { ...document.snapshot },
      coverageIssues: [...document.coverageIssues],
      sourceTruncated: document.sourceTruncated,
      outlineTruncated: document.outlineTruncated,
      projectionTruncated: document.projectionTruncated,
      genuinelyEmpty: document.genuinelyEmpty,
      totalSections: document.totalSections,
      unreadSections: Math.max(0, sections.length - document.readSectionIds.size),
      sections,
    };
  }

  /** Direct detail read for one host-issued exact anchor; no search or ranking. */
  async readExactAnchor(input: unknown): Promise<BoundEntityReadOutputV1> {
    this.#beforeContentOperation?.();
    const decoded = decodeBoundEntityReadInputV1(input);
    this.budget.beginPtc(decoded);
    const output = await this.#gate.run(this.signal, async () => {
      const exact = this.#exactAnchorBindings.get(decoded.anchorRef);
      if (!exact) {
        throw new ResearchContractError(
          "invalid-request",
          "The exact-anchor reference is unknown or belongs to another turn.",
        );
      }
      this.budget.beginDetail(exact.product);
      const retained = await this.#readRetainedExactEvidence(exact);
      if (retained) return retained;
      if (exact.product === "jira") {
        const detail = await this.#providers.jira.getIssue({
          issueKey: exact.entityId,
          ...(this.#exactAuxiliaryNeeds.has("comments") ? { includeComments: true } : {}),
          ...(this.#exactAuxiliaryNeeds.has("metadata") ? { includeMetadata: true } : {}),
          signal: this.signal,
        });
        const allowedProjects = this.#request.scope.jiraProjectKeys;
        if (
          detail.issueKey !== exact.entityId ||
          (allowedProjects.length > 0 && !allowedProjects.includes(detail.projectKey))
        ) {
          throw new ResearchContractError("access-denied", "Jira detail does not match the bound entity.");
        }
        const source = this.#jiraSource(detail);
        await this.#registerObservedConfluenceReferences(detail.content, source.id);
        await this.#recordDetailEvidence(source, detail.content, {
          sourceId: source.id,
          reason: "exact_anchor",
          rank: 1,
        });
        return {
          schema: BOUND_ENTITY_READ_OUTPUT_SCHEMA_V1,
          source: publicSource(source),
          content: detail.content,
          relatedAnchors: this.exactAnchors().filter((anchor) =>
            anchor.product === "confluence"
          ),
          budget: this.budget.snapshot(),
        };
      }

      const detail = await this.#providers.wiki.getPage({
        contentId: exact.entityId,
        ...(this.#exactAuxiliaryNeeds.has("comments") ? { includeComments: true } : {}),
        ...(this.#exactAuxiliaryNeeds.has("metadata") ? { includeMetadata: true } : {}),
        signal: this.signal,
      });
      const allowedSpaces = this.#request.scope.confluenceSpaceKeys;
      if (
        detail.contentId !== exact.entityId ||
        (allowedSpaces.length > 0 && !allowedSpaces.includes(detail.spaceKey))
      ) {
        throw new ResearchContractError(
          "access-denied",
          "Confluence detail does not match the bound entity.",
        );
      }
      const source = this.#wikiSource(detail);
      const visibleContent = navigableInitialProjection(detail.content, detail.navigation);
      this.#registerObservedJiraReferences(visibleContent);
      const document = this.#registerExactDocument(
        source,
        detail.navigation,
        visibleContent.truncated,
      );
      await this.#recordDetailEvidence(source, visibleContent, {
        sourceId: source.id,
        reason: "exact_anchor",
        rank: 1,
      }, source.id, undefined, document
        ? {
            snapshot: { ...document.snapshot },
            issues: [...document.coverageIssues],
            sourceTruncated: document.sourceTruncated,
            outlineTruncated: document.outlineTruncated,
            projectionTruncated: document.projectionTruncated,
            unreadSections: document.unreadSections,
            completeDocumentRead: document.coverageIssues.length === 0 &&
              !document.sourceTruncated &&
              !document.outlineTruncated &&
              !document.projectionTruncated,
          }
        : {
            issues: visibleContent.truncated ? ["projection_limit"] : [],
            sourceTruncated: false,
            outlineTruncated: false,
            projectionTruncated: visibleContent.truncated,
            unreadSections: 0,
            completeDocumentRead: !visibleContent.truncated,
          });
      return {
        schema: BOUND_ENTITY_READ_OUTPUT_SCHEMA_V1,
        source: publicSource(source),
        content: visibleContent,
        relatedAnchors: this.exactAnchors().filter((anchor) => anchor.product === "jira"),
        ...(document ? { document } : {}),
        budget: this.budget.snapshot(),
      };
    });
    this.budget.completePtc(output);
    return output;
  }

  /** Read one section from the verified page snapshot through an opaque turn-local ref. */
  async readExactSection(input: unknown): Promise<BoundEntitySectionReadOutputV1> {
    this.#beforeContentOperation?.();
    const decoded = decodeBoundEntitySectionReadInputV1(input);
    this.budget.beginPtc(decoded);
    const output = await this.#gate.run(this.signal, async () => {
      const bound = this.#exactSectionBindings.get(decoded.sectionRef);
      if (!bound) {
        throw new ResearchContractError(
          "invalid-request",
          "The exact-section reference is unknown or belongs to another turn.",
        );
      }
      const { document, section } = bound;
      document.readSectionIds.add(section.sectionId);
      this.#readSectionReferences.set(`${document.source.id}#${section.sectionId}`, {
        sourceId: document.source.id,
        sectionId: section.sectionId,
        heading: section.heading,
        order: section.order,
      });
      this.#registerObservedJiraReferences(section.content);
      const evidenceId = await this.#recordDetailEvidence(
        document.source,
        section.content,
        {
          sourceId: document.source.id,
          reason: "exact_anchor",
          rank: section.order + 1,
        },
        `${document.source.id}#${section.sectionId}`,
        {
          sectionId: section.sectionId,
          heading: section.heading,
          order: section.order,
        },
        {
          snapshot: { ...document.snapshot },
          issues: [...document.coverageIssues],
          sourceTruncated: document.sourceTruncated,
          outlineTruncated: document.outlineTruncated,
          projectionTruncated: section.content.truncated,
          unreadSections: Math.max(
            0,
            document.sectionRefs.length - document.readSectionIds.size,
          ),
          completeDocumentRead: document.coverageIssues.length === 0 &&
            !document.sourceTruncated &&
            !document.outlineTruncated &&
            (!document.projectionTruncated ||
              document.sectionRefs.length === document.readSectionIds.size),
        },
      );
      const unreadSections = Math.max(
        0,
        document.sectionRefs.length - document.readSectionIds.size,
      );
      const completeDocumentRead = document.coverageIssues.length === 0 &&
        !document.sourceTruncated &&
        !document.outlineTruncated &&
        (!document.projectionTruncated || unreadSections === 0);
      return {
        schema: BOUND_ENTITY_SECTION_READ_OUTPUT_SCHEMA_V1,
        source: publicSource(document.source),
        section: {
          sectionId: section.sectionId,
          heading: section.heading,
          level: section.level,
          order: section.order,
          contentBytes: section.contentBytes,
        },
        content: {
          ...section.content,
          linkTargets: [...section.content.linkTargets],
        },
        support: {
          sectionId: section.sectionId,
          start: 0,
          end: section.content.text.length,
          ...(evidenceId ? { evidenceId } : {}),
        },
        coverage: {
          snapshot: { ...document.snapshot },
          issues: [...document.coverageIssues],
          sourceTruncated: document.sourceTruncated,
          outlineTruncated: document.outlineTruncated,
          projectionTruncated: section.content.truncated,
          unreadSections,
          completeDocumentRead,
        },
        relatedAnchors: this.exactAnchors().filter((anchor) => anchor.product === "jira"),
        budget: this.budget.snapshot(),
      };
    });
    this.budget.completePtc(output);
    return output;
  }

  /**
   * Re-read retained evidence that would otherwise outlive the configured
   * freshness interval. This is host-only: it uses the original approved
   * provider/scope path, never creates a PTC capability, and never returns a
   * source body. A failed revalidation invalidates dependent claims so the
   * deterministic report finalizer excludes them rather than treating an old
   * body as current.
   */
  async revalidateRetainedEvidence(input: {
    evidenceIds: readonly string[];
    checkedAt: string;
  }): Promise<ResearchEvidenceRevalidationOutcomeV1> {
    if (!this.#evidence?.claimLedger) {
      throw new ResearchContractError(
        "invalid-request",
        "Retained evidence revalidation requires a durable evidence and claim store.",
      );
    }
    const checkedAtMs = Date.parse(input.checkedAt);
    if (!Number.isFinite(checkedAtMs)) {
      throw new ResearchContractError("invalid-request", "Evidence revalidation time is invalid.");
    }
    const evidenceIds = [...new Set(input.evidenceIds)].sort();
    const outcome: ResearchEvidenceRevalidationOutcomeV1 = {
      considered: 0,
      fresh: 0,
      revalidated: 0,
      invalidated: 0,
    };
    for (const evidenceId of evidenceIds) {
      const retained = await this.#evidence.store.get(evidenceId);
      if (!retained) {
        await this.#evidence.claimLedger.invalidateByEvidenceIds({
          evidenceIds: [evidenceId],
          at: input.checkedAt,
          reason: "evidence_missing",
        });
        outcome.invalidated += 1;
        continue;
      }
      outcome.considered += 1;
      const capturedAtMs = Date.parse(retained.version.capturedAt);
      if (checkedAtMs - capturedAtMs <= this.#request.limits.maxEvidenceAgeMs) {
        outcome.fresh += 1;
        continue;
      }

      try {
        await this.#gate.run(this.signal, async () => {
          this.budget.beginDetail(retained.identity.product);
          if (retained.identity.product === "jira") {
            const issueKey = retained.identity.entityId;
            const detail = await this.#providers.jira.getIssue({ issueKey, signal: this.signal });
            if (detail.issueKey !== issueKey) {
              throw new ResearchContractError("provider-error", "Jira revalidation returned a different issue.");
            }
            const source = this.#jiraSource(detail);
            if (source.id !== retained.source.id) {
              throw new ResearchContractError("provider-error", "Jira revalidation source identity changed.");
            }
            await this.#recordDetailEvidence(source, detail.content, retained.retrieval);
            return;
          }

          const contentId = retained.identity.entityId;
          const detail = await this.#providers.wiki.getPage({ contentId, signal: this.signal });
          if (detail.contentId !== contentId) {
            throw new ResearchContractError("provider-error", "Confluence revalidation returned a different page.");
          }
          const source = this.#wikiSource(detail);
          if (source.id !== retained.source.id) {
            throw new ResearchContractError("provider-error", "Confluence revalidation source identity changed.");
          }
          await this.#recordDetailEvidence(source, detail.content, retained.retrieval);
        });
        outcome.revalidated += 1;
      } catch (error) {
        await this.#evidence.claimLedger.invalidateByEvidenceIds({
          evidenceIds: [retained.id],
          at: input.checkedAt,
          reason: error instanceof ResearchContractError && error.code === "access-denied"
            ? "scope_revoked"
            : "provider_unavailable",
        });
        outcome.invalidated += 1;
      }
    }
    return outcome;
  }

  /**
   * Host-only signal for the next retrieval wave. It contains no source body,
   * title, query, URL, or opaque entity ref, so callers can persist or stream
   * the decision without turning it into an additional data-access surface.
   */
  retrievalAssessment(
    products: readonly ResearchProduct[] = ["jira", "confluence"],
    priorAcceptedSourceIds: readonly string[] = [],
    options: {
      /**
       * Host-validated brief coverage targets still unmet by accepted packets.
       * The broker persists only their opaque IDs in its body-free assessment.
       */
      unresolvedCoverageTargetIds?: readonly string[];
      /** Host-validated contradiction IDs still needing a bounded response. */
      unresolvedContradictionIds?: readonly string[];
    } = {},
  ): ResearchRetrievalAssessmentV1 {
    const selectedProducts = [...new Set(products)];
    if (selectedProducts.length === 0 || selectedProducts.some((product) =>
      product !== "jira" && product !== "confluence",
    )) {
      throw new ResearchContractError("invalid-request", "Retrieval assessment products are invalid.");
    }
    const snapshot = this.budget.snapshot();
    return assessResearchRetrievalV1({
      products: selectedProducts.map((product) => ({
        product,
        rankedSourceIds: [...this.#rankedEntityRefs.values()]
          .filter((entry) => entry.product === product)
          .map((entry) => entry.retrieval.sourceId),
        detailedSourceIds: this.#successfulDetailReads
          .filter((entry) => entry.product === product)
          .map((entry) => entry.sourceId),
        searchAttempted: this.#searchAttempts[product] > 0,
        searchComplete: this.#searchCompletion[product].complete,
        canSearchMore: this.budget.canSearchAnotherPage(product),
        canReadMoreDetails: this.budget.canReadAnotherDetail(product),
      })),
      priorAcceptedSourceIds: [...priorAcceptedSourceIds],
      unresolvedCoverageTargetIds: [...(options.unresolvedCoverageTargetIds ?? [])],
      unresolvedContradictionIds: [...(options.unresolvedContradictionIds ?? [])],
      ptcCallsRemaining: snapshot.ptcRemaining,
      httpAttemptsRemaining: snapshot.httpAttemptsRemaining,
    });
  }

  async #recordDetailEvidence(
    source: ResearchSourceReferenceV1,
    content: BoundedContentProjectionV1,
    retrieval: ResearchEvidenceRetrievalV1 | undefined,
    ledgerKey = source.id,
    section?: ResearchDetailEvidenceV1["section"],
    coverage?: ResearchDetailEvidenceV1["coverage"],
  ): Promise<string | undefined> {
    let evidenceId: string | undefined;
    if (this.#evidence) {
      const evidence = await createResearchEvidenceRecordV1({
        source,
        content,
        scope: this.#request.scope,
        scopeBindings: this.#scopeBindings,
        capturedAt: this.#evidence.capturedAt?.() ?? new Date().toISOString(),
        retrieval,
      });
      const priorVersions = await this.#evidence.store.recordsForCanonicalIdentity(
        evidence.record.identity.canonicalId,
      );
      const supersededEvidenceIds = priorVersions
        .map((record) => record.id)
        .filter((id) => id !== evidence.record.id);
      // Invalidate before publishing the new version. A write interruption may
      // be conservative, but it can never leave an older claim current after
      // the host has observed a changed provider version.
      if (supersededEvidenceIds.length > 0 && this.#evidence.claimLedger) {
        await this.#evidence.claimLedger.invalidateByEvidenceIds({
          evidenceIds: supersededEvidenceIds,
          at: evidence.record.version.capturedAt,
          reason: "evidence_changed",
        });
      }
      await this.#evidence.store.put(evidence.record, evidence.chunks);
      evidenceId = evidence.record.id;
    }
    this.#detailEvidence.set(ledgerKey, {
      source,
      content: {
        ...content,
        linkTargets: [...content.linkTargets],
      },
      ...(retrieval ? { retrieval: { ...retrieval } } : {}),
      ...(evidenceId === undefined ? {} : { evidenceId }),
      ...(section ? { section: { ...section } } : {}),
      ...(coverage ? {
        coverage: {
          ...coverage,
          issues: [...coverage.issues],
          ...(coverage.snapshot ? { snapshot: { ...coverage.snapshot } } : {}),
        },
      } : {}),
    });
    this.#successfulDetailReads.push({ product: source.product, sourceId: source.id });
    return evidenceId;
  }

  /**
   * The dynamic supervisor may omit an entire product branch.  Completion is
   * therefore judged only against the product searches actually admitted to
   * the accepted graph; legacy callers retain the conservative two-product
   * default.
   */
  completionStatus(products: readonly ResearchProduct[] = ["jira", "confluence"]): {
    complete: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];
    for (const product of new Set(products)) {
      const status = this.#searchCompletion[product];
      if (status.complete) continue;
      const label = product === "jira" ? "Jira" : "Confluence";
      warnings.push(
        status.termination
          ? `${label} search incomplete: ${status.termination}.`
          : `${label} search did not reach a terminal page.`
      );
    }
    return { complete: warnings.length === 0, warnings };
  }

  async invoke(tool: ResearchToolId, input: unknown): Promise<unknown> {
    this.#beforeContentOperation?.();
    if (!RESEARCH_TOOL_IDS.includes(tool)) {
      throw new ResearchContractError("invalid-request", "Unknown research capability.");
    }
    this.budget.beginPtc(input);
    const output = await this.#gate.run(this.signal, async () => {
      switch (tool) {
        case "jira.issue.search":
          return this.#searchJira(input);
        case "jira.issue.get":
          return this.#getJira(input);
        case "wiki.search":
          return this.#searchWiki(input);
        case "wiki.page.get":
          return this.#getWiki(input);
        case "research.candidate.rank":
          return this.#rankCandidates(input);
      }
    });
    this.budget.completePtc(output);
    return output;
  }

  async #searchJira(input: unknown): Promise<ResearchSearchOutputV1> {
    const decoded = decodeResearchSearchInputV1(
      "jira.issue.search",
      input,
      this.#request.limits.pageSize
    );
    let query: ResearchSearchQueryV1;
    let pageSize: number;
    let providerCursor: string | undefined;
    let cursorChain: ResearchCursorChain | undefined;
    if ("cursor" in decoded) {
      const resolved = this.#cursorVault.resolve("jira.issue.search", decoded.cursor)!;
      const state = parseResearchQueryFingerprint(resolved.queryFingerprint);
      if (state.tool !== "jira.issue.search") {
        throw new ResearchContractError("invalid-request", "Cursor query is invalid.");
      }
      query = state.query;
      pageSize = state.pageSize;
      providerCursor = resolved.providerCursor;
      cursorChain = resolved.chain;
    } else {
      query = decoded.query;
      pageSize = decoded.pageSize ?? this.#request.limits.pageSize;
    }
    return this.#searchJiraPage(query, pageSize, providerCursor, cursorChain);
  }

  async #searchJiraPage(
    query: ResearchSearchQueryV1,
    pageSize: number,
    providerCursor?: string,
    cursorChain?: ResearchCursorChain,
  ): Promise<ResearchSearchOutputV1> {
    this.#searchAttempts.jira += 1;
    this.budget.beginSearchPage("jira");
    const exact = providerCursor ? [] : this.#exactJiraSummaries();
    if (
      this.#request.scope.jiraProjectKeys.length === 0 ||
      (this.#request.exactContextProducts?.includes("jira") === true && exact.length > 0)
    ) {
      const remaining = this.budget.remainingItems("jira");
      const items = exact.slice(0, remaining);
      this.budget.addItems("jira", items.length);
      return this.#searchOutput(
        "jira.issue.search",
        query,
        pageSize,
        items,
        undefined,
        exact.length > items.length ? "item-limit" : undefined,
      );
    }
    const page = await this.#providers.jira.searchPage({
      jql: buildResearchJql(this.#request.scope, query),
      pageSize,
      providerCursor,
      signal: this.signal,
    });
    const scoped = page.items.filter(
      (item) =>
        this.#request.scope.jiraProjectKeys.includes(item.projectKey) &&
        item.issueKey.startsWith(`${item.projectKey}-`)
    );
    const remaining = this.budget.remainingItems("jira");
    const accepted = [...exact, ...scoped
      .filter((item) => !exact.some((candidate) => candidate.issueKey === item.issueKey))
      .map((item) => this.#jiraSummary(item))]
      .slice(0, remaining);
    this.budget.addItems("jira", accepted.length);
    return this.#searchOutput(
      "jira.issue.search",
      query,
      pageSize,
      accepted,
      page.nextProviderCursor,
      remaining <= accepted.length ? "item-limit" : undefined,
      cursorChain,
    );
  }

  async #searchWiki(input: unknown): Promise<ResearchSearchOutputV1> {
    const decoded = decodeResearchSearchInputV1(
      "wiki.search",
      input,
      this.#request.limits.pageSize
    );
    let query: ResearchSearchQueryV1;
    let pageSize: number;
    let providerCursor: string | undefined;
    let cursorChain: ResearchCursorChain | undefined;
    if ("cursor" in decoded) {
      const resolved = this.#cursorVault.resolve("wiki.search", decoded.cursor)!;
      const state = parseResearchQueryFingerprint(resolved.queryFingerprint);
      if (state.tool !== "wiki.search") {
        throw new ResearchContractError("invalid-request", "Cursor query is invalid.");
      }
      query = state.query;
      pageSize = state.pageSize;
      providerCursor = resolved.providerCursor;
      cursorChain = resolved.chain;
    } else {
      query = decoded.query;
      pageSize = decoded.pageSize ?? this.#request.limits.pageSize;
    }
    this.#searchAttempts.confluence += 1;
    this.budget.beginSearchPage("confluence");
    const exact = providerCursor ? [] : this.#exactWikiSummaries();
    if (
      this.#request.scope.confluenceSpaceKeys.length === 0 ||
      (this.#request.exactContextProducts?.includes("confluence") === true && exact.length > 0)
    ) {
      const remaining = this.budget.remainingItems("confluence");
      const items = exact.slice(0, remaining);
      this.budget.addItems("confluence", items.length);
      return this.#searchOutput(
        "wiki.search",
        query,
        pageSize,
        items,
        undefined,
        exact.length > items.length ? "item-limit" : undefined,
      );
    }
    const page = await this.#providers.wiki.searchPage({
      cql: buildResearchCql(this.#request.scope, query),
      pageSize,
      providerCursor,
      signal: this.signal,
    });
    const scoped = page.items.filter((item) =>
      this.#request.scope.confluenceSpaceKeys.includes(item.spaceKey)
    );
    const remaining = this.budget.remainingItems("confluence");
    const accepted = [...exact, ...scoped
      .filter((item) => !exact.some((candidate) => candidate.contentId === item.contentId))
      .map((item) => this.#wikiSummary(item))]
      .slice(0, remaining);
    this.budget.addItems("confluence", accepted.length);
    return this.#searchOutput(
      "wiki.search",
      query,
      pageSize,
      accepted,
      page.nextProviderCursor,
      remaining <= accepted.length ? "item-limit" : undefined,
      cursorChain,
    );
  }

  #searchOutput(
    tool: "jira.issue.search" | "wiki.search",
    query: ResearchSearchQueryV1,
    pageSize: number,
    items: ResearchEntitySummaryV1[],
    nextProviderCursor: string | undefined,
    forcedTermination: ResearchTerminationCode | undefined,
    cursorChain?: ResearchCursorChain,
  ): ResearchSearchOutputV1 {
    const product = tool === "jira.issue.search" ? "jira" : "confluence";
    const pageLimit = !this.budget.canSearchAnotherPage(product);
    const termination = forcedTermination ?? (pageLimit ? "page-limit" : undefined);
    const nextCursor =
      nextProviderCursor && !termination
        ? this.#cursorVault.issue(
            tool,
            researchQueryFingerprint(tool, query, pageSize),
            nextProviderCursor,
            cursorChain,
          )
        : undefined;
    const page: ResearchSearchOutputV1["page"] = nextCursor
      ? { nextCursor, complete: false }
      : nextProviderCursor
        ? { complete: false, termination: termination ?? "item-limit" }
        : { complete: true, termination: "index-exhausted" };
    this.#searchCompletion[product] = {
      complete: page.complete,
      ...(page.termination ? { termination: page.termination } : {}),
    };
    return {
      schema: RESEARCH_CAPABILITY_SCHEMAS[tool].output,
      items,
      page,
      budget: this.budget.snapshot(),
    };
  }

  #jiraSummary(item: JiraResearchSummary): ResearchEntitySummaryV1 {
    const entityRef = this.#entityVault.issue({
      kind: "jira",
      entityId: item.issueKey,
      projectKey: item.projectKey,
    });
    const source = this.#jiraSource(item);
    return {
      ...publicSource(source),
      entityRef,
      ...(source.excerpt ? { excerpt: source.excerpt } : {}),
    };
  }

  #jiraSource(item: JiraResearchSummary): ResearchSourceReferenceV1 {
    const sourceId = `jira:${item.issueKey}`;
    const source: ResearchSourceReferenceV1 = {
      id: sourceId,
      product: "jira",
      title: cleanOptionalText(item.title, 2_000) ?? item.issueKey,
      url: `${this.#request.scope.siteOrigin}/browse/${encodeURIComponent(item.issueKey)}`,
      issueKey: item.issueKey,
      projectKey: item.projectKey,
      ...(cleanOptionalText(item.excerpt, 2_000)
        ? { excerpt: cleanOptionalText(item.excerpt, 2_000) }
        : {}),
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    };
    this.#sources.set(sourceId, source);
    return source;
  }

  #wikiSummary(item: WikiResearchSummary): ResearchEntitySummaryV1 {
    const entityRef = this.#entityVault.issue({
      kind: "wiki",
      entityId: item.contentId,
      spaceKey: item.spaceKey,
    });
    const source = this.#wikiSource(item);
    return {
      ...publicSource(source),
      entityRef,
      ...(source.excerpt ? { excerpt: source.excerpt } : {}),
    };
  }

  #wikiSource(item: WikiResearchSummary): ResearchSourceReferenceV1 {
    const sourceId = `wiki:${item.contentId}`;
    const source: ResearchSourceReferenceV1 = {
      id: sourceId,
      product: "confluence",
      title: cleanOptionalText(item.title, 2_000) ?? item.contentId,
      url: `${this.#request.scope.siteOrigin}/wiki/spaces/${encodeURIComponent(
        item.spaceKey
      )}/pages/${encodeURIComponent(item.contentId)}`,
      contentId: item.contentId,
      spaceKey: item.spaceKey,
      ...(cleanOptionalText(item.excerpt, 2_000)
        ? { excerpt: cleanOptionalText(item.excerpt, 2_000) }
        : {}),
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    };
    this.#sources.set(sourceId, source);
    return source;
  }

  #exactJiraSummaries(): ResearchEntitySummaryV1[] {
    if (this.#exactSearchEmitted.has("jira")) return [];
    this.#exactSearchEmitted.add("jira");
    return [...this.#exactEntityBindings.values()]
      .filter((entry) => entry.product === "jira")
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .map((entry) => {
        const source: ResearchSourceReferenceV1 = {
          id: `jira:${entry.entityId}`,
          product: "jira",
          title: cleanOptionalText(entry.binding.name, 2_000) ?? entry.entityId,
          url: `${this.#request.scope.siteOrigin}/browse/${encodeURIComponent(entry.entityId)}`,
          issueKey: entry.entityId,
        };
        this.#sources.set(source.id, source);
        return {
          ...publicSource(source),
          entityRef: this.#entityVault.issue({ kind: "jira", entityId: entry.entityId }),
        };
      });
  }

  #exactWikiSummaries(): ResearchEntitySummaryV1[] {
    if (this.#exactSearchEmitted.has("confluence")) return [];
    this.#exactSearchEmitted.add("confluence");
    return [...this.#exactEntityBindings.values()]
      .filter((entry) => entry.product === "confluence")
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .map((entry) => {
        const source: ResearchSourceReferenceV1 = {
          id: `wiki:${entry.entityId}`,
          product: "confluence",
          title: cleanOptionalText(entry.binding.name, 2_000) ?? entry.entityId,
          url: `${this.#request.scope.siteOrigin}/wiki/pages/${encodeURIComponent(entry.entityId)}`,
          contentId: entry.entityId,
        };
        this.#sources.set(source.id, source);
        return {
          ...publicSource(source),
          entityRef: this.#entityVault.issue({ kind: "wiki", entityId: entry.entityId }),
        };
      });
  }

  #rankCandidates(input: unknown): ResearchCandidateRankOutputV1 {
    const decoded = decodeResearchCandidateRankInputV1(
      input,
      this.#request.limits.maxItemsPerProduct,
    );
    const kind = decoded.product === "jira" ? "jira" : "wiki";
    const candidates = decoded.entityRefs.map((entityRef) => {
      const entity = this.#entityVault.resolve(kind, entityRef);
      const sourceId = kind === "jira"
        ? `jira:${entity.entityId}`
        : `wiki:${entity.entityId}`;
      const source = this.#sources.get(sourceId);
      if (!source) {
        throw new ResearchContractError(
          "invalid-request",
          "Candidate reference was not returned by a scoped search.",
        );
      }
      return {
        entityRef,
        sourceId,
        title: source.title,
        ...(source.excerpt ? { excerpt: source.excerpt } : {}),
      };
    });
    const ranked = rankResearchCandidatesV1({
      question: this.#request.question,
      candidates,
    });
    for (const candidate of ranked) {
      this.#rankedEntityRefs.set(candidate.entityRef, {
        product: decoded.product,
        retrieval: {
          sourceId: candidate.sourceId,
          reason: "question_relevance_rank",
          rank: candidate.rank,
        },
      });
    }
    return {
      schema: RESEARCH_CAPABILITY_SCHEMAS["research.candidate.rank"].output,
      items: ranked,
      budget: this.budget.snapshot(),
    };
  }

  async #getJira(input: unknown): Promise<ResearchGetOutputV1> {
    const decoded = decodeResearchGetInputV1("jira.issue.get", input);
    const entity = this.#entityVault.resolve("jira", decoded.entityRef);
    const admission = this.#rankedEntityRefs.get(decoded.entityRef);
    if (!admission || admission.product !== "jira") {
      throw new ResearchContractError(
        "invalid-request",
        "Jira detail requires a candidate reference admitted by research.candidate.rank.",
      );
    }
    this.budget.beginDetail("jira");
    const detail = await this.#providers.jira.getIssue({
      issueKey: entity.entityId,
      includeComments: true,
      includeMetadata: true,
      signal: this.signal,
    });
    const exact = this.#exactEntityBindings.get(`jira:${entity.entityId}`);
    const wholeScope = entity.projectKey !== undefined &&
      detail.projectKey === entity.projectKey &&
      this.#request.scope.jiraProjectKeys.includes(detail.projectKey);
    if (detail.issueKey !== entity.entityId || (!wholeScope && !exact)) {
      throw new ResearchContractError("access-denied", "Jira detail is outside the run scope.");
    }
    const source = this.#jiraSource(detail);
    if (admission.retrieval.sourceId !== source.id) {
      throw new ResearchContractError("provider-error", "Jira ranked candidate does not match its detail source.");
    }
    await this.#registerObservedConfluenceReferences(detail.content, source.id);
    await this.#recordDetailEvidence(source, detail.content, admission.retrieval);
    return {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].output,
      source: publicSource(source),
      content: detail.content,
      relatedAnchors: this.exactAnchors().filter((anchor) =>
        anchor.product === "confluence"
      ),
      budget: this.budget.snapshot(),
    };
  }

  async #getWiki(input: unknown): Promise<ResearchGetOutputV1> {
    const decoded = decodeResearchGetInputV1("wiki.page.get", input);
    const entity = this.#entityVault.resolve("wiki", decoded.entityRef);
    const admission = this.#rankedEntityRefs.get(decoded.entityRef);
    if (!admission || admission.product !== "confluence") {
      throw new ResearchContractError(
        "invalid-request",
        "Confluence detail requires a candidate reference admitted by research.candidate.rank.",
      );
    }
    this.budget.beginDetail("confluence");
    const detail = await this.#providers.wiki.getPage({
      contentId: entity.entityId,
      ...(decoded.includeComments ? { includeComments: true } : {}),
      includeMetadata: true,
      signal: this.signal,
    });
    const exact = this.#exactEntityBindings.get(`confluence:${entity.entityId}`);
    const wholeScope = entity.spaceKey !== undefined &&
      detail.spaceKey === entity.spaceKey &&
      this.#request.scope.confluenceSpaceKeys.includes(detail.spaceKey);
    if (detail.contentId !== entity.entityId || (!wholeScope && !exact)) {
      throw new ResearchContractError(
        "access-denied",
        "Confluence detail is outside the run scope."
      );
    }
    const source = this.#wikiSource(detail);
    if (admission.retrieval.sourceId !== source.id) {
      throw new ResearchContractError("provider-error", "Confluence ranked candidate does not match its detail source.");
    }
    this.#registerObservedJiraReferences(detail.content);
    await this.#recordDetailEvidence(source, detail.content, admission.retrieval);
    return {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.page.get"].output,
      source: publicSource(source),
      content: detail.content,
      relatedAnchors: this.exactAnchors().filter((anchor) => anchor.product === "jira"),
      budget: this.budget.snapshot(),
    };
  }
}
