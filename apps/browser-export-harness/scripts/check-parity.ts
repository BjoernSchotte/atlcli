/**
 * Shape-parity gate (spec 011, T4.x — the single most important deliverable of
 * this lane; spec 012's start is gated on it landing).
 *
 * The browser harness (Playwright) runs the shared `@atlcli/export-fixtures`
 * through the BROWSER export packages (real module Worker + Typst WASM) and
 * writes a digest manifest to `test-results/digests.json`. This script runs the
 * SAME fixtures through the Bun/CLI export path — the identical
 * `BrowserPdfCompiler` (same pinned wasm + fonts) the CLI uses via
 * `getPdfCompiler` — computes the same digests, and asserts byte-level and
 * report-projection equivalence. A divergence names the case and the first
 * divergent digest or report code.
 *
 * Everything is real: no mocks, real Typst compile, real fonts. Every compile is
 * wrapped in a wall-clock deadline (`compile-timeout`) so a pathological fixture
 * can never hang CI (spec 011 compiler-execution-budget, CI-script scope).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type PdfAssetResolver,
  type PdfCompilePort,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import {
  PDF_SETTINGS_A,
  PDF_SETTINGS_B,
  PDF_SETTINGS_BLOCKS,
  PDF_SETTINGS_METADATA,
} from "@atlcli/export-fixtures";
import { ensurePdfFonts } from "../../../packages/pdf/scripts/ensure-fonts.js";
import { MemoryOutputSink } from "../src/memory-output.js";
import { compareReportProjection, projectNotes, sha256Hex } from "./parity-compare.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIGEST_MANIFEST = resolve(HERE, "../test-results/digests.json");
const COMPILE_DEADLINE_MS = 120_000;

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The deterministic parity fixture has no external assets.");
  },
};

function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
}

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve(specifier));
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/** A compile port with a wall-clock deadline — a hang becomes a `compile-timeout`. */
function deadlineCompiler(inner: PdfCompilePort): PdfCompilePort {
  return {
    async compile(bundle, context) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`compile-timeout after ${COMPILE_DEADLINE_MS}ms`);
          (error as Error & { code?: string }).code = "compile-timeout";
          reject(error);
        }, COMPILE_DEADLINE_MS);
      });
      try {
        return await Promise.race([inner.compile(bundle, context), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

async function buildBunCompiler(): Promise<PdfCompilePort> {
  await ensurePdfFonts({ logger: () => {} });
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@myriaddreamin/typst-ts-web-compiler/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  const compiler = new BrowserPdfCompiler({
    wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
    fonts,
  });
  return deadlineCompiler(compiler);
}

interface PdfSettingsCliResult {
  compilerVersion: string;
  digests: Record<string, string>;
  notes: Array<{ code: string; level: string }>;
}

async function runPdfSettingsCli(compiler: PdfCompilePort): Promise<PdfSettingsCliResult> {
  async function compileWith(settings: typeof PDF_SETTINGS_A): Promise<{ bytes: Uint8Array; version: string; notes: Array<{ code: string; level: string }> }> {
    const output = new MemoryOutputSink();
    const report = await runPdfExport(
      {
        blocks: PDF_SETTINGS_BLOCKS,
        metadata: PDF_SETTINGS_METADATA,
        settings,
        profile: "tagged",
        filename: "PDF Settings Conformance.pdf",
      },
      { assets: noAssets, compiler, output, now: deterministicClock() },
    );
    return {
      bytes: output.single.bytes,
      version: report.compilerVersion,
      notes: report.notes.map((n) => ({ code: n.code, level: n.level })),
    };
  }
  const a = await compileWith(PDF_SETTINGS_A);
  const b = await compileWith(PDF_SETTINGS_B);
  return {
    compilerVersion: a.version,
    digests: { "variant-a.pdf": sha256Hex(a.bytes), "variant-b.pdf": sha256Hex(b.bytes) },
    notes: a.notes,
  };
}

interface BrowserPdfSettingsResult {
  compilerVersion: string;
  digests: Record<string, string>;
  reportNotes: Array<{ code: string; severity: string }>;
}

function loadBrowserManifest(): Record<string, BrowserPdfSettingsResult> | null {
  try {
    return JSON.parse(readFileSync(DIGEST_MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

function fail(lines: string[]): never {
  for (const line of lines) process.stderr.write(`check-parity: ${line}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const compiler = await buildBunCompiler();
  const cli = await runPdfSettingsCli(compiler);

  const manifest = loadBrowserManifest();
  if (!manifest) {
    process.stdout.write(
      "check-parity: browser digest manifest not found at test-results/digests.json.\n" +
        "Run the Playwright harness first (`bun run test:browser-export-harness`).\n" +
        `CLI-side pdf-settings digests: ${JSON.stringify(cli.digests)}\n`,
    );
    process.exit(1);
  }

  const failures: string[] = [];
  const browser = manifest["pdf-settings"];
  if (!browser) {
    failures.push("case pdf-settings: missing from the browser digest manifest");
  } else {
    if (browser.compilerVersion !== cli.compilerVersion) {
      failures.push(
        `case pdf-settings: compiler version mismatch (browser ${browser.compilerVersion} vs cli ${cli.compilerVersion}) — refusing to diff bytes`,
      );
    } else {
      for (const key of Object.keys(cli.digests)) {
        const b = browser.digests?.[key];
        const c = cli.digests[key];
        if (b !== c) {
          failures.push(`case pdf-settings: "${key}" digest differs (browser ${String(b).slice(0, 16)} vs cli ${c.slice(0, 16)})`);
        }
      }
      const reportFailures = compareReportProjection(
        projectNotes(browser.reportNotes ?? []),
        projectNotes(cli.notes),
      );
      for (const detail of reportFailures) failures.push(`case pdf-settings: ${detail}`);
    }
  }

  if (failures.length > 0) fail(failures);
  process.stdout.write(`check-parity: OK — pdf-settings byte + report parity holds (${cli.compilerVersion})\n`);
}

await main();
