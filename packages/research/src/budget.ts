import {
  ResearchContractError,
  type ResearchLimitsV1,
  type ResearchProduct,
  type ResearchRunCountsV1,
} from "./contracts.js";
import type { ResearchBudgetSnapshotV1 } from "./capability-contracts.js";

type TransportBudgetEvent =
  | { type: "attempt" }
  | { type: "response"; responseBytes: number }
  | { type: "error" };

/**
 * Body-free counters needed to continue a bounded run after its process or
 * service worker has gone away. Provider cursors and response content are
 * deliberately not part of this durable projection.
 */
export interface ResearchRunBudgetStateV1 {
  schema: "atlcli.research-run-budget/v1";
  ptcCalls: number;
  httpAttempts: number;
  responseBytes: number;
  pages: Record<ResearchProduct, number>;
  items: Record<ResearchProduct, number>;
  details: Record<ResearchProduct, number>;
}

const RESEARCH_RUN_BUDGET_SCHEMA_V1 = "atlcli.research-run-budget/v1" as const;

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  return value as number;
}

function productCounts(
  value: unknown,
  label: string,
): Record<ResearchProduct, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !("jira" in record) || !("confluence" in record)) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  return {
    jira: nonNegativeInteger(record.jira, `${label}.jira`),
    confluence: nonNegativeInteger(record.confluence, `${label}.confluence`),
  };
}

/** Validate a portable budget projection, optionally against one run's limits. */
export function parseResearchRunBudgetStateV1(
  value: unknown,
  limits?: ResearchLimitsV1,
): ResearchRunBudgetStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchContractError("invalid-request", "Research run budget state is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== RESEARCH_RUN_BUDGET_SCHEMA_V1 ||
      Object.keys(record).length !== 7) {
    throw new ResearchContractError("invalid-request", "Research run budget state is invalid.");
  }
  const parsed: ResearchRunBudgetStateV1 = {
    schema: RESEARCH_RUN_BUDGET_SCHEMA_V1,
    ptcCalls: nonNegativeInteger(record.ptcCalls, "Research run PTC calls"),
    httpAttempts: nonNegativeInteger(record.httpAttempts, "Research run HTTP attempts"),
    responseBytes: nonNegativeInteger(record.responseBytes, "Research run response bytes"),
    pages: productCounts(record.pages, "Research run page counters"),
    items: productCounts(record.items, "Research run item counters"),
    details: productCounts(record.details, "Research run detail counters"),
  };
  if (limits && (
    parsed.ptcCalls > limits.maxPtcCalls ||
    parsed.httpAttempts > limits.maxHttpCalls ||
    parsed.responseBytes > limits.maxTotalResponseBytes ||
    Object.values(parsed.pages).some((count) => count > limits.maxSearchPagesPerProduct) ||
    Object.values(parsed.items).some((count) => count > limits.maxItemsPerProduct) ||
    Object.values(parsed.details).some((count) => count > limits.maxDetailItemsPerProduct)
  )) {
    throw new ResearchContractError("invalid-request", "Research run budget state exceeds this run's limits.");
  }
  return structuredClone(parsed);
}

function encodedJsonBytes(value: unknown, label: string): number {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ResearchContractError("invalid-request", `${label} is not JSON-safe.`);
  }
  if (encoded === undefined) {
    throw new ResearchContractError("invalid-request", `${label} is not JSON-safe.`);
  }
  return new TextEncoder().encode(encoded).byteLength;
}

/**
 * Mutable counters for exactly one research run.
 *
 * Invalid PTC inputs count before decoding. HTTP retries count through the
 * clients' synchronous transport guard, so an exhausted budget stops before
 * the next fetch rather than merely reporting an overrun afterwards.
 */
export class ResearchRunBudget {
  readonly #limits: ResearchLimitsV1;
  #ptcCalls = 0;
  #httpAttempts = 0;
  #responseBytes = 0;
  readonly #pages: Record<ResearchProduct, number> = { jira: 0, confluence: 0 };
  readonly #items: Record<ResearchProduct, number> = { jira: 0, confluence: 0 };
  readonly #details: Record<ResearchProduct, number> = { jira: 0, confluence: 0 };

  constructor(limits: ResearchLimitsV1) {
    this.#limits = limits;
  }

  /** Restore one checkpoint before the next provider call; restoring twice is unsafe. */
  restore(state: ResearchRunBudgetStateV1): void {
    if (this.#ptcCalls !== 0 || this.#httpAttempts !== 0 || this.#responseBytes !== 0 ||
        Object.values(this.#pages).some((count) => count !== 0) ||
        Object.values(this.#items).some((count) => count !== 0) ||
        Object.values(this.#details).some((count) => count !== 0)) {
      throw new ResearchContractError("invalid-request", "Research run budget may be restored only once before use.");
    }
    const restored = parseResearchRunBudgetStateV1(state, this.#limits);
    this.#ptcCalls = restored.ptcCalls;
    this.#httpAttempts = restored.httpAttempts;
    this.#responseBytes = restored.responseBytes;
    Object.assign(this.#pages, restored.pages);
    Object.assign(this.#items, restored.items);
    Object.assign(this.#details, restored.details);
  }

  state(): ResearchRunBudgetStateV1 {
    return {
      schema: RESEARCH_RUN_BUDGET_SCHEMA_V1,
      ptcCalls: this.#ptcCalls,
      httpAttempts: this.#httpAttempts,
      responseBytes: this.#responseBytes,
      pages: { ...this.#pages },
      items: { ...this.#items },
      details: { ...this.#details },
    };
  }

  beginPtc(input: unknown): void {
    this.#ptcCalls += 1;
    if (this.#ptcCalls > this.#limits.maxPtcCalls) {
      throw new ResearchContractError("limit-exceeded", "The PTC call budget was exhausted.");
    }
    if (encodedJsonBytes(input, "PTC input") > this.#limits.maxPtcInputBytes) {
      throw new ResearchContractError("limit-exceeded", "The PTC input byte limit was exceeded.");
    }
  }

  completePtc(output: unknown): void {
    if (encodedJsonBytes(output, "PTC output") > this.#limits.maxPtcOutputBytes) {
      throw new ResearchContractError("limit-exceeded", "The PTC output byte limit was exceeded.");
    }
  }

  guardTransport(event: TransportBudgetEvent): void {
    if (event.type === "attempt") {
      this.#httpAttempts += 1;
      if (this.#httpAttempts > this.#limits.maxHttpCalls) {
        throw new ResearchContractError(
          "limit-exceeded",
          "The HTTP attempt budget was exhausted."
        );
      }
      return;
    }
    if (event.type === "response") {
      this.#responseBytes += event.responseBytes;
      if (this.#responseBytes > this.#limits.maxTotalResponseBytes) {
        throw new ResearchContractError(
          "limit-exceeded",
          "The response byte budget was exhausted."
        );
      }
    }
  }

  beginSearchPage(product: ResearchProduct): void {
    this.#pages[product] += 1;
    if (this.#pages[product] > this.#limits.maxSearchPagesPerProduct) {
      throw new ResearchContractError(
        "limit-exceeded",
        `The ${product} search page budget was exhausted.`
      );
    }
  }

  canSearchAnotherPage(product: ResearchProduct): boolean {
    return this.#pages[product] < this.#limits.maxSearchPagesPerProduct;
  }

  canReadAnotherDetail(product: ResearchProduct): boolean {
    return this.#details[product] < this.#limits.maxDetailItemsPerProduct;
  }

  remainingItems(product: ResearchProduct): number {
    return Math.max(0, this.#limits.maxItemsPerProduct - this.#items[product]);
  }

  addItems(product: ResearchProduct, count: number): void {
    this.#items[product] += count;
    if (this.#items[product] > this.#limits.maxItemsPerProduct) {
      throw new ResearchContractError(
        "limit-exceeded",
        `The ${product} item budget was exceeded.`
      );
    }
  }

  beginDetail(product: ResearchProduct): void {
    this.#details[product] += 1;
    if (this.#details[product] > this.#limits.maxDetailItemsPerProduct) {
      throw new ResearchContractError(
        "limit-exceeded",
        `The ${product} detail budget was exhausted.`
      );
    }
  }

  snapshot(): ResearchBudgetSnapshotV1 {
    return {
      ptcRemaining: Math.max(0, this.#limits.maxPtcCalls - this.#ptcCalls),
      httpAttemptsRemaining: Math.max(
        0,
        this.#limits.maxHttpCalls - this.#httpAttempts
      ),
      responseBytesRemaining: Math.max(
        0,
        this.#limits.maxTotalResponseBytes - this.#responseBytes
      ),
    };
  }

  counts(): ResearchRunCountsV1 {
    return {
      ptcCalls: this.#ptcCalls,
      httpCalls: this.#httpAttempts,
      jiraItems: this.#items.jira,
      confluenceItems: this.#items.confluence,
    };
  }
}
