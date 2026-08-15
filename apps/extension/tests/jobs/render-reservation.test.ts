import { describe, expect, it } from "bun:test";
import type { ExportResourceCapacitiesV1, ResourceEstimateV1 } from "@atlcli/export-jobs";
import {
  BrowserRenderAdmissionErrorV1,
  BrowserRenderReservationPoolV1,
} from "../../utils/export-jobs/render-reservation.js";

const capacities: ExportResourceCapacitiesV1 = {
  inFlightBytes: 100,
  persistedSpoolBytes: 80,
  outputBytes: 60,
  rasterBytes: 40,
  heavySlots: 1,
};

function estimate(overrides: Partial<ResourceEstimateV1> = {}): ResourceEstimateV1 {
  return {
    heapBytes: 20,
    spoolBytes: 10,
    outputBytes: 10,
    rasterPixels: 5,
    confidence: "estimated",
    ...overrides,
  };
}

describe("BrowserRenderReservationPoolV1", () => {
  it("serializes PDF and DOCX through one FIFO heavy slot", async () => {
    const pool = new BrowserRenderReservationPoolV1(capacities);
    const first = await pool.pdf.acquire({
      jobId: "pdf",
      leaseEpoch: 1,
      estimate: estimate(),
      signal: new AbortController().signal,
    });
    let secondEntered = false;
    const second = pool.docx.acquire({
      jobId: "docx",
      leaseEpoch: 1,
      estimate: estimate(),
      signal: new AbortController().signal,
    }).then((reservation) => {
      secondEntered = true;
      return reservation;
    });

    await Promise.resolve();
    expect(secondEntered).toBe(false);
    expect(pool.snapshot.reserved.heavySlots).toBe(1);
    await first.release();
    const docx = await second;
    expect(secondEntered).toBe(true);
    expect(pool.snapshot.reserved.heavySlots).toBe(1);
    await docx.release();
    expect(pool.snapshot.activeReservations).toBe(0);
  });

  it("removes an aborted waiter without leaking capacity or blocking the next job", async () => {
    const pool = new BrowserRenderReservationPoolV1(capacities);
    const active = await pool.pdf.acquire({
      jobId: "active",
      leaseEpoch: 1,
      estimate: estimate(),
      signal: new AbortController().signal,
    });
    const waitingController = new AbortController();
    const waiting = pool.pdf.acquire({
      jobId: "cancelled",
      leaseEpoch: 1,
      estimate: estimate(),
      signal: waitingController.signal,
    });
    const next = pool.pdf.acquire({
      jobId: "next",
      leaseEpoch: 1,
      estimate: estimate(),
      signal: new AbortController().signal,
    });
    waitingController.abort(new DOMException("Cancelled by test.", "AbortError"));

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await active.release();
    const admitted = await next;
    expect(pool.snapshot.activeReservations).toBe(1);
    await admitted.release();
    expect(pool.snapshot.activeReservations).toBe(0);
  });

  it("fails an impossible estimate with exact named shortfalls", async () => {
    const pool = new BrowserRenderReservationPoolV1(capacities);
    const pending = pool.pdf.acquire({
      jobId: "too-large",
      leaseEpoch: 1,
      estimate: estimate({ outputBytes: 75, rasterPixels: 12 }),
      signal: new AbortController().signal,
    });

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        code: "browser-render-capacity-exceeded",
        shortfalls: [
          { resource: "outputBytes", required: 75, available: 60, shortfall: 15 },
          { resource: "rasterBytes", required: 48, available: 40, shortfall: 8 },
        ],
      }),
    );
    expect(pool.snapshot.activeReservations).toBe(0);
  });

  it("reconciles component floors atomically and keeps the reservation releasable", async () => {
    const pool = new BrowserRenderReservationPoolV1(capacities);
    const reservation = await pool.docx.acquire({
      jobId: "docx",
      leaseEpoch: 2,
      estimate: estimate(),
      signal: new AbortController().signal,
    });
    const signal = new AbortController().signal;
    await reservation.reconcile({
      templateBytes: 20,
      preparedBytes: 30,
      assetBytes: 25,
      outputBytes: 50,
      rasterPixels: 8,
      signal,
    });
    expect(pool.snapshot.reserved).toEqual({
      inFlightBytes: 75,
      persistedSpoolBytes: 10,
      outputBytes: 50,
      rasterBytes: 32,
      heavySlots: 1,
    });

    await expect(reservation.reconcile({
      assetBytes: 60,
      signal,
    })).rejects.toBeInstanceOf(BrowserRenderAdmissionErrorV1);
    expect(pool.snapshot.reserved.inFlightBytes).toBe(75);
    await reservation.release();
    expect(pool.snapshot.activeReservations).toBe(0);
  });
});
