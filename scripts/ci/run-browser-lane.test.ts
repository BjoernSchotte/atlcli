import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_LANES,
  normalizePlaywrightFailureEvidence,
  parseBrowserLane,
  suiteEvidenceDirectory,
} from "./run-browser-lane.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("browser lane plan", () => {
  test("covers every browser proof exactly once", () => {
    const tasks = Object.values(BROWSER_LANES).flat();
    expect(tasks.map((task) => task.id).sort()).toEqual([
      "jobs",
      "neutral-harness",
      "palette",
      "research",
      "rovo",
      "shape-parity",
      "worker",
    ]);
    expect(tasks.filter((task) => task.id === "shape-parity")).toHaveLength(1);
  });

  test("uses only fixed prebuilt extension commands", () => {
    const extensionTasks = Object.values(BROWSER_LANES)
      .flat()
      .filter((task) => task.suite !== "neutral");
    for (const task of extensionTasks) {
      expect(task.command.join(" ")).toContain(":prebuilt");
      expect(task.command).not.toContain("build");
    }
  });

  test("uses prebuilt neutral commands inside the parallel block", () => {
    const neutral = BROWSER_LANES["neutral-palette"].filter(
      (task) => task.suite === "neutral",
    );
    expect(neutral).toHaveLength(2);
    for (const task of neutral) expect(task.command.join(" ")).toContain(":prebuilt");
  });

  test("marks exactly the six browser suites as evidence producers", () => {
    const producers = Object.values(BROWSER_LANES)
      .flat()
      .filter((task) => task.producesEvidence)
      .map((task) => task.suite)
      .sort();
    expect(producers).toEqual([
      "jobs",
      "neutral",
      "palette",
      "research",
      "rovo",
      "worker",
    ]);
  });

  test("rejects arbitrary lane input", () => {
    expect(parseBrowserLane("jobs")).toBe("jobs");
    expect(() => parseBrowserLane("$(untrusted)")).toThrow("unknown browser lane");
    expect(() => parseBrowserLane(undefined)).toThrow("unknown browser lane");
  });

  test("derives suite-specific evidence directories", () => {
    expect(suiteEvidenceDirectory(".artifacts/browser-evidence", "research")).toEndWith(
      "/.artifacts/browser-evidence/research",
    );
    expect(() => suiteEvidenceDirectory("  ", "jobs")).toThrow(
      "ATLCLI_BROWSER_EVIDENCE_ROOT is required",
    );
  });

  test("normalizes Playwright failure media into opaque paths", () => {
    const suite = mkdtempSync(join(tmpdir(), "atlcli-neutral-evidence-"));
    roots.push(suite);
    const raw = join(suite, ".playwright", "exports tenant-shaped", "chromium");
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "trace.zip"), "trace");
    writeFileSync(join(raw, "test-failed-1.png"), "screenshot");
    writeFileSync(join(raw, "video.webm"), "video");
    writeFileSync(join(raw, "error-context.md"), "details");
    writeFileSync(join(suite, ".playwright", ".last-run.json"), '{"status":"failed"}\n');

    normalizePlaywrightFailureEvidence(suite);

    expect(readdirSync(suite)).toEqual(["failures"]);
    const failureId = readdirSync(join(suite, "failures"))[0]!;
    expect(failureId).toMatch(/^[a-f0-9]{20}$/u);
    expect(readdirSync(join(suite, "failures", failureId)).sort()).toEqual([
      "details-1.txt",
      "screenshot-1.png",
      "trace-1.zip",
      "video-1.webm",
    ]);
    expect(failureId).not.toContain("tenant");
  });

  test("rejects unexpected Playwright failure files", () => {
    const suite = mkdtempSync(join(tmpdir(), "atlcli-neutral-evidence-"));
    roots.push(suite);
    const raw = join(suite, ".playwright", "case");
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "download.pdf"), "unexpected");
    expect(() => normalizePlaywrightFailureEvidence(suite)).toThrow(
      "unsupported Playwright evidence type",
    );
  });

  test("rejects symbolic links before normalizing Playwright evidence", () => {
    const suite = mkdtempSync(join(tmpdir(), "atlcli-neutral-evidence-"));
    roots.push(suite);
    const raw = join(suite, ".playwright", "case");
    mkdirSync(raw, { recursive: true });
    const outside = join(suite, "outside.txt");
    writeFileSync(outside, "must not be published");
    symlinkSync(outside, join(raw, "details.txt"));

    expect(() => normalizePlaywrightFailureEvidence(suite)).toThrow(
      "symbolic links are forbidden",
    );
  });
});
