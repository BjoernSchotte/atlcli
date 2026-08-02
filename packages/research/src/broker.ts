import {
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
  decodeResearchGetInputV1,
  decodeResearchSearchInputV1,
  type BoundedContentProjectionV1,
  type ResearchEntitySummaryV1,
  type ResearchGetOutputV1,
  type ResearchSearchOutputV1,
  type ResearchSearchQueryV1,
  type ResearchTerminationCode,
} from "./capability-contracts.js";
import { ResearchRunBudget } from "./budget.js";
import { ResearchCursorVault } from "./cursor-vault.js";
import { ResearchEntityVault } from "./entity-vault.js";
import {
  createResearchEvidenceRecordV1,
  type ResearchEvidenceStoreV1,
} from "./evidence-store.js";
import type { ResearchClaimLedgerV1 } from "./claim-ledger.js";
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
      signal: AbortSignal;
    }): Promise<WikiResearchDetail>;
  };
}

export interface ResearchDetailEvidenceV1 {
  source: ResearchSourceReferenceV1;
  content: BoundedContentProjectionV1;
  /** Present only when the detail is durably retained under an approved binding. */
  evidenceId?: string;
}

interface BrokerOptions {
  createCursorId?: () => string;
  createEntityId?: () => string;
  budget?: ResearchRunBudget;
  /** Optional private evidence sink for durable session-backed detail reads. */
  evidence?: {
    store: ResearchEvidenceStoreV1;
    claimLedger?: ResearchClaimLedgerV1;
    scopeBindings: readonly ResearchScopeBindingV1[];
    capturedAt?: () => string;
  };
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

export class ResearchCapabilityBroker {
  readonly budget: ResearchRunBudget;
  readonly #request: ResearchRequestV1;
  readonly #providers: ResearchReadProviders;
  readonly #cursorVault: ResearchCursorVault;
  readonly #entityVault: ResearchEntityVault;
  readonly #gate: ConcurrencyGate;
  readonly #sources = new Map<string, ResearchSourceReferenceV1>();
  readonly #detailEvidence = new Map<string, ResearchDetailEvidenceV1>();
  readonly #evidence?: NonNullable<BrokerOptions["evidence"]>;
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
    this.#evidence = options.evidence;
    this.#gate = new ConcurrencyGate(request.limits.maxConcurrentCalls);
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
      ...(entry.evidenceId === undefined ? {} : { evidenceId: entry.evidenceId }),
    }));
  }

  async #recordDetailEvidence(
    source: ResearchSourceReferenceV1,
    content: BoundedContentProjectionV1,
  ): Promise<void> {
    let evidenceId: string | undefined;
    if (this.#evidence) {
      const evidence = await createResearchEvidenceRecordV1({
        source,
        content,
        scope: this.#request.scope,
        scopeBindings: this.#evidence.scopeBindings,
        capturedAt: this.#evidence.capturedAt?.() ?? new Date().toISOString(),
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
    this.#detailEvidence.set(source.id, {
      source,
      content: {
        ...content,
        linkTargets: [...content.linkTargets],
      },
      ...(evidenceId === undefined ? {} : { evidenceId }),
    });
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
    if ("cursor" in decoded) {
      const resolved = this.#cursorVault.resolve("jira.issue.search", decoded.cursor)!;
      const state = parseResearchQueryFingerprint(resolved.queryFingerprint);
      if (state.tool !== "jira.issue.search") {
        throw new ResearchContractError("invalid-request", "Cursor query is invalid.");
      }
      query = state.query;
      pageSize = state.pageSize;
      providerCursor = resolved.providerCursor;
    } else {
      query = decoded.query;
      pageSize = decoded.pageSize ?? this.#request.limits.pageSize;
    }
    return this.#searchJiraPage(query, pageSize, providerCursor);
  }

  async #searchJiraPage(
    query: ResearchSearchQueryV1,
    pageSize: number,
    providerCursor?: string
  ): Promise<ResearchSearchOutputV1> {
    this.budget.beginSearchPage("jira");
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
    const accepted = scoped.slice(0, remaining);
    this.budget.addItems("jira", accepted.length);
    const items = accepted.map((item) => this.#jiraSummary(item));
    return this.#searchOutput(
      "jira.issue.search",
      query,
      pageSize,
      items,
      page.nextProviderCursor,
      remaining <= accepted.length ? "item-limit" : undefined
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
    if ("cursor" in decoded) {
      const resolved = this.#cursorVault.resolve("wiki.search", decoded.cursor)!;
      const state = parseResearchQueryFingerprint(resolved.queryFingerprint);
      if (state.tool !== "wiki.search") {
        throw new ResearchContractError("invalid-request", "Cursor query is invalid.");
      }
      query = state.query;
      pageSize = state.pageSize;
      providerCursor = resolved.providerCursor;
    } else {
      query = decoded.query;
      pageSize = decoded.pageSize ?? this.#request.limits.pageSize;
    }
    this.budget.beginSearchPage("confluence");
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
    const accepted = scoped.slice(0, remaining);
    this.budget.addItems("confluence", accepted.length);
    const items = accepted.map((item) => this.#wikiSummary(item));
    return this.#searchOutput(
      "wiki.search",
      query,
      pageSize,
      items,
      page.nextProviderCursor,
      remaining <= accepted.length ? "item-limit" : undefined
    );
  }

  #searchOutput(
    tool: "jira.issue.search" | "wiki.search",
    query: ResearchSearchQueryV1,
    pageSize: number,
    items: ResearchEntitySummaryV1[],
    nextProviderCursor: string | undefined,
    forcedTermination: ResearchTerminationCode | undefined
  ): ResearchSearchOutputV1 {
    const product = tool === "jira.issue.search" ? "jira" : "confluence";
    const pageLimit = !this.budget.canSearchAnotherPage(product);
    const termination = forcedTermination ?? (pageLimit ? "page-limit" : undefined);
    const nextCursor =
      nextProviderCursor && !termination
        ? this.#cursorVault.issue(
            tool,
            researchQueryFingerprint(tool, query, pageSize),
            nextProviderCursor
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

  async #getJira(input: unknown): Promise<ResearchGetOutputV1> {
    const decoded = decodeResearchGetInputV1("jira.issue.get", input);
    const entity = this.#entityVault.resolve("jira", decoded.entityRef);
    this.budget.beginDetail("jira");
    const detail = await this.#providers.jira.getIssue({
      issueKey: entity.entityId,
      signal: this.signal,
    });
    if (
      detail.issueKey !== entity.entityId ||
      detail.projectKey !== entity.projectKey ||
      !this.#request.scope.jiraProjectKeys.includes(detail.projectKey)
    ) {
      throw new ResearchContractError("access-denied", "Jira detail is outside the run scope.");
    }
    const source = this.#jiraSource(detail);
    await this.#recordDetailEvidence(source, detail.content);
    return {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].output,
      source: publicSource(source),
      content: detail.content,
      budget: this.budget.snapshot(),
    };
  }

  async #getWiki(input: unknown): Promise<ResearchGetOutputV1> {
    const decoded = decodeResearchGetInputV1("wiki.page.get", input);
    const entity = this.#entityVault.resolve("wiki", decoded.entityRef);
    this.budget.beginDetail("confluence");
    const detail = await this.#providers.wiki.getPage({
      contentId: entity.entityId,
      signal: this.signal,
    });
    if (
      detail.contentId !== entity.entityId ||
      detail.spaceKey !== entity.spaceKey ||
      !this.#request.scope.confluenceSpaceKeys.includes(detail.spaceKey)
    ) {
      throw new ResearchContractError(
        "access-denied",
        "Confluence detail is outside the run scope."
      );
    }
    const source = this.#wikiSource(detail);
    await this.#recordDetailEvidence(source, detail.content);
    return {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.page.get"].output,
      source: publicSource(source),
      content: detail.content,
      budget: this.budget.snapshot(),
    };
  }
}
