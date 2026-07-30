import {
  ResearchContractError,
  type ResearchLimitsV1,
  type ResearchProduct,
} from "./contracts.js";
import type { ResearchBudgetSnapshotV1 } from "./capability-contracts.js";

type TransportBudgetEvent =
  | { type: "attempt" }
  | { type: "response"; responseBytes: number }
  | { type: "error" };

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
}
