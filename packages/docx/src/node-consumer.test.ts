/**
 * Cross-host reuse proof (spec 006 Task 5): the same engine, driven through
 * `runExport` with the NODE-side env implementations — a real template file
 * on disk in, a real `.docx` file on disk out — produces output structurally
 * equal to the extension's golden capture. Runs under Bun/Node with the real
 * `Buffer`; the extension's byte-helpers shim is never imported (it lives in
 * `apps/extension`, outside this package's graph — see the import test).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "./env.js";
import { fileOutputSink, fileTemplateSource, unsupportedAssetFetcher } from "./node-adapters.js";
import {
  GOLDEN_DEPS,
  GOLDEN_DETAILS,
  GOLDEN_EXPORT_DATE,
  GOLDEN_TEMPLATE_META,
  expectMatchesGolden,
  goldenTemplateBytes,
} from "./golden.test.js";

const dir = mkdtempSync(join(tmpdir(), "atlcli-docx-node-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Node consumer (spec 006 Task 5)", () => {
  it("renders the golden fixture through filesystem env adapters, equal to the extension output", async () => {
    const templatePath = join(dir, "template.docx");
    const outPath = join(dir, "out.docx");
    writeFileSync(templatePath, goldenTemplateBytes());

    const report = await runExport(
      {
        details: GOLDEN_DETAILS,
        template: GOLDEN_TEMPLATE_META,
        exportDate: GOLDEN_EXPORT_DATE,
        deps: GOLDEN_DEPS,
      },
      {
        templates: fileTemplateSource(templatePath),
        // No asset fetcher: images degrade to `image-skipped` notes — the
        // pre-005 behavior the golden capture pins.
        output: fileOutputSink(outPath),
      }
    );

    const bytes = new Uint8Array(readFileSync(outPath));
    expectMatchesGolden({ bytes, report });
  });

  it("the unsupported asset fetcher rejects loudly if ever invoked", async () => {
    expect(unsupportedAssetFetcher().fetch({ url: "https://x/a.png" })).rejects.toThrow(
      "asset fetching is not wired"
    );
  });
});
