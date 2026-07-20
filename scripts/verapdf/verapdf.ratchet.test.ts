/**
 * veraPDF PDF/UA ratchet — self-skipping integration (spec 011, PDF/UA).
 *
 * Compiles the conformance corpus to real tagged PDFs, runs the official veraPDF
 * CLI (`--flavour ua1 --format json`) over them, self-checks the CANARY first
 * (an unexpected canary result fails the job with a distinct "veraPDF tool
 * broken" message, catching a bad pin / silent upgrade before it is mistaken for
 * a baseline regression), then ratchets every other fixture against
 * `baseline.json`. Requires the `verapdf` binary in the runner image; when it is
 * absent the test SKIPS (green locally, gated on the CI job that installs it) —
 * the same pattern as the STYLEREF LibreOffice smoke. The ratchet LOGIC is
 * unit-tested separately in `ratchet.test.ts` (no binary needed).
 *
 * NOTE: veraPDF binary pinning by sha256 (`verapdf.lock.json`) and the
 * `verapdf.yml` nightly/release workflow are the CI half of this task and are
 * annotated pending in the PLAN — this file is the runnable gate.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileCorpus } from "./compile-corpus.js";
import { parseVeraPdfReport, ratchet, type Baseline, type RuleFailure } from "./ratchet.js";

function which(cmd: string): boolean {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}
const HAVE_VERAPDF = which("verapdf");

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, "baseline.json");

function runVeraPdf(pdfPath: string): unknown {
  const res = spawnSync("verapdf", ["--flavour", "ua1", "--format", "json", pdfPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // veraPDF exits non-zero when a document is non-compliant; that is expected —
  // parse stdout regardless. A missing stdout is a real tool failure.
  if (!res.stdout) throw new Error(`veraPDF produced no output for ${pdfPath}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

describe("veraPDF PDF/UA ratchet (self-skipping)", () => {
  it.skipIf(!HAVE_VERAPDF)("canary self-check passes and the corpus holds the baseline", async () => {
    const paths = await compileCorpus();
    const byId = new Map(paths.map((p) => [p.replace(/.*\/([^/]+)\.pdf$/, "$1"), p]));

    // 1. Canary first — a known-good minimal PDF. Any failure here means the
    //    veraPDF tool/pin is broken, NOT a baseline regression.
    const canaryPath = byId.get("canary");
    expect(canaryPath, "canary PDF missing from the corpus").toBeTruthy();
    const canaryFailures = parseVeraPdfReport(runVeraPdf(canaryPath!), "canary");
    expect(canaryFailures, `veraPDF tool broken: the canary reported ${canaryFailures.length} failure(s)`).toEqual([]);

    // 2. Ratchet the remaining fixtures against the checked-in baseline.
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    const current: RuleFailure[] = [];
    for (const [id, path] of byId) {
      if (id === "canary") continue;
      current.push(...parseVeraPdfReport(runVeraPdf(path), id));
    }
    const result = ratchet(current, baseline);
    for (const warning of result.warnings) process.stdout.write(`verapdf-ratchet: ${warning}\n`);
    expect(result.failures, result.failures.join("\n")).toEqual([]);
  });
});
