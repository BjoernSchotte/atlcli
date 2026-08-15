export const EXPORT_RESOURCE_NAMES_V1 = [
  "inFlightBytes",
  "persistedSpoolBytes",
  "outputBytes",
  "rasterBytes",
  "heavySlots",
] as const;

export type ExportResourceNameV1 = (typeof EXPORT_RESOURCE_NAMES_V1)[number];

/** Host-owned admission limits. Zero disables a resource for this host. */
export type ExportResourceCapacitiesV1 = Readonly<Record<ExportResourceNameV1, number>>;

/** A partial request; omitted resources consume no capacity. */
export type ExportResourceAmountsV1 = Readonly<Partial<Record<ExportResourceNameV1, number>>>;

export interface ExportResourceReservationOwnerV1 {
  jobId: string;
  leaseEpoch: number;
}

export interface ExportResourceReservationV1 extends ExportResourceReservationOwnerV1 {
  id: string;
  expiresAt: number;
  resources: ExportResourceCapacitiesV1;
}

export interface ExportResourceReservationSnapshotV1 {
  capacities: ExportResourceCapacitiesV1;
  reserved: ExportResourceCapacitiesV1;
  available: ExportResourceCapacitiesV1;
  activeReservations: number;
}

export interface ExportResourceReclaimResultV1 {
  reservationsReclaimed: number;
  resourcesReleased: ExportResourceCapacitiesV1;
}

export type ExportResourceReservationErrorCodeV1 =
  | "invalid-capacity"
  | "invalid-amount"
  | "empty-request"
  | "invalid-owner"
  | "invalid-expiry"
  | "capacity-exceeded"
  | "reservation-not-found"
  | "ownership-mismatch"
  | "release-exceeds-reservation";

/** Stable failure surface for host-side admission and fencing. */
export class ExportResourceReservationErrorV1 extends Error {
  readonly code: ExportResourceReservationErrorCodeV1;
  readonly resource?: ExportResourceNameV1;

  constructor(
    code: ExportResourceReservationErrorCodeV1,
    message: string,
    resource?: ExportResourceNameV1,
  ) {
    super(message);
    this.name = "ExportResourceReservationErrorV1";
    this.code = code;
    this.resource = resource;
  }
}

interface MutableReservationRecord extends ExportResourceReservationOwnerV1 {
  id: string;
  expiresAt: number;
  resources: Record<ExportResourceNameV1, number>;
}

const ZERO_RESOURCES: ExportResourceCapacitiesV1 = Object.freeze({
  inFlightBytes: 0,
  persistedSpoolBytes: 0,
  outputBytes: 0,
  rasterBytes: 0,
  heavySlots: 0,
});

function resourceRecord(): Record<ExportResourceNameV1, number> {
  return { ...ZERO_RESOURCES };
}

function freezeResources(
  resources: Readonly<Record<ExportResourceNameV1, number>>,
): ExportResourceCapacitiesV1 {
  return Object.freeze({ ...resources });
}

function validateSafeNonNegative(
  value: number,
  code: "invalid-capacity" | "invalid-amount",
  label: string,
  resource: ExportResourceNameV1,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExportResourceReservationErrorV1(
      code,
      `${label}.${resource} must be a non-negative safe integer.`,
      resource,
    );
  }
  return value;
}

function normalizeCapacities(input: ExportResourceCapacitiesV1): ExportResourceCapacitiesV1 {
  const normalized = resourceRecord();
  for (const resource of EXPORT_RESOURCE_NAMES_V1) {
    normalized[resource] = validateSafeNonNegative(
      input[resource],
      "invalid-capacity",
      "capacities",
      resource,
    );
  }
  return freezeResources(normalized);
}

function normalizeAmounts(
  input: ExportResourceAmountsV1,
  options: { allowEmpty: boolean },
): Record<ExportResourceNameV1, number> {
  const normalized = resourceRecord();
  let nonZero = false;
  for (const resource of EXPORT_RESOURCE_NAMES_V1) {
    const value = input[resource] ?? 0;
    normalized[resource] = validateSafeNonNegative(
      value,
      "invalid-amount",
      "resources",
      resource,
    );
    nonZero ||= value > 0;
  }
  if (!options.allowEmpty && !nonZero) {
    throw new ExportResourceReservationErrorV1(
      "empty-request",
      "A resource reservation must request at least one resource.",
    );
  }
  return normalized;
}

function validateOwner(owner: ExportResourceReservationOwnerV1): void {
  if (typeof owner.jobId !== "string" || owner.jobId.length === 0) {
    throw new ExportResourceReservationErrorV1(
      "invalid-owner",
      "Resource reservation jobId must be non-empty.",
    );
  }
  if (!Number.isSafeInteger(owner.leaseEpoch) || owner.leaseEpoch <= 0) {
    throw new ExportResourceReservationErrorV1(
      "invalid-owner",
      "Resource reservation leaseEpoch must be a positive safe integer.",
    );
  }
}

function validateTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExportResourceReservationErrorV1(
      "invalid-expiry",
      `${label} must be a non-negative safe-integer timestamp.`,
    );
  }
  return value;
}

function receipt(record: MutableReservationRecord): ExportResourceReservationV1 {
  return Object.freeze({
    id: record.id,
    jobId: record.jobId,
    leaseEpoch: record.leaseEpoch,
    expiresAt: record.expiresAt,
    resources: freezeResources(record.resources),
  });
}

/**
 * In-memory reference arbiter for host-owned export resource admission.
 *
 * Every mutation is synchronous and validates the complete replacement state
 * before committing it. This makes multi-resource acquire, grow, and transfer
 * all-or-nothing even when one requested resource is exhausted. Executors only
 * receive a receipt; the host retains the arbiter and enforces job/epoch fencing.
 */
export class InMemoryExportResourceReservationArbiterV1 {
  readonly capacities: ExportResourceCapacitiesV1;

  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #reserved = resourceRecord();
  readonly #reservations = new Map<string, MutableReservationRecord>();
  readonly #usedIds = new Set<string>();
  #nextId = 1;

  constructor(
    capacities: ExportResourceCapacitiesV1,
    options: { clock?: () => number; idFactory?: () => string } = {},
  ) {
    this.capacities = normalizeCapacities(capacities);
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => `export-resource-${this.#nextId++}`);
  }

  get snapshot(): ExportResourceReservationSnapshotV1 {
    const reserved = freezeResources(this.#reserved);
    const available = resourceRecord();
    for (const resource of EXPORT_RESOURCE_NAMES_V1) {
      available[resource] = this.capacities[resource] - reserved[resource];
    }
    return Object.freeze({
      capacities: this.capacities,
      reserved,
      available: freezeResources(available),
      activeReservations: this.#reservations.size,
    });
  }

  acquire(
    owner: ExportResourceReservationOwnerV1,
    resources: ExportResourceAmountsV1,
    expiresAt: number,
  ): ExportResourceReservationV1 {
    validateOwner(owner);
    const requested = normalizeAmounts(resources, { allowEmpty: false });
    const now = validateTimestamp(this.#clock(), "clock");
    validateTimestamp(expiresAt, "expiresAt");
    if (expiresAt <= now) {
      throw new ExportResourceReservationErrorV1(
        "invalid-expiry",
        "Resource reservation expiresAt must be later than the host clock.",
      );
    }
    this.reclaimExpired(now);
    this.#assertFits(requested);

    const id = this.#idFactory();
    if (typeof id !== "string" || id.length === 0 || this.#usedIds.has(id)) {
      throw new ExportResourceReservationErrorV1(
        "invalid-owner",
        "Resource reservation idFactory must return a unique non-empty id.",
      );
    }
    const record: MutableReservationRecord = {
      id,
      jobId: owner.jobId,
      leaseEpoch: owner.leaseEpoch,
      expiresAt,
      resources: requested,
    };
    this.#commitDelta(ZERO_RESOURCES, requested);
    this.#usedIds.add(id);
    this.#reservations.set(id, record);
    return receipt(record);
  }

  grow(
    id: string,
    owner: ExportResourceReservationOwnerV1,
    additional: ExportResourceAmountsV1,
    options: { expiresAt?: number } = {},
  ): ExportResourceReservationV1 {
    return this.transfer(id, owner, { acquire: additional, expiresAt: options.expiresAt });
  }

  /**
   * Atomically replace resource charges on one reservation. `release` is
   * removed before `acquire` is added, enabling phase transitions such as
   * in-flight bytes becoming persisted spool bytes without an admission gap.
   */
  transfer(
    id: string,
    owner: ExportResourceReservationOwnerV1,
    change: {
      release?: ExportResourceAmountsV1;
      acquire?: ExportResourceAmountsV1;
      expiresAt?: number;
    },
  ): ExportResourceReservationV1 {
    validateOwner(owner);
    const released = normalizeAmounts(change.release ?? {}, { allowEmpty: true });
    const acquired = normalizeAmounts(change.acquire ?? {}, { allowEmpty: true });
    if (
      EXPORT_RESOURCE_NAMES_V1.every(
        (resource) => released[resource] === 0 && acquired[resource] === 0,
      ) && change.expiresAt === undefined
    ) {
      throw new ExportResourceReservationErrorV1(
        "empty-request",
        "A transfer must change resources or expiry.",
      );
    }

    const now = validateTimestamp(this.#clock(), "clock");
    if (change.expiresAt !== undefined) {
      validateTimestamp(change.expiresAt, "expiresAt");
      if (change.expiresAt <= now) {
        throw new ExportResourceReservationErrorV1(
          "invalid-expiry",
          "Resource reservation expiresAt must be later than the host clock.",
        );
      }
    }
    this.reclaimExpired(now);
    const record = this.#ownedRecord(id, owner);

    const replacement = resourceRecord();
    const globalDelta = resourceRecord();
    for (const resource of EXPORT_RESOURCE_NAMES_V1) {
      if (released[resource] > record.resources[resource]) {
        throw new ExportResourceReservationErrorV1(
          "release-exceeds-reservation",
          `Cannot release more ${resource} than reservation ${id} owns.`,
          resource,
        );
      }
      const next = record.resources[resource] - released[resource] + acquired[resource];
      if (!Number.isSafeInteger(next)) {
        throw new ExportResourceReservationErrorV1(
          "invalid-amount",
          `Transfer overflows ${resource}.`,
          resource,
        );
      }
      replacement[resource] = next;
      globalDelta[resource] = acquired[resource] - released[resource];
    }
    this.#assertFits(globalDelta);

    this.#commitDelta(ZERO_RESOURCES, globalDelta);
    record.resources = replacement;
    if (change.expiresAt !== undefined) record.expiresAt = change.expiresAt;
    return receipt(record);
  }

  /** Returns true once; later releases of the same or reclaimed id are no-ops. */
  release(id: string, owner: ExportResourceReservationOwnerV1): boolean {
    validateOwner(owner);
    const now = validateTimestamp(this.#clock(), "clock");
    this.reclaimExpired(now);
    const record = this.#reservations.get(id);
    if (!record) return false;
    this.#assertOwner(record, owner);
    this.#commitDelta(record.resources, ZERO_RESOURCES);
    this.#reservations.delete(id);
    return true;
  }

  reclaimExpired(at: number = this.#clock()): ExportResourceReclaimResultV1 {
    validateTimestamp(at, "reclaim time");
    const released = resourceRecord();
    let count = 0;
    for (const [id, record] of this.#reservations) {
      if (record.expiresAt > at) continue;
      for (const resource of EXPORT_RESOURCE_NAMES_V1) {
        released[resource] += record.resources[resource];
      }
      this.#reservations.delete(id);
      count += 1;
    }
    if (count > 0) this.#commitDelta(released, ZERO_RESOURCES);
    return Object.freeze({
      reservationsReclaimed: count,
      resourcesReleased: freezeResources(released),
    });
  }

  #ownedRecord(
    id: string,
    owner: ExportResourceReservationOwnerV1,
  ): MutableReservationRecord {
    const record = this.#reservations.get(id);
    if (!record) {
      throw new ExportResourceReservationErrorV1(
        "reservation-not-found",
        `Resource reservation ${id} does not exist or has expired.`,
      );
    }
    this.#assertOwner(record, owner);
    return record;
  }

  #assertOwner(
    record: MutableReservationRecord,
    owner: ExportResourceReservationOwnerV1,
  ): void {
    if (record.jobId !== owner.jobId || record.leaseEpoch !== owner.leaseEpoch) {
      throw new ExportResourceReservationErrorV1(
        "ownership-mismatch",
        `Resource reservation ${record.id} is fenced to another job lease.`,
      );
    }
  }

  #assertFits(delta: Readonly<Record<ExportResourceNameV1, number>>): void {
    for (const resource of EXPORT_RESOURCE_NAMES_V1) {
      const next = this.#reserved[resource] + delta[resource];
      if (!Number.isSafeInteger(next) || next < 0) {
        throw new ExportResourceReservationErrorV1(
          "invalid-amount",
          `Resource accounting overflow for ${resource}.`,
          resource,
        );
      }
      if (next > this.capacities[resource]) {
        throw new ExportResourceReservationErrorV1(
          "capacity-exceeded",
          `${resource} requires ${next}; host capacity is ${this.capacities[resource]}.`,
          resource,
        );
      }
    }
  }

  #commitDelta(
    release: Readonly<Record<ExportResourceNameV1, number>>,
    acquire: Readonly<Record<ExportResourceNameV1, number>>,
  ): void {
    for (const resource of EXPORT_RESOURCE_NAMES_V1) {
      this.#reserved[resource] = this.#reserved[resource] - release[resource] + acquire[resource];
    }
  }
}
