import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extensionRoot = join(import.meta.dir, "..", "..");
const mainSource = readFileSync(
  join(extensionRoot, "entrypoints", "sidepanel", "main.tsx"),
  "utf8"
);
/**
 * The lazy-load boundary moved with the code it guards: spec 010 Phase 0 took
 * the DOCX effect half out of `TemplateSection.tsx` (now a compatibility
 * re-export) and into the Chrome adapter, so that is where the dynamic imports
 * now have to be. The invariant is unchanged — a static import of
 * `@atlcli/docx/browser` or `/scan` would drag PizZip, docxtemplater and the
 * OOXML serializer into the panel's initial chunk for every user, including the
 * ones who never upload a template.
 */
const templateSource = readFileSync(
  join(extensionRoot, "entrypoints", "sidepanel", "ports", "docx.ts"),
  "utf8"
);

describe("DOCX browser bootstrap boundary", () => {
  it("installs the package runtime as the side-panel entry's first import", () => {
    const firstImport = mainSource.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "@atlcli/docx/browser-runtime";');
    expect(mainSource).not.toContain("byte-helpers-shim");
  });

  it("keeps runtime DOCX engine modules behind dynamic imports", () => {
    const staticRuntimeImport =
      /import\s+(?!type\b)[^;]*from\s+["']@atlcli\/docx\/(?:browser|scan)["']/;
    expect(templateSource).not.toMatch(staticRuntimeImport);
    expect(templateSource).toContain('import("@atlcli/docx/browser")');
    expect(templateSource).toContain('import("@atlcli/docx/scan")');
  });
});
