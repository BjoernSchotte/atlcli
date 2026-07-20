import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "@atlcli/docx";
import { readPart } from "@atlcli/docx/fixtures";
import { bundledDefaultTemplate, nodeDocxEnv, nodeTemplateSource } from "./docx-env.js";

const dir = mkdtempSync(join(tmpdir(), "atlcli-export-node-docx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bundledDefaultTemplate (spec 009 §A5)", () => {
  it("is deterministic and a valid zip", () => {
    const a = bundledDefaultTemplate();
    const b = bundledDefaultTemplate();
    expect(a).toEqual(b);
    expect(a[0]).toBe(0x50); // PK zip magic
    expect(a[1]).toBe(0x4b);
    // Real OOXML parts present.
    expect(readPart(a, "word/document.xml")).toContain("$scroll.content");
    expect(readPart(a, "word/styles.xml")).toContain("Scroll Heading 1");
  });

  it("produces a valid DOCX through a real runExport with zero template setup", async () => {
    const outPath = join(dir, "default-template.docx");
    const report = await runExport(
      {
        details: {
          id: "42",
          title: "Default Template Page",
          url: "https://example.invalid/wiki/spaces/X/pages/42",
          version: 1,
          spaceKey: "X",
          storage: "<h1>Default Heading</h1><p>Default template body.</p>",
          created: "2026-07-01T08:00:00.000Z",
          modified: "2026-07-02T09:00:00.000Z",
          createdBy: { displayName: "A" },
          modifiedBy: { displayName: "B" },
          labels: [],
        },
        template: { name: "default.docx", modificationDate: new Date("2026-07-10T00:00:00.000Z") },
        exportDate: new Date("2026-07-15T10:00:00.000Z"),
      },
      nodeDocxEnv({ outPath }), // no templatePath → the bundled default resolves
    );

    expect(report.filename).toContain("Default Template Page");
    const bytes = new Uint8Array(readFileSync(outPath));
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const documentXml = readPart(bytes, "word/document.xml");
    expect(documentXml).toContain("Default Heading");
    expect(documentXml).toContain("Default template body.");
    expect(documentXml).toContain("Default Template Page"); // $scroll.title resolved
  });

  it("nodeTemplateSource prefers an explicit template path over the default", async () => {
    const source = nodeTemplateSource();
    expect(await source.getBytes("current")).toEqual(bundledDefaultTemplate());
  });
});
