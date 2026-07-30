import { beforeAll, describe, expect, it } from "bun:test";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  validatePdfOutput,
} from "@atlcli/pdf";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { nodePdfCompiler } from "./pdf-env.js";

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

describe("Node PDF compiler environment", () => {
  it("loads only the resolved fonts through the installed-package adapter", async () => {
    let emitted: Uint8Array | undefined;
    const report = await runPdfExport(
      {
        blocks: [
          {
            type: "heading",
            level: 1,
            content: [{ type: "text", text: "Node heading" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Node body" }],
          },
        ],
        metadata: {
          title: "Node demand-aware font proof",
          exportedAt: new Date("2026-07-30T00:00:00.000Z"),
        },
        filename: "node-font-proof.pdf",
        settings: { cover: false, outline: false },
      },
      {
        assets: {
          async resolve() {
            throw new Error("This fixture has no assets.");
          },
        },
        compiler: await nodePdfCompiler(),
        output: {
          async emit(_name, bytes) {
            emitted = await bytes.asUint8Array();
          },
        },
      },
    );

    expect(report.fontRequirements?.assets.length).toBeLessThan(
      PDF_RUNTIME_ASSETS.fonts.length,
    );
    expect(report.fontEvidence?.registeredAssetIds).toEqual(
      report.fontRequirements?.assets.map((asset) => asset.assetId),
    );
    expect(report.fontEvidence?.fullBundleFallback).toBe(false);
    expect(validatePdfOutput(emitted!)).toMatchObject({ tagged: true });
  }, 30_000);
});
