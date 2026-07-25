/**
 * Spec 012 T6.4 — default-output parity proof.
 *
 * The whole point of the 012 migration is that moving the built-in template's
 * hardcoded presentation into typed manifest data changes NOTHING observable.
 * This test proves it against the REAL Typst compiler (the same
 * `BrowserPdfCompiler` + pinned wasm + bundled fonts the CLI and browser hosts
 * use): it compiles the built-in template's default output over a document that
 * exercises the full migrated surface — every typography role, both semantic
 * palettes, and the component set — and asserts the PDF's sha256 equals the
 * digest captured from the pre-migration engine.
 *
 * A default-output change of ANY kind fails here: review the exact cause and
 * re-baseline only for an intentional, separately-tested product change (spec
 * 012 T6.4 STOP condition).
 *
 * Nothing is mocked: real compiler, real fonts, real manifest validation.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  type ExportBlock,
  type PdfExportMetadata,
} from "@atlcli/pdf/browser";
import { serializePdfDocument } from "@atlcli/pdf/internal";
import { BUILTIN_PDF_DESIGN } from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler, PDF_BROWSER_COMPILER_VERSION } from "./index.js";

/**
 * Approved sha256 of the built-in template's default PDF over
 * {@link PARITY_BLOCKS} with the pinned compiler
 * `typst.ts 0.7.0 / Typst 0.14.2`.
 *
 * The original pre-migration digest was intentionally superseded after commit
 * `147a617` separated rich heading presentation from the plain navigation
 * title used by outlines and running heads. That product fix keeps Confluence
 * foreground/background colors out of the ToC and is covered by dedicated
 * PDF tests; changing the Typst structure necessarily changed the PDF bytes.
 *
 * Commit `150bc39` then retained authored code-block presentation and bounded
 * long lines through a scoped `raw.line` rule. The parity corpus includes a
 * code block, so that separately tested intentional Typst change superseded
 * the prior approved bytes too.
 *
 * The 2026-07-24 semantic-callout-icon change deliberately adds labelled
 * graphical figures to the four standard callouts in this corpus. Dedicated
 * serializer, structure, accessibility, and rendered-golden tests pin that
 * behavior; this digest approves the resulting default PDF bytes.
 */
// Reviewed issue-102 baseline: explicit prepared Shiki tokens replace Typst's
// renderer-owned raw highlighting and add proportional code-line spacing while
// preserving source text and structure.
const APPROVED_DEFAULT_OUTPUT_DIGEST = "5708085239a95d02af4daf559a2c535dfa41e0d25eae32580c24d9c16efbae1d";
const PINNED_COMPILER = "typst.ts 0.7.0 / Typst 0.14.2";

const PARITY_BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Design Surface" }] },
  { type: "paragraph", content: [{ type: "text", text: "Body copy exercising the serif body role and default ink." }] },
  { type: "heading", level: 2, content: [{ type: "text", text: "Second level" }] },
  { type: "heading", level: 3, content: [{ type: "text", text: "Third level" }] },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "Inline ", marks: ["bold"] },
      { type: "text", text: "and " },
      { type: "status", text: "DONE", color: "green" },
      { type: "text", text: " and a mention " },
      { type: "mention", displayName: "Ada", accountId: "a1" },
    ],
  },
  {
    type: "list",
    ordered: false,
    items: [
      { content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet one" }] }] },
      { content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet two" }] }] },
    ],
  },
  {
    type: "list",
    ordered: true,
    items: [
      { content: [{ type: "paragraph", content: [{ type: "text", text: "Ordered one" }] }] },
      { content: [{ type: "paragraph", content: [{ type: "text", text: "Ordered two" }] }] },
    ],
  },
  {
    type: "list",
    ordered: false,
    items: [
      { content: [{ type: "paragraph", content: [{ type: "text", text: "Task done" }] }], checked: true },
      { content: [{ type: "paragraph", content: [{ type: "text", text: "Task open" }] }], checked: false },
    ],
  },
  { type: "codeBlock", language: "ts", code: "const x = 1;\n" },
  { type: "callout", kind: "info", title: "Info", content: [{ type: "paragraph", content: [{ type: "text", text: "info body" }] }] },
  { type: "callout", kind: "note", title: "Note", content: [{ type: "paragraph", content: [{ type: "text", text: "note body" }] }] },
  { type: "callout", kind: "warning", title: "Warning", content: [{ type: "paragraph", content: [{ type: "text", text: "warn body" }] }] },
  { type: "callout", kind: "tip", title: "Tip", content: [{ type: "paragraph", content: [{ type: "text", text: "tip body" }] }] },
  { type: "callout", kind: "panel", content: [{ type: "paragraph", content: [{ type: "text", text: "panel body" }] }] },
  {
    type: "table",
    rows: [
      {
        cells: [
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Key" }] }] },
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
        ],
      },
      {
        cells: [
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "alpha" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "beta" }] }] },
        ],
      },
    ],
  },
];

const PARITY_METADATA: PdfExportMetadata = {
  title: "Parity Baseline",
  space: "DOCSY",
  version: 7,
  author: "Ada Lovelace",
  exporter: "atlcli",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-19T00:00:00.000Z"),
};

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer());
}

async function createCompiler(): Promise<BrowserPdfCompiler> {
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  return new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function compileDefault(compiler: BrowserPdfCompiler): Promise<Uint8Array> {
  const prepared = await preparePdfDocument(PARITY_BLOCKS, {
    resolve: async () => {
      throw new Error("the parity fixture has no external assets");
    },
  });
  const bundle = serializePdfDocument(prepared, { metadata: PARITY_METADATA, settings: {} });
  const result = await compiler.compile(bundle);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`parity fixture failed to compile: ${JSON.stringify(errors)}`);
  return result.pdf!;
}

describe("spec 012 default-output parity (real compiler)", () => {
  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    await ensureVendoredTypst();
  });

  it("the built-in template's default output matches the approved baseline", async () => {
    const compiler = await createCompiler();
    // Refuse to compare across compiler versions — a version bump changes bytes
    // for reasons unrelated to this migration.
    expect(PDF_BROWSER_COMPILER_VERSION).toBe(PINNED_COMPILER);
    const pdf = await compileDefault(compiler);
    expect(sha256Hex(pdf)).toBe(APPROVED_DEFAULT_OUTPUT_DIGEST);
  }, 120_000);

  it("the digest comparison rejects a deliberately altered output (guards the guard)", async () => {
    // Mirrors 011's infrastructure test for its own parity checker: prove the
    // sha256 equality gate would actually catch a regression, not silently pass.
    const compiler = await createCompiler();
    const pdf = await compileDefault(compiler);
    const tampered = Uint8Array.from(pdf);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff; // flip one byte
    expect(sha256Hex(tampered)).not.toBe(APPROVED_DEFAULT_OUTPUT_DIGEST);
    expect(sha256Hex(tampered)).not.toBe(sha256Hex(pdf));
  }, 120_000);

  it("the built-in design still authors every migrated role and token (guards the fixture)", () => {
    // If a role/token key is dropped from the manifest, the template throws at
    // generation time — this asserts the surface the parity fixture exercises.
    expect(Object.keys(BUILTIN_PDF_DESIGN.typography.roles).length).toBeGreaterThanOrEqual(18);
    expect(Object.keys(BUILTIN_PDF_DESIGN.semanticPalettes.callouts)).toContain("panel");
    expect(BUILTIN_PDF_DESIGN.tokens.colors.accent).toBe("#4B57A3");
  });
});
