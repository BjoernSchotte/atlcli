import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extensionRoot = join(import.meta.dir, "..", "..");
const mainSource = readFileSync(
  join(extensionRoot, "entrypoints", "sidepanel", "main.tsx"),
  "utf8"
);
const offscreenSource = readFileSync(
  join(extensionRoot, "entrypoints", "offscreen", "main.ts"),
  "utf8"
);
const executorSource = readFileSync(
  join(extensionRoot, "utils", "export-jobs", "docx-executor.ts"),
  "utf8"
);
/**
 * The lazy-load boundary moved with the code it guards: spec 010 Phase 0 took
 * the DOCX effect half out of `TemplateSection.tsx` (now a compatibility
 * re-export) and into the Chrome adapter. Export submission now crosses the
 * durable-job adapter and the heavy engine lives in the offscreen bundle. The
 * invariant is unchanged — the initial panel chunk must not import the scan or
 * productive DOCX runtime for users who never open that path.
 */
const templateSource = readFileSync(
  join(extensionRoot, "entrypoints", "sidepanel", "ports", "docx.ts"),
  "utf8"
);

describe("DOCX browser bootstrap boundary", () => {
  it("keeps the combined DOCX engine out of the discovery side-panel entry", () => {
    expect(mainSource).not.toContain("@atlcli/docx/browser-entry");
    expect(mainSource).not.toContain("@atlcli/docx/browser-runtime");
    expect(mainSource).not.toContain("byte-helpers-shim");
  });

  it("loads the combined entry first in the productive DOCX executor graph", () => {
    const firstImport = executorSource
      .split("\n")
      .find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "@atlcli/docx/browser-entry";');
    expect(offscreenSource).not.toMatch(/^import\s+["']@atlcli\/docx\//m);
    expect(offscreenSource).toMatch(
      /import\(\s*["']@atlcli\/docx\/browser-entry["']\s*\)/,
    );
    expect(offscreenSource).toContain('"../../utils/export-jobs/docx-executor.js"');
  });

  it("keeps the combined DOCX engine behind scan/export intent imports", () => {
    const staticRuntimeImport =
      /import\s+(?!type\b)[^;]*from\s+["']@atlcli\/docx\/browser-entry["']/;
    expect(templateSource).not.toMatch(staticRuntimeImport);
    expect(templateSource).toContain('import("@atlcli/docx/browser-entry")');
    expect(templateSource).toContain('import("../../../utils/export-jobs/docx-run.js")');
  });
});
