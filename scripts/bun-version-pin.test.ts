/**
 * The Bun version pin is a correctness constraint, not housekeeping.
 *
 * `bun build --compile` embeds the *running* Bun runtime into every release
 * binary, so the version CI installs is the version users execute. Bun 1.3.5
 * miscompiles the Typst wasm module the PDF exporter runs: exporting a page
 * whose Confluence-list datasource fills a ~100-row × 8-column table crashes
 * the process inside `BrowserPdfCompiler.compile` — SIGSEGV on linux/arm64,
 * SIGILL on linux/x86-64, roughly nine runs in ten, and never on macOS. That is
 * why `export-source-contract.test.ts`'s Confluence-list block had never passed in CI
 * while passing on every developer's Mac.
 *
 * Measured in a `oven/bun:1.3.5-debian` container against the real fixture
 * (`REPRO_ROWS=150`): 1.3.5 crashed 11/12 (arm64) and 5/6 (x86-64); 1.3.8 and
 * 1.3.14 passed 12/12 and 6/6 respectively.
 *
 * So: every workflow must install the SAME Bun that `packageManager` declares,
 * and that version must not be one we have evidence against. Pinning a bad
 * version again fails here rather than a week later in a flaky parity job.
 */
import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

/**
 * Versions with a reproduced, release-affecting defect. Adding one here is a
 * claim about evidence — record what was measured, as above.
 */
const KNOWN_BAD_BUN_VERSIONS = new Set(["1.3.5"]);

/**
 * Non-literal `bun-version` values that are deliberately not a fixed version:
 * the `env.BUN_VERSION` indirection in `release.yml` (whose literal is checked
 * through the env assignment itself) and the `steps.pin.outputs.version` /
 * matrix expressions that read the version out of `packageManager`, which is
 * strictly better than repeating the literal because it cannot drift.
 *
 * `latest` is NOT on this list — see {@link latestOnlyOnNonBlockingJobs}.
 */
const ALLOWED_NON_LITERAL =
  /^(\$\{\{\s*env\.BUN_VERSION\s*\}\}|\$\{\{\s*steps\.pin\.outputs\.version\s*\}\}|\$\{\{\s*matrix\.leg\s*==\s*'pinned'\s*&&\s*steps\.pin\.outputs\.version\s*\|\|\s*'latest'\s*\}\})$/;

/**
 * A floating `latest` is allowed ONLY where a red result cannot block anyone —
 * i.e. the job (or its matrix leg) carries `continue-on-error`.
 *
 * The reason is diagnostic, not stylistic. Bun 1.3.5 crashed the Typst wasm
 * compile on Linux; the failure surfaced as a red check that looked exactly
 * like our own regression, and separating the two took a container repro and
 * several hours. A blocking job on `latest` reproduces that ambiguity on
 * Atlassian's schedule rather than ours. A non-blocking one turns the same
 * event into a legible signal: latest red + pinned green = the runtime moved.
 */
const LATEST = "latest";

async function pinnedByPackageManager(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
  expect(match, `package.json packageManager must be "bun@<x.y.z>", got ${manifest.packageManager}`).not.toBeNull();
  return match![1]!;
}

interface Pin {
  file: string;
  line: number;
  value: string;
}

async function workflowBunPins(): Promise<Pin[]> {
  const files = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  expect(files.length, "no workflow files found — has .github/workflows moved?").toBeGreaterThan(0);
  const pins: Pin[] = [];
  for (const file of files) {
    const text = await readFile(join(WORKFLOWS_DIR, file), "utf8");
    text.split("\n").forEach((raw, index) => {
      const match = /^\s*(?:bun-version|BUN_VERSION):\s*(.+?)\s*$/.exec(raw);
      if (!match) return;
      pins.push({ file, line: index + 1, value: match[1]!.replace(/^['"]|['"]$/g, "") });
    });
  }
  return pins;
}

describe("Bun version pin", () => {
  it("never pins a Bun version with a reproduced, release-affecting defect", async () => {
    const declared = await pinnedByPackageManager();
    expect(
      KNOWN_BAD_BUN_VERSIONS.has(declared),
      `package.json pins bun@${declared}, which is on the known-bad list (see this file's header).`
    ).toBe(false);

    for (const pin of await workflowBunPins()) {
      expect(
        KNOWN_BAD_BUN_VERSIONS.has(pin.value),
        `${pin.file}:${pin.line} installs Bun ${pin.value}, which is on the known-bad list (see this file's header).`
      ).toBe(false);
    }
  });

  it("installs the same Bun in every workflow that `packageManager` declares", async () => {
    const declared = await pinnedByPackageManager();
    const pins = await workflowBunPins();
    // A drift guard that never sees a literal pin guards nothing.
    expect(
      pins.filter((p) => !ALLOWED_NON_LITERAL.test(p.value)).length,
      "expected at least one literal bun-version pin to check"
    ).toBeGreaterThan(0);

    for (const pin of pins) {
      if (pin.value === LATEST) continue; // covered by the next test
      if (ALLOWED_NON_LITERAL.test(pin.value)) continue;
      expect(
        pin.value,
        `${pin.file}:${pin.line} installs Bun ${pin.value} but package.json declares bun@${declared}. ` +
          `CI must run the runtime the release binaries embed.`
      ).toBe(declared);
    }
  });

  it("declares the same Bun to local toolchain managers as to CI", async () => {
    // Without this, `.tool-versions` is the one place the version can drift
    // unnoticed: nothing in CI reads it, so a stale entry silently puts every
    // developer on a different runtime than the one the release binaries
    // embed — which is how a runtime-specific defect reaches users after
    // passing on every machine that mattered.
    const declared = await pinnedByPackageManager();
    const toolVersions = await readFile(join(REPO_ROOT, ".tool-versions"), "utf8");
    const match = /^bun\s+(\S+)\s*$/m.exec(toolVersions);
    expect(match, ".tool-versions must carry a `bun <version>` line").not.toBeNull();
    expect(
      match![1],
      `.tool-versions pins bun ${match![1]} but package.json declares bun@${declared}.`
    ).toBe(declared);
  });

  it("only floats on `latest` where a red result cannot block anyone", async () => {
    // Match pins that CAN RESOLVE to `latest`, not only those that spell it
    // literally. The consumer-smoke pin is a matrix expression whose `latest`
    // branch is real but invisible to an equality check — an earlier version of
    // this test compared `=== "latest"`, found nothing, and passed vacuously
    // while a blocking floating pin sat right there.
    const floating = (await workflowBunPins()).filter((p) => new RegExp(`\\b${LATEST}\\b`).test(p.value));
    expect(
      floating.length,
      "no pin can resolve to `latest` — if that is now true by design, delete this test rather than letting it pass on an empty set"
    ).toBeGreaterThan(0);

    for (const pin of floating) {
      const text = await readFile(join(WORKFLOWS_DIR, pin.file), "utf8");
      expect(
        /^\s*continue-on-error:/m.test(text),
        `${pin.file}:${pin.line} installs Bun \`latest\` on a job that can block. ` +
          `A floating runtime that gates a merge makes "the runtime regressed" ` +
          `indistinguishable from "we regressed" — which is exactly how Bun 1.3.5 ` +
          `cost hours of diagnosis. Either pin it, or mark the job continue-on-error ` +
          `so it reads as an early warning.`
      ).toBe(true);
    }
  });
});
