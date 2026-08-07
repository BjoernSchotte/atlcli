/** Real Typst-WASM proof for canonical revision 5 page and running regions. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePdfTemplateDesignV3 } from "@atlcli/template-pack";
import { PDF_RUNTIME_ASSETS, type PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  BUILTIN_PDF_TEMPLATE_BASELINE_V1,
  createAtlcliTypstTemplateV5,
} from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

let compiler: BrowserPdfCompiler;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer(),
  );
}

function design() {
  return validatePdfTemplateDesignV3(
    structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1.design),
  );
}

function bundle(template: string, body = "= Body\n\nRevision 5 proof."): PdfSourceBundle {
  return {
    main: `#import "atlcli.typ": atlcli-doc

#show: atlcli-doc.with(meta: (
  title: "Revision 5 proof",
  space: "DOCSY",
  version: "v5",
  author: "atlcli",
  exporter: "atlcli",
  language: "en",
  region: "GB",
  exported-at: datetime(year: 2026, month: 8, day: 7),
  exported-label: "7 August 2026",
), settings: (:))

${body}
`,
    template,
    assets: [],
    sourceMap: [],
    notes: [],
  };
}

async function poppler(
  pdf: Uint8Array,
  command: "pdfinfo" | "pdftotext",
  args: string[] = [],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-v5-page-"));
  try {
    const path = join(directory, "proof.pdf");
    await Bun.write(path, pdf);
    const commandArgs = command === "pdftotext"
      ? [command, ...args, path, "-"]
      : [command, ...args, path];
    const process = Bun.spawn(commandArgs, { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(process.stdout).text();
    const exit = await process.exited;
    if (exit !== 0) {
      throw new Error(`${command} failed: ${await new Response(process.stderr).text()}`);
    }
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
      packageBytes(`@atlcli/pdf/fonts/${font.fileName}`),
    ),
  ]);
  compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}, 120_000);

afterAll(async () => {
  await compiler?.reset();
});

describe("canonical revision-5 page and running-region source", () => {
  it("compiles the neutral Catalog-V3 baseline with Typst 0.15.1", async () => {
    const result = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(design())),
    );
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.pdf?.byteLength).toBeGreaterThan(1_000);
  }, 120_000);

  it("emits custom landscape geometry, logical margins, binding, and PDF bleed boxes", async () => {
    const custom = design();
    custom.page = {
      format: { kind: "custom", width: "180mm", height: "240mm" },
      orientation: "landscape",
      binding: "right",
      margin: {
        mode: "logical",
        top: "18mm",
        bottom: "20mm",
        inside: "25mm",
        outside: "15mm",
      },
      bleed: {
        top: "3mm",
        bottom: "3mm",
        inside: "4mm",
        outside: "5mm",
      },
    };
    const result = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(custom)),
    );
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const info = await poppler(result.pdf!, "pdfinfo", ["-box"]);
    expect(info).toContain("Page size:");
    expect(info).toContain("TrimBox:");
    expect(info).toContain("BleedBox:");
    expect(info.match(/^TrimBox:\s+(.+)$/mu)?.[1]).not.toBe(
      info.match(/^MediaBox:\s+(.+)$/mu)?.[1],
    );
  }, 120_000);

  it("switches first, odd, and even running variants and renders current-of-total", async () => {
    const running = design();
    running.navigation = {
      ...running.navigation,
      contents: { enabled: false },
    };
    running.compositions.running.header = {
      enabled: true,
      layout: "split",
      first: "hide",
      odd: {
        start: { field: "literal", value: "ODD-MARKER" },
        end: { field: "chapterTitle" },
      },
      even: {
        start: { field: "literal", value: "EVEN-MARKER" },
        end: { field: "documentTitle" },
      },
    };
    running.compositions.running.footer = {
      enabled: true,
      layout: "single",
      first: "hide",
      odd: { center: { field: "pageNumber", numbering: "current-of-total" } },
      even: { center: { field: "pageNumber", numbering: "current-of-total" } },
    };
    const body = [1, 2, 3, 4]
      .map((page) => `= Chapter ${page}\n\nBody ${page}.`)
      .join("\n\n#pagebreak()\n\n");
    const result = await compiler.compile(
      bundle(createAtlcliTypstTemplateV5(running), body),
    );
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const text = await poppler(result.pdf!, "pdftotext", ["-layout"]);
    expect(text).toContain("ODD-MARKER");
    expect(text).toContain("EVEN-MARKER");
    expect(text).toMatch(/\b2\s*\/\s*6\b/u);
    expect((text.match(/Revision 5 proof/gu) ?? []).length).toBeGreaterThan(1);
    const bbox = await poppler(result.pdf!, "pdftotext", ["-bbox"]);
    const pages = [...bbox.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/gu)]
      .map((match) => match[1] ?? "");
    expect(pages).toHaveLength(6);
    expect(pages[0]).not.toMatch(/(?:ODD|EVEN)-MARKER/u);
    expect(pages[1]).toContain("EVEN-MARKER");
    expect(pages[2]).toContain("ODD-MARKER");
    expect(pages[3]).toContain("EVEN-MARKER");
    expect(pages[4]).toContain("ODD-MARKER");
  }, 120_000);
});
