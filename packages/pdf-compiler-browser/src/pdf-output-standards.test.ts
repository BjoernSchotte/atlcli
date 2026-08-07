import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type PdfBytesHandle,
} from "@atlcli/pdf/browser";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer(),
  );
}

let compiler: BrowserPdfCompiler;

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
      packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)
    ),
  ]);
  compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}, 120_000);

afterAll(async () => {
  await compiler?.reset();
});

describe("strict PDF output standards through the neutral export runner", () => {
  it("returns inspected evidence for a real PDF/A-2u file and emits those exact bytes", async () => {
    let emitted: Uint8Array | undefined;
    const report = await runPdfExport({
      blocks: [
        { type: "heading", level: 1, content: [{ type: "text", text: "Archive" }] },
        { type: "paragraph", content: [{ type: "text", text: "Durable text." }] },
      ],
      metadata: {
        title: "PDF/A canary",
        language: "en",
        exportedAt: new Date("2026-08-07T00:00:00Z"),
      },
      filename: "archive.pdf",
      outputPolicy: {
        schema: "atlcli.pdf-output-policy/1",
        standards: ["a-2u"],
      },
    }, {
      assets: { resolve: async () => { throw new Error("no assets"); } },
      compiler,
      output: {
        emit: async (_name: string, bytes: PdfBytesHandle) => {
          emitted = await bytes.asUint8Array();
        },
      },
    });
    expect(emitted).toBeDefined();
    expect(new TextDecoder("latin1").decode(emitted!.subarray(0, 8))).toBe("%PDF-1.7");
    expect(report.outputPolicy?.standards).toEqual(["a-2u"]);
    expect(report.outputStandardEvidence).toMatchObject({
      requestedStandard: "a-2u",
      basePdfVersion: "1.7",
      pdfa: { part: "2", conformance: "U" },
      hasDocumentIdentifier: true,
      tagged: true,
      hasLang: true,
    });
    expect(report.outputStandardEvidence!.embeddedFontFiles).toBeGreaterThan(0);
  }, 180_000);
});
