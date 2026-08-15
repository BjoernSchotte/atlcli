import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
  PDF_RUNTIME_ASSETS,
  PDF_OUTPUT_STANDARDS_V1,
  TYPST_PDF_STANDARDS_0_15_1,
  validatePdfOutput,
  validatePdfOutputStandard,
  type TypstPdfStandard0151,
} from "@atlcli/pdf/browser";
import { serializePdfDocument } from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer(),
  );
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headerVersion(pdf: Uint8Array): string {
  return new TextDecoder("latin1").decode(pdf.subarray(0, 16)).match(/^%PDF-(\d\.\d)/u)?.[1] ?? "";
}

function text(pdf: Uint8Array): string {
  return new TextDecoder("latin1").decode(pdf);
}

function inspectable(pdf: Uint8Array): string {
  const raw = text(pdf);
  const parts = [raw];
  const streams = /stream\r?\n/gu;
  let match: RegExpExecArray | null;
  while ((match = streams.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    while (stop > start && (pdf[stop - 1] === 0x0a || pdf[stop - 1] === 0x0d)) stop -= 1;
    try {
      parts.push(inflateSync(pdf.subarray(start, stop)).toString("latin1"));
    } catch {
      // Only metadata/object streams are relevant to this inspection.
    }
  }
  return parts.join("\n");
}

function documentId(pdf: Uint8Array): string | null {
  const value = inspectable(pdf);
  return value.match(/xmpMM:DocumentID="([^"]+)"/u)?.[1] ??
    value.match(/<xmpMM:DocumentID>([^<]+)<\/xmpMM:DocumentID>/u)?.[1] ??
    value.match(/\/ID\s*\[\s*<([^>]+)>/u)?.[1] ?? null;
}

function expectedVersion(standard: TypstPdfStandard0151): string {
  if (/^1\.[4-7]$/u.test(standard) || standard === "2.0") return standard;
  if (standard.startsWith("a-1")) return "1.4";
  if (standard.startsWith("a-4")) return "2.0";
  return "1.7";
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

const bundle = serializePdfDocument({
  blocks: [
    { type: "heading", level: 1, content: [{ type: "text", text: "Standards" }] },
    { type: "paragraph", content: [{ type: "text", text: "A tagged English document." }] },
  ],
  assets: [],
  notes: [],
}, {
  metadata: {
    title: "PDF standard canary",
    space: "DOCSY",
    author: "atlcli",
    language: "en",
    region: "GB",
    exportedAt: new Date("2026-08-07T00:00:00Z"),
  },
  settings: { cover: false, outline: false },
});

async function compile(standard?: TypstPdfStandard0151): Promise<Uint8Array> {
  const result = await compiler.compile(bundle, standard === undefined
    ? {}
    : {
      pdfOptions: { standard },
    });
  expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  expect(result.pdf).toBeDefined();
  return result.pdf!;
}

describe("pinned Typst 0.15.1 PDF output options", () => {
  it("executes every standard exposed by the pinned core through a request-scoped snapshot", async () => {
    const base = await compile();
    const baseDigest = await digest(base);
    const baseId = documentId(base);
    expect(baseId).not.toBeNull();
    for (const standard of TYPST_PDF_STANDARDS_0_15_1) {
      const pdf = await compile(standard);
      expect(headerVersion(pdf), standard).toBe(expectedVersion(standard));
      expect(documentId(pdf), standard).not.toBeNull();
      if (standard === "1.7") expect(documentId(pdf), standard).toBe(baseId);
      if (standard === "1.4") expect(documentId(pdf), standard).not.toBe(baseId);
      if (standard.startsWith("a-")) {
        expect(text(pdf), standard).toContain("pdfaid:part");
      }
      if (standard === "ua-1") {
        expect(text(pdf)).toContain("pdfuaid:part");
      }
      if (PDF_OUTPUT_STANDARDS_V1.includes(standard as never)) {
        const policy = {
          schema: "atlcli.pdf-output-policy/1" as const,
          standards: [standard] as [typeof standard],
        };
        expect(
          validatePdfOutputStandard(pdf, policy as never, validatePdfOutput(pdf)),
        ).toMatchObject({ requestedStandard: standard });
      }
      if (standard !== "1.7") {
        expect(await digest(pdf), standard).not.toBe(baseDigest);
      }
    }
  }, 180_000);

  it("does not leak an explicit standard into the next warm compile", async () => {
    const before = await compile();
    const ua = await compile("ua-1");
    const after = await compile();
    expect(text(ua)).toContain("pdfuaid:part");
    expect(text(after)).not.toContain("pdfuaid:part");
    expect(await digest(after)).toBe(await digest(before));
  }, 120_000);

  it("honors cancellation before a standard-specific snapshot is compiled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(compiler.compile(bundle, {
      signal: controller.signal,
      pdfOptions: { standard: "ua-1" },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(text(await compile())).not.toContain("pdfuaid:part");
  }, 120_000);
});
