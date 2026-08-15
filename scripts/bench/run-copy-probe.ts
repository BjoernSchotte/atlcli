/**
 * Copy-probe parent (issue #118 Phase 0.5): measure whole-process peak RSS of
 * isolated child scenarios so in-stage copy transients become visible —
 * `process.memoryUsage` checkpoints cannot see synchronous in-stage peaks
 * (see `bench-env.ts`), but `/usr/bin/time` peak RSS can.
 *
 *   bun --conditions=development scripts/bench/run-copy-probe.ts [--repeat 3] [--scenario name]
 *
 * Deterministic inputs; peak RSS is machine-local and compared before/after
 * on the same host (specs/issue-118-adaptive-browser-pdf-memory/RATCHET.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { median, runMeasured } from "./bench-env.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface ProbeScenario {
  name: string;
  child: string;
  args: string[];
  needsWorkDir: boolean;
}

const SCENARIOS: ProbeScenario[] = [
  {
    name: "checkpoint-assets",
    child: join(ROOT, "scripts/bench/copy-probe-child.ts"),
    args: ["checkpoint-assets"],
    needsWorkDir: true,
  },
  {
    name: "executor-collect",
    child: join(ROOT, "apps/extension/tests/export-job-baseline/copy-probe-child.ts"),
    args: ["executor-collect"],
    needsWorkDir: false,
  },
];

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repeat = Number(argValue("--repeat") ?? "3");
const only = argValue("--scenario");

const results: Array<Record<string, unknown>> = [];
for (const scenario of SCENARIOS) {
  if (only && scenario.name !== only) continue;
  const peaks: number[] = [];
  const wallMs: number[] = [];
  let marker: unknown;
  for (let run = 0; run < repeat; run += 1) {
    const workDir = scenario.needsWorkDir
      ? mkdtempSync(join(tmpdir(), `copy-probe-${scenario.name}-`))
      : undefined;
    try {
      const measured = runMeasured(
        "bun",
        [
          "--conditions=development",
          scenario.child,
          ...scenario.args,
          ...(workDir ? [workDir] : []),
        ],
        { cwd: ROOT, timeoutMs: 600_000 },
      );
      if (measured.exitCode !== 0) {
        throw new Error(
          `Copy-probe scenario ${scenario.name} failed (${measured.exitCode}):\n${measured.stderr}\n${measured.stdout}`,
        );
      }
      const markerLine = measured.stdout
        .split("\n")
        .find((line) => line.startsWith("ATLCLI_COPY_PROBE_CHILD "));
      if (!markerLine) throw new Error(`Scenario ${scenario.name} printed no marker.`);
      marker = JSON.parse(markerLine.slice("ATLCLI_COPY_PROBE_CHILD ".length));
      if (measured.peakRssBytes === null) {
        throw new Error("No /usr/bin/time flavour available; peak RSS unobservable.");
      }
      peaks.push(measured.peakRssBytes);
      wallMs.push(measured.ms);
    } finally {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    }
  }
  results.push({
    scenario: scenario.name,
    repeat,
    peakRssMiB: Number((median(peaks) / 1048576).toFixed(2)),
    peakRssRunsMiB: peaks.map((value) => Number((value / 1048576).toFixed(2))),
    wallMsMedian: Math.round(median(wallMs)),
    marker,
  });
}

console.log(`ATLCLI_COPY_PROBE\n${JSON.stringify({
  schema: "atlcli.copy-probe/1",
  bunVersion: Bun.version,
  results,
}, null, 2)}`);
