import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

it("keeps source-specific DOCX/PDF policy and concrete clients outside the shared publisher", () => {
  const source = readFileSync(join(root, "publisher.ts"), "utf8");
  for (const forbidden of [
    "ImportComment",
    "baseline",
    "recipe",
    "batch",
    "update-page",
    "ConfluenceClient",
    "docx-import",
    "pdf-import",
    "node:",
  ]) {
    expect(source).not.toContain(forbidden);
  }
  expect(source).not.toContain("document.sourceKind ===");
  expect(source).toContain("CloudImportClientPort");
  expect(source).toContain("DcImportClientPort");
});
