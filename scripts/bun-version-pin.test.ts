/**
 * The Bun version pin is a correctness constraint, not housekeeping.
 *
 * `bun build --compile` embeds the *running* Bun runtime into every release
 * binary, so the version CI installs is the version users execute. Bun 1.3.5
 * miscompiles the Typst wasm module the PDF exporter runs: exporting a page
 * whose Confluence-list datasource fills a ~100-row × 8-column table crashes
 * the process inside `BrowserPdfCompiler.compile` — SIGSEGV on linux/arm64,
 * SIGILL on linux/x86-64, roughly nine runs in ten, and never on macOS. That is
 * why `engine-parity.test.ts`'s Confluence-list block had never passed in CI
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
 * Non-literal `bun-version` values that are deliberately not pinned:
 * `latest` on the publish/consumer-smoke jobs (they verify the packages work on
 * whatever Bun a consumer has), and the `env.BUN_VERSION` indirection in
 * `release.yml` (whose literal is checked through the env assignment itself).
 */
const ALLOWED_NON_LITERAL = /^(latest|\$\{\{\s*env\.BUN_VERSION\s*\}\})$/;

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
      if (ALLOWED_NON_LITERAL.test(pin.value)) continue;
      expect(
        pin.value,
        `${pin.file}:${pin.line} installs Bun ${pin.value} but package.json declares bun@${declared}. ` +
          `CI must run the runtime the release binaries embed.`
      ).toBe(declared);
    }
  });
});
