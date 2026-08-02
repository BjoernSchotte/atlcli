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

export interface ResearchModelBudgetSnapshotV1 {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

/**
 * Body-free model-spend checkpoint. It retains the immutable ceiling chosen
 * when a durable session first dispatches a provider request, plus the
 * pessimistic reservation/usage counters needed to continue safely after a
 * process or service-worker restart.
 */
export interface ResearchModelBudgetStateV1 {
  schema: "atlcli.research-model-budget/v1";
  limits: Pick<
    ResearchLimitsV1,
    "maxModelCalls" | "maxTotalModelInputTokens" | "maxTotalModelOutputTokens" | "maxModelCostMicros"
  >;
  snapshot: ResearchModelBudgetSnapshotV1;
}

interface ResearchModelBudgetReservationV1 {
  id: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

// Use the documented Sonnet long-context rates rounded upward: $6/MTok input
// and $22.50/MTok output. A local client-side tool has no separate provider
// fee; its schema/result bytes are nevertheless accounted as model input.
const CONSERVATIVE_INPUT_COST_MICROS_PER_TOKEN = 6;
const CONSERVATIVE_OUTPUT_COST_MICROS_PER_TOKEN = 23;

const RESEARCH_RUN_BUDGET_SCHEMA_V1 = "atlcli.research-run-budget/v1" as const;
const RESEARCH_MODEL_BUDGET_SCHEMA_V1 = "atlcli.research-model-budget/v1" as const;

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
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

/** Validate a portable, body-free provider-spend checkpoint. */
export function parseResearchModelBudgetStateV1(value: unknown): ResearchModelBudgetStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchContractError("invalid-request", "Research model budget state is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== RESEARCH_MODEL_BUDGET_SCHEMA_V1 ||
      Object.keys(record).length !== 3 ||
      !record.limits || typeof record.limits !== "object" || Array.isArray(record.limits) ||
      !record.snapshot || typeof record.snapshot !== "object" || Array.isArray(record.snapshot)) {
    throw new ResearchContractError("invalid-request", "Research model budget state is invalid.");
  }
  const limitsRecord = record.limits as Record<string, unknown>;
  const snapshotRecord = record.snapshot as Record<string, unknown>;
  if (Object.keys(limitsRecord).length !== 4 || Object.keys(snapshotRecord).length !== 4) {
    throw new ResearchContractError("invalid-request", "Research model budget state is invalid.");
  }
  const limits = {
    maxModelCalls: positiveInteger(limitsRecord.maxModelCalls, "Research model call limit"),
    maxTotalModelInputTokens: positiveInteger(limitsRecord.maxTotalModelInputTokens, "Research model input-token limit"),
    maxTotalModelOutputTokens: positiveInteger(limitsRecord.maxTotalModelOutputTokens, "Research model output-token limit"),
    maxModelCostMicros: positiveInteger(limitsRecord.maxModelCostMicros, "Research model cost limit"),
  };
  const snapshot = {
    calls: nonNegativeInteger(snapshotRecord.calls, "Research model call count"),
    inputTokens: nonNegativeInteger(snapshotRecord.inputTokens, "Research model input-token count"),
    outputTokens: nonNegativeInteger(snapshotRecord.outputTokens, "Research model output-token count"),
    costMicros: nonNegativeInteger(snapshotRecord.costMicros, "Research model cost count"),
  };
  // A provider can report usage above a pessimistic pre-reservation. Retain
  // that observed overage so a recovered host fails closed on the next call;
  // rejecting it here would erase the only durable evidence of the spend.
  return {
    schema: RESEARCH_MODEL_BUDGET_SCHEMA_V1,
    limits,
    snapshot,
  };
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

function modelInputBytes(value: unknown, seen = new Set<object>()): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).length;
  }
  if (typeof value === "function" || typeof value === "symbol") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + modelInputBytes(item, seen), 2);
  if (typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  return Object.entries(value as Record<string, unknown>).reduce(
    (total, [key, item]) => total + new TextEncoder().encode(key).byteLength + modelInputBytes(item, seen),
    2,
  );
}

const MODEL_TOOL_SCHEMA_RESERVE_BYTES = 8_192;
const MODEL_RESPONSE_FORMAT_RESERVE_BYTES = 8_192;

/**
 * Project LangChain's internal request object onto the data that is actually
 * serialized to a provider. Walking its complete object graph also walks Zod
 * implementation metadata and middleware closures; those are not tokens and
 * would make a fail-closed budget reject ordinary short calls.
 */
function providerRequestInputBytes(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return modelInputBytes(value);
  const request = value as {
    systemMessage?: unknown;
    messages?: unknown;
    tools?: unknown;
    responseFormat?: unknown;
  };
  const systemMessage = request.systemMessage;
  const messages = Array.isArray(request.messages)
    ? request.messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      const record = message as Record<string, unknown>;
      // These are the LangChain fields which become Anthropic message blocks.
      return {
        content: record.content,
        name: record.name,
        tool_call_id: record.tool_call_id,
        tool_calls: record.tool_calls,
        additional_kwargs: record.additional_kwargs,
      };
    })
    : request.messages;
  const tools = Array.isArray(request.tools)
    ? request.tools.map((tool) => {
      if (!tool || typeof tool !== "object") return undefined;
      const record = tool as Record<string, unknown>;
      // Tool schema serialization is provider-specific. Reserve a deliberately
      // high fixed amount instead of counting the non-serialized Zod graph.
      return { name: record.name, description: record.description };
    })
    : [];
  return modelInputBytes({ systemMessage, messages, tools }) +
    tools.length * MODEL_TOOL_SCHEMA_RESERVE_BYTES +
    (request.responseFormat === undefined ? 0 : MODEL_RESPONSE_FORMAT_RESERVE_BYTES);
}

function observedModelUsage(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as {
    usage_metadata?: Record<string, unknown>;
    response_metadata?: { usage?: Record<string, unknown> };
  };
  const usage = record.response_metadata?.usage ?? record.usage_metadata;
  if (!usage) return undefined;
  const token = (key: string): number => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0
    ? usage[key] as number
    : 0;
  const inputTokens = token("input_tokens") + token("cache_creation_input_tokens") + token("cache_read_input_tokens");
  const outputTokens = token("output_tokens");
  return inputTokens > 0 || outputTokens > 0 ? { inputTokens, outputTokens } : undefined;
}

/**
 * A process-local, fail-closed model budget. It reserves a conservative
 * request maximum before each model invocation, so concurrent subagents
 * cannot exceed a run ceiling merely by starting together. On a provider
 * error the reservation intentionally remains consumed: retry loops must not
 * turn an uncertain billable call into unbounded spend.
 */
export class ResearchModelRunBudget {
  readonly #limits: ResearchLimitsV1;
  #calls = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #costMicros = 0;
  #nextReservationId = 1;
  readonly #reservations = new Map<number, ResearchModelBudgetReservationV1>();

  constructor(limits: ResearchLimitsV1) {
    this.#limits = limits;
  }

  snapshot(): ResearchModelBudgetSnapshotV1 {
    return {
      calls: this.#calls,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      costMicros: this.#costMicros,
    };
  }

  exceedsLimits(): boolean {
    return this.#calls > this.#limits.maxModelCalls ||
      this.#inputTokens > this.#limits.maxTotalModelInputTokens ||
      this.#outputTokens > this.#limits.maxTotalModelOutputTokens ||
      this.#costMicros > this.#limits.maxModelCostMicros;
  }

  /** Persist the effective ceiling together with all pessimistic consumption. */
  state(): ResearchModelBudgetStateV1 {
    return {
      schema: RESEARCH_MODEL_BUDGET_SCHEMA_V1,
      limits: {
        maxModelCalls: this.#limits.maxModelCalls,
        maxTotalModelInputTokens: this.#limits.maxTotalModelInputTokens,
        maxTotalModelOutputTokens: this.#limits.maxTotalModelOutputTokens,
        maxModelCostMicros: this.#limits.maxModelCostMicros,
      },
      snapshot: this.snapshot(),
    };
  }

  /**
   * Restore a session checkpoint before any provider work. Outstanding
   * reservations from a dead worker deliberately remain consumed: a fresh
   * host has no evidence that the provider did not receive them.
   */
  restore(state: ResearchModelBudgetStateV1): void {
    if (this.#calls !== 0 || this.#inputTokens !== 0 || this.#outputTokens !== 0 ||
        this.#costMicros !== 0 || this.#reservations.size !== 0) {
      throw new ResearchContractError("invalid-request", "Research model budget may be restored only before use.");
    }
    const parsed = parseResearchModelBudgetStateV1(state);
    if (parsed.limits.maxModelCalls !== this.#limits.maxModelCalls ||
        parsed.limits.maxTotalModelInputTokens !== this.#limits.maxTotalModelInputTokens ||
        parsed.limits.maxTotalModelOutputTokens !== this.#limits.maxTotalModelOutputTokens ||
        parsed.limits.maxModelCostMicros !== this.#limits.maxModelCostMicros) {
      throw new ResearchContractError("invalid-request", "Research model budget checkpoint does not match its configured limits.");
    }
    this.#calls = parsed.snapshot.calls;
    this.#inputTokens = parsed.snapshot.inputTokens;
    this.#outputTokens = parsed.snapshot.outputTokens;
    this.#costMicros = parsed.snapshot.costMicros;
  }

  reserve(request: unknown, maximumOutputTokens: number): ResearchModelBudgetReservationV1 {
    if (!Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 1) {
      throw new ResearchContractError("invalid-request", "Research model output reservation is invalid.");
    }
    // Four bytes per token is a useful prose estimate but too optimistic for
    // tool JSON. Three bytes plus fixed provider/tool overhead is deliberate.
    const inputTokens = Math.ceil(providerRequestInputBytes(request) / 3) + 1_024;
    const outputTokens = maximumOutputTokens;
    const costMicros = inputTokens * CONSERVATIVE_INPUT_COST_MICROS_PER_TOKEN +
      outputTokens * CONSERVATIVE_OUTPUT_COST_MICROS_PER_TOKEN;
    if (
      this.#calls + 1 > this.#limits.maxModelCalls ||
      this.#inputTokens + inputTokens > this.#limits.maxTotalModelInputTokens ||
      this.#outputTokens + outputTokens > this.#limits.maxTotalModelOutputTokens ||
      this.#costMicros + costMicros > this.#limits.maxModelCostMicros
    ) {
      throw new ResearchContractError("limit-exceeded", "The model run budget was exhausted before another provider call.");
    }
    const reservation: ResearchModelBudgetReservationV1 = {
      id: this.#nextReservationId++,
      inputTokens,
      outputTokens,
      costMicros,
    };
    this.#calls += 1;
    this.#inputTokens += inputTokens;
    this.#outputTokens += outputTokens;
    this.#costMicros += costMicros;
    this.#reservations.set(reservation.id, reservation);
    return reservation;
  }

  settle(reservation: ResearchModelBudgetReservationV1, response: unknown): ResearchModelBudgetSnapshotV1 {
    const active = this.#reservations.get(reservation.id);
    if (!active) throw new ResearchContractError("invalid-request", "Research model budget reservation is unknown.");
    this.#reservations.delete(reservation.id);
    const usage = observedModelUsage(response);
    if (!usage) return this.snapshot();
    const actualCostMicros = usage.inputTokens * CONSERVATIVE_INPUT_COST_MICROS_PER_TOKEN +
      usage.outputTokens * CONSERVATIVE_OUTPUT_COST_MICROS_PER_TOKEN;
    this.#inputTokens += usage.inputTokens - active.inputTokens;
    this.#outputTokens += usage.outputTokens - active.outputTokens;
    this.#costMicros += actualCostMicros - active.costMicros;
    return this.snapshot();
  }
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
