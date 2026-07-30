import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import type { ScanResult } from "@atlcli/docx/scan";
import { ExportRunsProvider } from "../../components/app/export-runs.js";
import { DocxExportPanel } from "../../components/export/DocxExportPanel.js";
import { I18nProvider } from "../../utils/i18n/context.js";
import type { DocxExportPort, DocxTemplateStore } from "../../utils/ports/index.js";
import { createReactHarness } from "../react-harness.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => {
  expect(dom.leakedGlobals()).toEqual([]);
});

const SCAN: ScanResult = {
  supported: [{ base: "$scroll.title", status: "supported", count: 1, raw: ["$scroll.title"] }],
  unsupported: [],
  never: [],
  parts: ["word/document.xml"],
  hasContentPlaceholder: true,
  stylerefStyleNames: [],
};

describe("DocxExportPanel — honest preview wiring", () => {
  it("keeps Word export disabled until an explicit template is available", async () => {
    const store: DocxTemplateStore = {
      async get() {
        return null;
      },
      async put(record) {
        return { ...record, uploadedAt: 1 };
      },
      async remove() {},
    };
    const port: DocxExportPort = {
      async scan() {
        return SCAN;
      },
      async run() {
        throw new Error("export must stay disabled");
      },
    };

    await dom.render(
      <I18nProvider locale="en">
        <ExportRunsProvider identity="docx-template-required">
          <DocxExportPanel
            port={port}
            store={store}
            page={null}
            pageUrl={null}
          />
        </ExportRunsProvider>
      </I18nProvider>
    );
    await dom.flush();

    expect(dom.maybeFind("template-export")).toBeNull();
    expect((dom.find("template-export-disabled") as HTMLButtonElement).disabled).toBe(true);
    expect(dom.find("template-section").textContent).toContain("Required");
  });

  it("places the Word-rendering explanation beside the persisted template scan", async () => {
    const bytes = new ArrayBuffer(8);
    const warmOptions: unknown[] = [];
    const store: DocxTemplateStore = {
      async get() {
        return { name: "report.docx", uploadedAt: 1, bytes };
      },
      async put(record) {
        return { ...record, uploadedAt: 1 };
      },
      async remove() {},
    };
    const port: DocxExportPort = {
      async scan() {
        return SCAN;
      },
      async run() {
        throw new Error("export is not part of this view test");
      },
      async warm(options) {
        warmOptions.push(options);
      },
    };

    await dom.render(
      <I18nProvider locale="en">
        <ExportRunsProvider identity="docx-preview-copy">
          <DocxExportPanel
            port={port}
            store={store}
            page={null}
            pageUrl={null}
            scopeRequest={{ codeTheme: "github-dark" }}
          />
        </ExportRunsProvider>
      </I18nProvider>
    );
    await dom.flush();

    expect(dom.find("template-name").textContent).toBe("report.docx");
    expect(dom.find("docx-preview-explanation").textContent).toContain(
      "Word renders the final document"
    );
    expect(warmOptions).toEqual([{ codeTheme: "github-dark" }]);
  });
});
