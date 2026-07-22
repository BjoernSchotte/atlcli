import { describe, expect, it } from "bun:test";

import {
  InMemoryExportResourceReservationArbiterV1,
  type ExportResourceCapacitiesV1,
} from "./resource-reservation.js";

const CAPACITIES: ExportResourceCapacitiesV1 = {
  inFlightBytes: 100,
  persistedSpoolBytes: 200,
  outputBytes: 80,
  rasterBytes: 40,
  heavySlots: 1,
};

const owner = { jobId: "job-1", leaseEpoch: 3 } as const;

describe("InMemoryExportResourceReservationArbiterV1", () => {
  it("atomically admits multi-resource requests and exposes exact counters", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
      idFactory: () => "reservation-1",
    });

    const reservation = arbiter.acquire(
      owner,
      { inFlightBytes: 60, outputBytes: 20, heavySlots: 1 },
      200,
    );

    expect(reservation).toEqual({
      id: "reservation-1",
      ...owner,
      expiresAt: 200,
      resources: {
        inFlightBytes: 60,
        persistedSpoolBytes: 0,
        outputBytes: 20,
        rasterBytes: 0,
        heavySlots: 1,
      },
    });
    expect(arbiter.snapshot).toEqual({
      capacities: CAPACITIES,
      reserved: {
        inFlightBytes: 60,
        persistedSpoolBytes: 0,
        outputBytes: 20,
        rasterBytes: 0,
        heavySlots: 1,
      },
      available: {
        inFlightBytes: 40,
        persistedSpoolBytes: 200,
        outputBytes: 60,
        rasterBytes: 40,
        heavySlots: 0,
      },
      activeReservations: 1,
    });
  });

  it("does not partially admit a request when any resource exceeds capacity", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
    });

    expect(() =>
      arbiter.acquire(owner, { inFlightBytes: 10, heavySlots: 2 }, 200),
    ).toThrow(
      expect.objectContaining({
        code: "capacity-exceeded",
        resource: "heavySlots",
      }),
    );
    expect(arbiter.snapshot.reserved).toEqual({
      inFlightBytes: 0,
      persistedSpoolBytes: 0,
      outputBytes: 0,
      rasterBytes: 0,
      heavySlots: 0,
    });
    expect(arbiter.snapshot.activeReservations).toBe(0);
  });

  it("grows all-or-nothing when a later resource is exhausted", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
    });
    const reservation = arbiter.acquire(owner, { inFlightBytes: 20, outputBytes: 20 }, 200);
    const before = arbiter.snapshot;

    expect(() =>
      arbiter.grow(reservation.id, owner, { inFlightBytes: 10, outputBytes: 70 }),
    ).toThrow(
      expect.objectContaining({
        code: "capacity-exceeded",
        resource: "outputBytes",
      }),
    );
    expect(arbiter.snapshot).toEqual(before);
  });

  it("atomically transfers a phase charge without temporarily double-reserving", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(
      { ...CAPACITIES, persistedSpoolBytes: 60 },
      { clock: () => 100 },
    );
    const reservation = arbiter.acquire(owner, { inFlightBytes: 60 }, 200);

    const transferred = arbiter.transfer(reservation.id, owner, {
      release: { inFlightBytes: 60 },
      acquire: { persistedSpoolBytes: 60 },
    });

    expect(transferred.resources.inFlightBytes).toBe(0);
    expect(transferred.resources.persistedSpoolBytes).toBe(60);
    expect(arbiter.snapshot.reserved.inFlightBytes).toBe(0);
    expect(arbiter.snapshot.reserved.persistedSpoolBytes).toBe(60);
  });

  it("leaves both reservation and global counters unchanged when transfer fails", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
    });
    const first = arbiter.acquire(owner, { inFlightBytes: 60, outputBytes: 10 }, 200);
    arbiter.acquire({ jobId: "job-2", leaseEpoch: 1 }, { persistedSpoolBytes: 180 }, 200);
    const before = arbiter.snapshot;

    expect(() =>
      arbiter.transfer(first.id, owner, {
        release: { inFlightBytes: 60 },
        acquire: { persistedSpoolBytes: 30 },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "capacity-exceeded",
        resource: "persistedSpoolBytes",
      }),
    );
    expect(arbiter.snapshot).toEqual(before);
  });

  it("fences mutations to the owning job and lease epoch", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
    });
    const reservation = arbiter.acquire(owner, { rasterBytes: 10 }, 200);
    const before = arbiter.snapshot;

    expect(() =>
      arbiter.grow(
        reservation.id,
        { jobId: owner.jobId, leaseEpoch: owner.leaseEpoch + 1 },
        { rasterBytes: 1 },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ownership-mismatch",
      }),
    );
    expect(() =>
      arbiter.release(reservation.id, { jobId: "other-job", leaseEpoch: owner.leaseEpoch }),
    ).toThrow(
      expect.objectContaining({
        code: "ownership-mismatch",
      }),
    );
    expect(arbiter.snapshot).toEqual(before);
  });

  it("reclaims expired reservations and makes their release idempotent", () => {
    let now = 100;
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => now,
    });
    const expired = arbiter.acquire(owner, { inFlightBytes: 100, heavySlots: 1 }, 150);
    now = 150;

    const reclaimed = arbiter.reclaimExpired();

    expect(reclaimed).toEqual({
      reservationsReclaimed: 1,
      resourcesReleased: {
        inFlightBytes: 100,
        persistedSpoolBytes: 0,
        outputBytes: 0,
        rasterBytes: 0,
        heavySlots: 1,
      },
    });
    expect(arbiter.release(expired.id, owner)).toBe(false);
    expect(arbiter.release(expired.id, owner)).toBe(false);
    expect(arbiter.snapshot.activeReservations).toBe(0);

    const replacement = arbiter.acquire(
      { jobId: "job-2", leaseEpoch: 1 },
      { inFlightBytes: 100, heavySlots: 1 },
      250,
    );
    expect(replacement.resources.heavySlots).toBe(1);
  });

  it("releases active reservations exactly once", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
    });
    const reservation = arbiter.acquire(owner, { outputBytes: 80 }, 200);

    expect(arbiter.release(reservation.id, owner)).toBe(true);
    expect(arbiter.release(reservation.id, owner)).toBe(false);
    expect(arbiter.snapshot.reserved.outputBytes).toBe(0);
    expect(arbiter.snapshot.activeReservations).toBe(0);
  });

  it("rejects releasing more than a reservation owns without mutation", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
    });
    const reservation = arbiter.acquire(owner, { inFlightBytes: 10 }, 200);
    const before = arbiter.snapshot;

    expect(() =>
      arbiter.transfer(reservation.id, owner, { release: { inFlightBytes: 11 } }),
    ).toThrow(
      expect.objectContaining({
        code: "release-exceeds-reservation",
        resource: "inFlightBytes",
      }),
    );
    expect(arbiter.snapshot).toEqual(before);
  });

  it("never reuses a released custom id that a stale receipt could target", () => {
    const arbiter = new InMemoryExportResourceReservationArbiterV1(CAPACITIES, {
      clock: () => 100,
      idFactory: () => "fixed-id",
    });
    const first = arbiter.acquire(owner, { inFlightBytes: 10 }, 200);
    expect(arbiter.release(first.id, owner)).toBe(true);
    expect(() => arbiter.acquire(owner, { inFlightBytes: 20 }, 200)).toThrow(
      expect.objectContaining({ code: "invalid-owner" }),
    );
    expect(arbiter.snapshot.activeReservations).toBe(0);
  });
});
