import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extensionRoot = join(import.meta.dir, "..", "..");
const mainSource = readFileSync(
  join(extensionRoot, "entrypoints", "sidepanel", "main.tsx"),
  "utf8"
);
const templateSource = readFileSync(
  join(extensionRoot, "entrypoints", "sidepanel", "TemplateSection.tsx"),
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
