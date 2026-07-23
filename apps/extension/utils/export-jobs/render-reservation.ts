import {
  InMemoryExportResourceReservationArbiterV1,
  type ExportResourceAmountsV1,
  type ExportResourceCapacitiesV1,
  type ExportResourceNameV1,
  type ExportResourceReservationOwnerV1,
  type ExportResourceReservationSnapshotV1,
  type ExportResourceReservationV1,
  type ResourceEstimateV1,
} from "@atlcli/export-jobs";
import type {
  DocxRenderReservationPortV1,
  DocxRenderReservationV1,
  PdfRenderReservationPortV1,
  PdfRenderReservationV1,
} from "@atlcli/export-wiring/jobs";

const MIB = 1024 * 1024;
const RASTER_BYTES_PER_PIXEL = 4;

/**
 * Conservative first-delivery limits. The single heavy slot is the important
 * cross-format invariant; byte limits fail closed instead of risking a renderer
 * process crash. Changes require updated large-export benchmark evidence.
 */
export const DEFAULT_BROWSER_EXPORT_RESOURCE_CAPACITIES_V1:
ExportResourceCapacitiesV1 = Object.freeze({
  inFlightBytes: 512 * MIB,
  persistedSpoolBytes: 128 * MIB,
  outputBytes: 64 * MIB,
  rasterBytes: 128 * MIB,
  heavySlots: 1,
});

export interface BrowserRenderResourceShortfallV1 {
  resource: ExportResourceNameV1;
  required: number;
  available: number;
  shortfall: number;
}

export class BrowserRenderAdmissionErrorV1 extends Error {
  readonly code = "browser-render-capacity-exceeded" as const;
  readonly shortfalls: readonly BrowserRenderResourceShortfallV1[];

  constructor(shortfalls: readonly BrowserRenderResourceShortfallV1[]) {
    super(
      `Browser render cannot be admitted: ${shortfalls.map((entry) =>
        `${entry.resource} needs ${entry.required}, capacity is ${entry.available}`
      ).join("; ")}.`,
    );
    this.name = "BrowserRenderAdmissionErrorV1";
    this.shortfalls = Object.freeze(shortfalls.map((entry) => Object.freeze({ ...entry })));
  }
}

type RenderKind = "pdf" | "docx";

interface PendingAcquire {
  owner: ExportResourceReservationOwnerV1;
  resources: ExportResourceAmountsV1;
  signal: AbortSignal;
  kind: RenderKind;
  resolve: (reservation: BrowserRenderReservation) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

interface ReservationFloors {
  preparedBytes: number;
  outputBytes: number;
  templateBytes: number;
  assetBytes: number;
  rasterPixels: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Render reservation was cancelled.", "AbortError");
}

function checkedAmount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function checkedSum(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + checkedAmount(value, label), 0);
  return checkedAmount(total, label);
}

function rasterBytes(pixels: number): number {
  return checkedAmount(
    checkedAmount(pixels, "rasterPixels") * RASTER_BYTES_PER_PIXEL,
    "rasterBytes",
  );
}

function estimateResources(estimate: ResourceEstimateV1): ExportResourceCapacitiesV1 {
  return Object.freeze({
    inFlightBytes: checkedAmount(estimate.heapBytes, "estimate.heapBytes"),
    persistedSpoolBytes: checkedAmount(estimate.spoolBytes, "estimate.spoolBytes"),
    outputBytes: checkedAmount(estimate.outputBytes, "estimate.outputBytes"),
    rasterBytes: rasterBytes(estimate.rasterPixels),
    heavySlots: 1,
  });
}

function shortfalls(
  resources: ExportResourceAmountsV1,
  capacities: ExportResourceCapacitiesV1,
): BrowserRenderResourceShortfallV1[] {
  const result: BrowserRenderResourceShortfallV1[] = [];
  for (const resource of Object.keys(capacities) as ExportResourceNameV1[]) {
    const required = resources[resource] ?? 0;
    const available = capacities[resource];
    if (required > available) {
      result.push({
        resource,
        required,
        available,
        shortfall: required - available,
      });
    }
  }
  return result;
}

function fits(
  resources: ExportResourceAmountsV1,
  available: ExportResourceCapacitiesV1,
): boolean {
  return (Object.keys(available) as ExportResourceNameV1[]).every(
    (resource) => (resources[resource] ?? 0) <= available[resource],
  );
}

class BrowserRenderReservation {
  readonly #pool: BrowserRenderReservationPoolV1;
  readonly #owner: ExportResourceReservationOwnerV1;
  readonly #kind: RenderKind;
  readonly #base: ExportResourceCapacitiesV1;
  readonly #floors: ReservationFloors = {
    preparedBytes: 0,
    outputBytes: 0,
    templateBytes: 0,
    assetBytes: 0,
    rasterPixels: 0,
  };
  #receipt: ExportResourceReservationV1;
  #released = false;

  constructor(
    pool: BrowserRenderReservationPoolV1,
    owner: ExportResourceReservationOwnerV1,
    kind: RenderKind,
    receipt: ExportResourceReservationV1,
  ) {
    this.#pool = pool;
    this.#owner = owner;
    this.#kind = kind;
    this.#receipt = receipt;
    this.#base = receipt.resources;
  }

  async reconcile(input: {
    preparedBytes?: number;
    outputBytes?: number;
    templateBytes?: number;
    assetBytes?: number;
    rasterPixels?: number;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    if (this.#released) throw new Error("Render reservation is already released.");
    for (const key of [
      "preparedBytes",
      "outputBytes",
      "templateBytes",
      "assetBytes",
      "rasterPixels",
    ] as const) {
      const value = input[key];
      if (value !== undefined) {
        this.#floors[key] = Math.max(this.#floors[key], checkedAmount(value, key));
      }
    }
    const liveBytes = this.#kind === "docx"
      ? checkedSum([
        this.#floors.templateBytes,
        this.#floors.preparedBytes,
        this.#floors.assetBytes,
      ], "DOCX live render bytes")
      : this.#floors.preparedBytes;
    const desired: ExportResourceCapacitiesV1 = {
      inFlightBytes: Math.max(this.#base.inFlightBytes, liveBytes),
      persistedSpoolBytes: this.#base.persistedSpoolBytes,
      outputBytes: Math.max(this.#base.outputBytes, this.#floors.outputBytes),
      rasterBytes: Math.max(this.#base.rasterBytes, rasterBytes(this.#floors.rasterPixels)),
      heavySlots: 1,
    };
    this.#receipt = this.#pool.grow(this.#receipt, this.#owner, desired);
    input.signal.throwIfAborted();
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#pool.release(this.#receipt, this.#owner);
  }
}

/**
 * One FIFO admission pool shared by PDF and DOCX in the offscreen document.
 * Waiting is abortable; impossible requests fail with exact named shortfalls.
 */
export class BrowserRenderReservationPoolV1 {
  readonly #arbiter: InMemoryExportResourceReservationArbiterV1;
  readonly #pending: PendingAcquire[] = [];

  constructor(
    capacities: ExportResourceCapacitiesV1 =
      DEFAULT_BROWSER_EXPORT_RESOURCE_CAPACITIES_V1,
  ) {
    this.#arbiter = new InMemoryExportResourceReservationArbiterV1(capacities);
  }

  get snapshot(): ExportResourceReservationSnapshotV1 {
    return this.#arbiter.snapshot;
  }

  readonly pdf: PdfRenderReservationPortV1 = {
    acquire: async (input): Promise<PdfRenderReservationV1> =>
      this.#acquire("pdf", input),
  };

  readonly docx: DocxRenderReservationPortV1 = {
    acquire: async (input): Promise<DocxRenderReservationV1> =>
      this.#acquire("docx", input),
  };

  grow(
    receipt: ExportResourceReservationV1,
    owner: ExportResourceReservationOwnerV1,
    desired: ExportResourceCapacitiesV1,
  ): ExportResourceReservationV1 {
    const impossible = shortfalls(desired, this.#arbiter.capacities);
    if (impossible.length > 0) throw new BrowserRenderAdmissionErrorV1(impossible);
    const acquire = Object.fromEntries(
      (Object.keys(desired) as ExportResourceNameV1[]).map((resource) => [
        resource,
        Math.max(0, desired[resource] - receipt.resources[resource]),
      ]),
    ) as Record<ExportResourceNameV1, number>;
    if (Object.values(acquire).every((value) => value === 0)) return receipt;
    return this.#arbiter.grow(receipt.id, owner, acquire);
  }

  release(
    receipt: ExportResourceReservationV1,
    owner: ExportResourceReservationOwnerV1,
  ): void {
    this.#arbiter.release(receipt.id, owner);
    this.#drain();
  }

  #acquire(
    kind: RenderKind,
    input: {
      jobId: string;
      leaseEpoch: number;
      estimate: ResourceEstimateV1;
      signal: AbortSignal;
    },
  ): Promise<BrowserRenderReservation> {
    input.signal.throwIfAborted();
    const owner = { jobId: input.jobId, leaseEpoch: input.leaseEpoch };
    const resources = estimateResources(input.estimate);
    const impossible = shortfalls(resources, this.#arbiter.capacities);
    if (impossible.length > 0) {
      return Promise.reject(new BrowserRenderAdmissionErrorV1(impossible));
    }
    return new Promise<BrowserRenderReservation>((resolve, reject) => {
      const pending: PendingAcquire = {
        owner,
        resources,
        signal: input.signal,
        kind,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#pending.indexOf(pending);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(abortReason(input.signal));
          this.#drain();
        },
      };
      input.signal.addEventListener("abort", pending.onAbort, { once: true });
      this.#pending.push(pending);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#pending.length > 0) {
      const next = this.#pending[0]!;
      if (next.signal.aborted) {
        this.#pending.shift();
        next.signal.removeEventListener("abort", next.onAbort);
        next.reject(abortReason(next.signal));
        continue;
      }
      if (!fits(next.resources, this.#arbiter.snapshot.available)) return;
      this.#pending.shift();
      next.signal.removeEventListener("abort", next.onAbort);
      const receipt = this.#arbiter.acquire(
        next.owner,
        next.resources,
        Number.MAX_SAFE_INTEGER,
      );
      next.resolve(new BrowserRenderReservation(this, next.owner, next.kind, receipt));
    }
  }
}
