import { describe, expect, test } from "bun:test";
import { assertCalverVersion, nextCalverVersion, previousStableTag } from "./release-version.js";

const OCTOBER = new Date("2026-10-14T12:00:00Z");

describe("product CalVer", () => {
  test("starts at one and never reuses gaps or reserved tags", () => {
    expect(nextCalverVersion("0.17.2", [], OCTOBER)).toBe("2026.10.1");
    expect(nextCalverVersion("2026.10.2", ["v2026.10.2", "v2026.10.10"], OCTOBER))
      .toBe("2026.10.11");
  });

  test("resets the counter at month and year boundaries", () => {
    expect(nextCalverVersion("2026.9.12", ["v2026.9.12"], OCTOBER)).toBe("2026.10.1");
    expect(nextCalverVersion("2026.12.15", ["v2026.12.15"], new Date("2027-01-01T00:00:00Z")))
      .toBe("2027.1.1");
  });

  test("uses the UTC month for an instant near a local month boundary", () => {
    expect(nextCalverVersion("2026.9.1", ["v2026.9.1"], new Date("2026-10-01T00:30:00+02:00")))
      .toBe("2026.9.2");
  });

  test("ignores dev, package, padded and malformed tags", () => {
    expect(nextCalverVersion("0.17.2", ["dev-20261014.5.1-aaaaaaaa", "core-v1.0.0",
      "v2026.10.2-beta.1", "v2026.010.99", "v2026.13.1", "v2026.10.0"], OCTOBER))
      .toBe("2026.10.1");
  });

  test("rejects invalid months, counters, padding and Chrome overflow", () => {
    expect(assertCalverVersion("2026.10.1")).toBe("2026.10.1");
    for (const version of ["0.17.2", "2026.0.1", "2026.13.1", "2026.01.1", "2026.1.0",
      "2026.1.01", "2026.1.65536", "v2026.1.1", "2026.1.1-dev.1"]) {
      expect(() => assertCalverVersion(version), version).toThrow();
    }
    expect(() => nextCalverVersion("2026.10.65535", ["v2026.10.65535"], OCTOBER)).toThrow();
    expect(() => nextCalverVersion("0.17.2", [], new Date(NaN))).toThrow();
  });

  test("blocks clock regression and a root version ahead of known tags", () => {
    expect(() => nextCalverVersion("2026.11.1", [], OCTOBER)).toThrow("must be newer");
    expect(() => nextCalverVersion("0.17.2", ["v2027.1.1"], OCTOBER)).toThrow("must be newer");
    expect(() => nextCalverVersion("2026.10.4", ["v2026.10.2"], OCTOBER)).toThrow("must be newer");
    expect(() => nextCalverVersion("bad", [], OCTOBER)).toThrow();
  });

  test("selects a numeric stable predecessor including historical SemVer", () => {
    expect(previousStableTag(["v0.9.0", "v0.17.2", "dev-20261014.12.1-aaaaaaaa"]))
      .toBe("v0.17.2");
    expect(previousStableTag(["v2026.9.10", "v2026.10.2", "v2026.10.10", "v2026.10.3"]))
      .toBe("v2026.10.10");
    expect(previousStableTag(["core-v1.0.0", "dev-20261014.12.1-aaaaaaaa"])).toBeNull();
  });
});
