import { describe, expect, it } from "bun:test";
import { buildDocx } from "./fixtures.js";

/**
 * Reproducible-build guard (spec 009): PizZip stamps each entry with
 * `new Date()` (2-second resolution) by default, so two independent `buildDocx`
 * calls could differ by a few bytes across a 2-second boundary — a flaky failure
 * whenever a build is byte-compared as a fixed asset (see
 * `@atlcli/export-node`'s `bundledDefaultTemplate`). A pinned `date` must make
 * the archive fully byte-reproducible.
 */
describe("buildDocx date pinning", () => {
  const opts = { body: "<w:p/>", date: new Date("2020-01-01T00:00:00.000Z") };

  it("is byte-reproducible across independent calls when the date is pinned", () => {
    expect(buildDocx(opts)).toEqual(buildDocx(opts));
  });

  it("wires the pinned date through to the zip entry timestamps", () => {
    const early = buildDocx({ ...opts, date: new Date("2020-01-01T00:00:00.000Z") });
    const late = buildDocx({ ...opts, date: new Date("2021-06-15T12:00:00.000Z") });
    // Different pinned timestamps → different bytes, proving the date is not ignored.
    expect(early).not.toEqual(late);
  });
});
