/**
 * Security attestation tests (spec 011).
 *
 * The pure decision logic — baseline diffing, digest verification, M1 record
 * reading, the exit-code policy — is tested directly with real files in a temp
 * directory (no mocks; the only injected seam is *which binary path* to hash,
 * because a test cannot install veraPDF).
 *
 * The property that matters most is the honesty rule: a check that could not be
 * performed must report `null`/`indeterminate`, never a passing-looking value.
 * Several tests below exist purely to pin that, because a future refactor
 * "simplifying" `null` to `false` would silently turn an unverified artifact
 * into one that reads like a verified failure — or worse, `true`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAttestation,
  checkBaselineDocsSync,
  checkVeraPdfDigest,
  diffBaselines,
  hasDeterminedFailure,
  readM1Acceptance,
  type SecurityAttestation,
} from "./attest.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlcli-attest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

describe("veraPDF baseline delta", () => {
  const entry = (failureCount: number, locationsDigest = "aaaa") => ({ failureCount, locationsDigest });

  it("reports no movement for an unchanged baseline", () => {
    const baseline = { "blocks::7.1-1": entry(3) };
    expect(diffBaselines(baseline, baseline)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("reports a newly baselined rule as added", () => {
    expect(diffBaselines({}, { "blocks::7.1-1": entry(3) }).added).toEqual(["blocks::7.1-1"]);
  });

  it("reports a rule dropped from the baseline as removed", () => {
    // The baseline is supposed to shrink monotonically, so this direction is
    // the good news — but it is still a reviewed change and must be recorded.
    expect(diffBaselines({ "blocks::7.1-1": entry(3) }, {}).removed).toEqual(["blocks::7.1-1"]);
  });

  it("reports a rising failure count on an already-baselined rule as changed", () => {
    // The regression class the ratchet exists for: same rule id, more
    // instances. Keyed-by-id-alone diffing would call this "unchanged".
    const delta = diffBaselines({ "blocks::7.1-1": entry(3) }, { "blocks::7.1-1": entry(9) });
    expect(delta).toEqual({ added: [], removed: [], changed: ["blocks::7.1-1"] });
  });

  it("reports moved failure locations as changed even at an identical count", () => {
    const delta = diffBaselines(
      { "blocks::7.1-1": entry(3, "aaaa") },
      { "blocks::7.1-1": entry(3, "bbbb") }
    );
    expect(delta.changed).toEqual(["blocks::7.1-1"]);
  });

  it("sorts each list so the artifact is byte-stable across runs", () => {
    const delta = diffBaselines({}, { "z::1": entry(1), "a::1": entry(1), "m::1": entry(1) });
    expect(delta.added).toEqual(["a::1", "m::1", "z::1"]);
  });
});

describe("veraPDF digest verification", () => {
  it("is indeterminate when no lock file pins a digest", () => {
    // Today's real state. It must NOT read as a passing check.
    const result = checkVeraPdfDigest({ lockPath: join(dir, "missing.json") });
    expect(result.ok).toBeNull();
    expect(result.detail).toContain("verapdf.lock.json");
  });

  it("is indeterminate when the binary is absent, even with a lock file", () => {
    const lockPath = write("verapdf.lock.json", { sha256: "a".repeat(64) });
    const result = checkVeraPdfDigest({ lockPath, resolveBinary: () => null });
    expect(result.ok).toBeNull();
    expect(result.detail).toContain("not present");
  });

  it("passes when the binary hashes to the pinned digest", () => {
    const binary = write("verapdf", "#!/bin/sh\necho verapdf\n");
    const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
    const lockPath = write("verapdf.lock.json", { sha256 });
    expect(checkVeraPdfDigest({ lockPath, resolveBinary: () => binary }).ok).toBe(true);
  });

  it("FAILS — not indeterminate — when the binary does not match the pin", () => {
    // A silently upgraded/substituted binary is the exact threat the pin
    // exists for; it must be distinguishable from "could not check".
    const binary = write("verapdf", "#!/bin/sh\necho tampered\n");
    const lockPath = write("verapdf.lock.json", { sha256: "b".repeat(64) });
    const result = checkVeraPdfDigest({ lockPath, resolveBinary: () => binary });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("does NOT match");
  });
});

describe("M1 acceptance record", () => {
  it("is indeterminate when no record exists", () => {
    expect(readM1Acceptance(join(dir, "none.json")).ok).toBeNull();
  });

  it("is indeterminate when the record carries no determinism verdicts", () => {
    expect(readM1Acceptance(write("m1.json", { docx: {}, pdf: {} })).ok).toBeNull();
  });

  it("passes only when BOTH engines were byte-deterministic", () => {
    const ok = write("ok.json", {
      docx: { cli: { deterministic: true } },
      pdf: { cli: { deterministic: true } },
    });
    const half = write("half.json", {
      docx: { cli: { deterministic: true } },
      pdf: { cli: { deterministic: false } },
    });
    expect(readM1Acceptance(ok).ok).toBe(true);
    expect(readM1Acceptance(half).ok).toBe(false);
  });
});

describe("attestation document", () => {
  it("binds to the current commit and its own committer date", () => {
    const attestation = buildAttestation();
    // A real 40-char sha, and a date that is the COMMIT's, not wall-clock —
    // re-running on the same commit must reproduce the same bytes.
    expect(attestation.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(attestation.date)).not.toBeNaN();
    expect(buildAttestation().date).toBe(attestation.date);
  });

  it("carries every field the plan specifies", () => {
    const attestation = buildAttestation();
    expect(Object.keys(attestation).sort()).toEqual([
      "checks",
      "commit",
      "date",
      "m1AcceptanceOk",
      "securityReviewNote",
      "veraPdfBaselineDelta",
      "veraPdfDigestOk",
    ]);
  });

  it("accepts a caller-supplied review note and otherwise states the T4.7 scope", () => {
    expect(buildAttestation({ reviewNote: "reviewed by X on 2026-07-20" }).securityReviewNote).toBe(
      "reviewed by X on 2026-07-20"
    );
    expect(buildAttestation().securityReviewNote).toContain("T4.7");
  });

  it("explains every field's status in checks[]", () => {
    // The artifact must be readable without reading attest.ts: a consumer has
    // to be able to tell "checked and passed" from "could not check".
    const attestation = buildAttestation();
    const fields = attestation.checks.map((check) => check.field);
    expect(fields).toEqual([
      "veraPdfDigestOk",
      "veraPdfBaselineDelta",
      "veraPdfBaselineDocsSync",
      "m1AcceptanceOk",
    ]);
    for (const check of attestation.checks) {
      expect(["ok", "failed", "indeterminate"]).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The 011 plan says "update the page in the same PR whenever the baseline
 * changes". That was a rule with no enforcement — a reviewer had to remember
 * it. These pin the enforcement, including the direction that must NOT fail
 * (an unchanged baseline owes no docs update, or the job would be red forever).
 */
describe("baseline / docs synchronisation", () => {
  const DOCS = "src/content/docs/reference/pdf-accessibility.md";
  const moved = { added: ["blocks::7.1-1"], removed: [], changed: [] };
  const still = { added: [], removed: [], changed: [] };

  it("passes when the baseline did not move", () => {
    expect(checkBaselineDocsSync({ delta: still, changedFiles: [] }).status).toBe("ok");
  });

  it("passes when the baseline moved and the page moved with it", () => {
    expect(checkBaselineDocsSync({ delta: moved, changedFiles: ["scripts/verapdf/baseline.json", DOCS] }).status)
      .toBe("ok");
  });

  it("FAILS when the baseline moved but the page did not", () => {
    const result = checkBaselineDocsSync({ delta: moved, changedFiles: ["scripts/verapdf/baseline.json"] });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("was not updated");
  });

  it("fails on a SHRINKING baseline too, not just a growing one", () => {
    // A rule that started passing changes what the page's gap list should say
    // just as much as a new failure does.
    expect(
      checkBaselineDocsSync({
        delta: { added: [], removed: ["blocks::7.1-1"], changed: [] },
        changedFiles: ["scripts/verapdf/baseline.json"],
      }).status
    ).toBe("failed");
  });

  it("is indeterminate when the changed-file list is unavailable", () => {
    // A shallow clone cannot answer the question; that is not evidence of a
    // missing docs update.
    expect(checkBaselineDocsSync({ delta: moved, changedFiles: null }).status).toBe("indeterminate");
    expect(checkBaselineDocsSync({ delta: null, changedFiles: [] }).status).toBe("indeterminate");
  });
});

describe("exit-code policy", () => {
  const base: SecurityAttestation = {
    commit: "0".repeat(40),
    date: "2026-07-20T00:00:00Z",
    veraPdfDigestOk: null,
    veraPdfBaselineDelta: null,
    securityReviewNote: "n/a",
    m1AcceptanceOk: null,
    checks: [],
  };

  it("does not fail on indeterminate checks", () => {
    // Otherwise the job would be red on every runner without veraPDF, and a
    // permanently-red gate is a gate nobody reads.
    expect(
      hasDeterminedFailure({
        ...base,
        checks: [{ field: "veraPdfDigestOk", status: "indeterminate", detail: "no binary" }],
      })
    ).toBe(false);
  });

  it("fails on a determined failure", () => {
    expect(
      hasDeterminedFailure({
        ...base,
        checks: [
          { field: "veraPdfDigestOk", status: "indeterminate", detail: "no binary" },
          { field: "m1AcceptanceOk", status: "failed", detail: "PDF not deterministic" },
        ],
      })
    ).toBe(true);
  });
});
