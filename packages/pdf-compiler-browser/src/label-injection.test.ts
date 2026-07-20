/**
 * Spec 012 security regression — manifest localization can never execute code.
 *
 * Before the fix, a `.wiki-pdf-template` manifest whose `localization` carried a
 * document-label KEY like `x: panic("INJECTED-CODE-RAN"), y` passed
 * `validateManifest` and was interpolated RAW into the generated Typst
 * `labels: (…)` dictionary — escaping the key position and being evaluated as
 * code. Against the real compiler that produced:
 *
 *     error: panicked with: "INJECTED-CODE-RAN"
 *
 * …i.e. manifest DATA ran as CODE. With `eval()`/`read()` it would have run
 * silently. `validateManifest` is the import gate for third-party template
 * containers, so this is a sandbox escape, not a formatting bug.
 *
 * Three independent layers now close it (defence in depth). This test proves the
 * end-to-end outcome against the REAL Typst compiler: even a manifest that
 * BYPASSES the import gate entirely cannot get a payload into the source.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { PDF_RUNTIME_ASSETS, preparePdfDocument, type ExportBlock } from "@atlcli/pdf/browser";
import { BUILTIN_PDF_TEMPLATE_MANIFEST, serializePdfDocument } from "@atlcli/pdf/internal";
import { validateManifest } from "@atlcli/template-pack";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

const PAYLOAD = "INJECTED-CODE-RAN";
const HOSTILE_KEY = `x: panic("${PAYLOAD}"), y`;

const BLOCKS: ExportBlock[] = [
  { type: "paragraph", content: [{ type: "text", text: "body" }] },
];

async function createCompiler(): Promise<BrowserPdfCompiler> {
  const [wasm, ...fonts] = await Promise.all([
    Bun.file(fileURLToPath(import.meta.resolve("@atlcli/pdf-compiler-browser/wasm")))
      .arrayBuffer()
      .then((b) => new Uint8Array(b)),
    ...PDF_RUNTIME_ASSETS.fonts.map((f) =>
      Bun.file(fileURLToPath(import.meta.resolve(`@atlcli/pdf/fonts/${f.fileName}`)))
        .arrayBuffer()
        .then((b) => new Uint8Array(b))
    ),
  ]);
  return new BrowserPdfCompiler({ wasm: wasm.buffer as ArrayBuffer, fonts });
}

describe("spec 012 — localization label injection is closed (real compiler)", () => {
  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    await ensureVendoredTypst();
  });

  it("layer 1: the manifest import gate rejects a hostile label key", () => {
    const raw = JSON.parse(JSON.stringify(BUILTIN_PDF_TEMPLATE_MANIFEST)) as Record<string, unknown>;
    const loc = raw.localization as { locales: { en: { document: Record<string, string> } } };
    loc.locales.en.document[HOSTILE_KEY] = "boom";
    expect(() => validateManifest(raw)).toThrow(/key must be a safe identifier/);
  });

  it("layers 2+3: a manifest bypassing the gate still cannot inject code", async () => {
    // Construct the manifest object DIRECTLY — no validateManifest — to simulate
    // a bypass (a forged object, or a future/looser schema path).
    const forged = JSON.parse(JSON.stringify(BUILTIN_PDF_TEMPLATE_MANIFEST)) as typeof BUILTIN_PDF_TEMPLATE_MANIFEST;
    forged.localization!.locales.en!.document![HOSTILE_KEY] = "boom";

    const prepared = await preparePdfDocument(BLOCKS, {
      resolve: async () => {
        throw new Error("no assets");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: { title: "T", exportedAt: new Date("2026-07-19T00:00:00.000Z") },
      templateManifest: forged,
    });

    // The payload never reaches the generated source at all (vocabulary filter).
    expect(bundle.main).not.toContain(PAYLOAD);
    expect(bundle.main).not.toContain("panic(");

    // And the real compiler produces a clean document — no panic, real PDF.
    const compiler = await createCompiler();
    const result = await compiler.compile(bundle);
    const messages = result.diagnostics.map((d) => d.message).join("\n");
    expect(messages).not.toContain(PAYLOAD);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
  }, 120_000);
});
