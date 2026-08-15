import { describe, expect, it } from "bun:test";
import {
  createChromeBaselineProvenance,
  selectResumableResults,
  type ChromeBaselineProvenanceInput,
} from "./resume-provenance.js";

function input(): ChromeBaselineProvenanceInput {
  return {
    gitCommit: "abc123",
    workingTreeDirty: true,
    treeFingerprint: "tree-1",
    harnessFixtureDigest: "harness-1",
    browser: { product: "Chrome/140", jsVersion: "14" },
    platform: "darwin",
    release: "25.4.0",
    architecture: "arm64",
    configuration: {
      pages: [50, 500],
      formats: ["docx", "pdf"],
      repeat: 3,
      seed: 2_654_435_769,
    },
  };
}

function report(provenance = createChromeBaselineProvenance(input())) {
  return {
    schema: "atlcli.pre-queue-export-baseline/1",
    state: "pre-queue",
    shape: "browser-extension-harness",
    provenance,
    results: [{ pages: 50, format: "docx", repetition: 1, provenanceFingerprint: provenance.fingerprint }],
  };
}

describe("Chrome baseline resume provenance", () => {
  it("accepts only results carrying the exact current provenance", () => {
    const current = createChromeBaselineProvenance(input());
    expect(selectResumableResults(report(current), current)).toHaveLength(1);
  });

  it.each([
    ["git commit", { gitCommit: "def456" }],
    ["dirty state", { workingTreeDirty: false }],
    ["tree", { treeFingerprint: "tree-2" }],
    ["harness", { harnessFixtureDigest: "harness-2" }],
    ["browser", { browser: { product: "Chrome/141", jsVersion: "14" } }],
    ["OS", { platform: "linux" }],
    ["architecture", { architecture: "x64" }],
    ["complete config", { configuration: { ...input().configuration, repeat: 4 } }],
  ])("rejects a changed %s", (_label, change) => {
    const previous = createChromeBaselineProvenance(input());
    const current = createChromeBaselineProvenance({ ...input(), ...change } as ChromeBaselineProvenanceInput);
    expect(() => selectResumableResults(report(previous), current)).toThrow("different provenance");
  });

  it("rejects legacy and per-result provenance gaps", () => {
    const current = createChromeBaselineProvenance(input());
    expect(() => selectResumableResults({ ...report(current), provenance: undefined }, current)).toThrow(
      "different provenance",
    );
    expect(() =>
      selectResumableResults(
        { ...report(current), results: [{ pages: 50, format: "docx", repetition: 1 }] },
        current,
      ),
    ).toThrow("without matching provenance");
  });

  it("detects a stored provenance payload changed without recomputing its fingerprint", () => {
    const current = createChromeBaselineProvenance(input());
    const tampered = { ...current, browser: { product: "Chrome/999" } };
    expect(() => selectResumableResults(report(tampered), current)).toThrow("different provenance");
  });
});
