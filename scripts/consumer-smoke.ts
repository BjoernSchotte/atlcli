#!/usr/bin/env bun
/**
 * Consumer smoke (spec 009, Consumer smoke) — tarball-install suite + the
 * shared machinery used by the filesystem-link and Node-LTS suites.
 *
 * Everything here is real: real `bun pm pack` tarballs, real installs
 * (transitive third-party deps come from the public registry, `@atlcli/*`
 * only ever from the local tarballs/dirs via `overrides`), real DOCX bytes
 * through `runExport`, real PDF bytes through `runPdfExport` +
 * `BrowserPdfCompiler` with the vendored wasm. No mocks, no registry
 * publish.
 */
import { Glob } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface PublishablePackage {
  name: string;
  dir: string;
}

/** Publishable set, derived from the fail-closed atlcli.publish classification. */
export function publishablePackages(): PublishablePackage[] {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  const out: PublishablePackage[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    for (const rel of new Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as {
        name?: string;
        atlcli?: { publish?: string };
      };
      if (manifest.atlcli?.publish && manifest.name) {
        out.push({ name: manifest.name, dir: join(repoRoot, dirname(rel)) });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function must(res: { exitCode: number; stdout: string; stderr: string }, what: string): void {
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${res.exitCode}):\n${res.stdout}\n${res.stderr}`);
  }
}

/** Build the publishable packages (dist + vendored wasm) via turbo. */
export function buildPackages(): void {
  must(
    run(
      ["bunx", "turbo", "run", "build", "--filter=./packages/*", "--output-logs=errors-only"],
      repoRoot,
    ),
    "turbo run build --filter=./packages/*",
  );
}

/** `bun pm pack` every publishable package into `destDir`; returns name → tarball path. */
export function packAll(destDir: string): Map<string, string> {
  mkdirSync(destDir, { recursive: true });
  const tarballs = new Map<string, string>();
  for (const pkg of publishablePackages()) {
    const pkgDest = join(destDir, pkg.name.replace(/[^a-z0-9-]/gi, "_"));
    mkdirSync(pkgDest, { recursive: true });
    must(run(["bun", "pm", "pack", "--destination", pkgDest], pkg.dir), `bun pm pack ${pkg.name}`);
    const tgz = readdirSync(pkgDest).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`no tarball produced for ${pkg.name} in ${pkgDest}`);
    tarballs.set(pkg.name, join(pkgDest, tgz));
  }
  return tarballs;
}

/**
 * DOCX smoke — plain .mjs so the same file runs under Bun AND plain Node.
 * Asserts dist (not src) resolution, drives `storageToBlocks` from the
 * installed confluence package, builds a minimal real template via the
 * installed `./fixtures` subpath, runs a real `runExport`, and unzips the
 * result to assert the heading landed in word/document.xml.
 */
export const DOCX_SMOKE_MJS = `
import { runExport } from "@atlcli/docx";
import { buildDocx, para, readPart } from "@atlcli/docx/fixtures";
import { storageToBlocks } from "@atlcli/confluence";

const resolved = import.meta.resolve("@atlcli/docx");
if (!resolved.includes("/dist/")) {
  throw new Error(\`@atlcli/docx resolved to \${resolved} — expected the built dist/ output\`);
}

const storage = "<h1>Smoke Heading</h1><p>Consumer smoke body.</p>";

// The installed converter must produce a real block tree.
const { blocks, notes } = storageToBlocks(storage);
if (!Array.isArray(blocks) || blocks.length < 2) {
  throw new Error(\`storageToBlocks produced \${blocks?.length} blocks, expected >= 2\`);
}
if (!Array.isArray(notes)) throw new Error("storageToBlocks returned no notes array");

const templateBytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });

let outBytes;
const report = await runExport(
  {
    details: {
      id: "9001",
      title: "Smoke Page",
      url: "https://example.invalid/wiki/spaces/SMOKE/pages/9001",
      version: 1,
      spaceKey: "SMOKE",
      storage,
      created: "2026-07-01T08:00:00.000Z",
      modified: "2026-07-02T09:00:00.000Z",
      createdBy: { displayName: "Smoke Author" },
      modifiedBy: { displayName: "Smoke Editor" },
      labels: [],
    },
    template: { name: "smoke.docx", modificationDate: new Date("2026-07-10T00:00:00.000Z") },
    exportDate: new Date("2026-07-15T10:00:00.000Z"),
  },
  {
    templates: { getBytes: async () => templateBytes },
    output: {
      emit: async (_name, bytes) => {
        outBytes = bytes;
      },
    },
  },
);

if (!outBytes || outBytes.length < 1000) {
  throw new Error(\`export emitted \${outBytes?.length ?? 0} bytes — not a plausible docx\`);
}
// Valid zip magic (PK\\x03\\x04) and the fixture heading inside the document part.
if (outBytes[0] !== 0x50 || outBytes[1] !== 0x4b) throw new Error("output is not a zip archive");
const documentXml = readPart(outBytes, "word/document.xml");
if (!documentXml.includes("Smoke Heading")) {
  throw new Error("word/document.xml does not contain the fixture heading");
}
if (!documentXml.includes("Consumer smoke body.")) {
  throw new Error("word/document.xml does not contain the fixture paragraph");
}
console.log("DOCX_SMOKE_OK", report.filename);
`;

/**
 * PDF smoke — plain .mjs for Bun AND Node. Wasm comes from the installed
 * package's `./wasm` subpath, fonts from the installed `@atlcli/pdf/fonts/*`
 * subpaths (both resolved against the CONSUMER's node_modules via
 * import.meta.resolve), compiled through the installed BrowserPdfCompiler.
 */
export const PDF_SMOKE_MJS = `
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPdfExport, PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import { validatePdfOutput } from "@atlcli/pdf/internal";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { storageToBlocks } from "@atlcli/confluence";

for (const spec of ["@atlcli/pdf", "@atlcli/pdf-compiler-browser"]) {
  const resolved = import.meta.resolve(spec);
  if (!resolved.includes("/dist/")) {
    throw new Error(\`\${spec} resolved to \${resolved} — expected the built dist/ output\`);
  }
}

const packageBytes = (specifier) =>
  new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve(specifier))));

const wasm = packageBytes("@atlcli/pdf-compiler-browser/wasm");
const fonts = PDF_RUNTIME_ASSETS.fonts.map((font) =>
  packageBytes(\`@atlcli/pdf/fonts/\${font.fileName}\`),
);
const compiler = new BrowserPdfCompiler({
  wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  fonts,
});

const { blocks } = storageToBlocks("<h1>Smoke Heading</h1><p>PDF consumer smoke.</p>");

let outBytes;
const report = await runPdfExport(
  {
    blocks,
    metadata: {
      title: "Smoke PDF",
      space: "SMOKE",
      version: 1,
      exportedAt: new Date("2026-07-15T10:00:00.000Z"),
    },
    filename: "smoke.pdf",
  },
  {
    assets: {
      resolve: async () => {
        throw new Error("the smoke fixture has no external assets");
      },
    },
    compiler,
    output: {
      emit: async (_name, bytes) => {
        outBytes = bytes;
      },
    },
  },
);

if (!outBytes) throw new Error("runPdfExport emitted nothing");
const magic = String.fromCharCode(...outBytes.slice(0, 5));
if (magic !== "%PDF-") throw new Error(\`bad magic bytes: \${magic}\`);
const inspection = validatePdfOutput(outBytes);
if (!inspection.tagged || inspection.pageCount < 1) {
  throw new Error(\`invalid pdf structure: \${JSON.stringify(inspection)}\`);
}
console.log("PDF_SMOKE_OK", report?.filename ?? "smoke.pdf", "pages=" + inspection.pageCount);
`;

/** Type-consumption fixture: real imports from the four packages. */
export const TYPECHECK_MAIN_TS = `
import {
  runExport,
  type ExportEnv,
  type RunExportInput,
  type ExportReport,
  type TemplateSource,
  type OutputSink,
} from "@atlcli/docx";
import {
  runPdfExport,
  PDF_RUNTIME_ASSETS,
  type PdfExportEnv,
  type RunPdfExportInput,
  type PdfCompilePort,
  type PdfCompileResult,
} from "@atlcli/pdf";
import { storageToBlocks, type ExportBlock, type ExportNote } from "@atlcli/confluence";
import {
  BrowserPdfCompiler,
  type BrowserPdfCompilerAssets,
} from "@atlcli/pdf-compiler-browser";

const converted: { blocks: ExportBlock[]; notes: ExportNote[] } = storageToBlocks("<p>t</p>");
const surfaces: unknown[] = [
  runExport satisfies (input: RunExportInput, env: ExportEnv) => Promise<ExportReport>,
  runPdfExport,
  BrowserPdfCompiler,
  PDF_RUNTIME_ASSETS.fonts.length,
  converted.blocks.length,
];
const _envParts: [TemplateSource, OutputSink, PdfExportEnv, PdfCompilePort, PdfCompileResult, RunPdfExportInput, BrowserPdfCompilerAssets] | null = null;
void surfaces;
void _envParts;
export {};
`;

export interface ScaffoldOptions {
  /** dependency name → spec (file:… tarball or directory). */
  dependencies: Record<string, string>;
  /** Extra devDependencies (registry specs), e.g. typescript/@types/node. */
  devDependencies?: Record<string, string>;
  /** tsconfig moduleResolution — "bundler" (Bun/Vite-style) or "nodenext". */
  moduleResolution?: "bundler" | "nodenext";
}

/** Write the consumer project skeleton (manifest, tsconfig, smoke fixtures). */
export function scaffoldConsumer(dir: string, options: ScaffoldOptions): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name: "atlcli-smoke-consumer",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: options.dependencies,
    devDependencies: options.devDependencies ?? {},
    // `overrides` (bun + npm) and `pnpm.overrides` pin every transitive
    // `@atlcli/*` range to the same local artifacts, so internal ranges like
    // "@atlcli/core": "0.6.0" can never hit a registry (where they do not exist).
    overrides: options.dependencies,
    pnpm: { overrides: options.dependencies },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const nodenext = options.moduleResolution === "nodenext";
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: nodenext ? "NodeNext" : "ESNext",
      moduleResolution: nodenext ? "NodeNext" : "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
    },
    include: ["main.ts"],
  };
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  writeFileSync(join(dir, "main.ts"), TYPECHECK_MAIN_TS);
  writeFileSync(join(dir, "docx-smoke.mjs"), DOCX_SMOKE_MJS);
  writeFileSync(join(dir, "pdf-smoke.mjs"), PDF_SMOKE_MJS);
}

/** Assert no installed @atlcli manifest still carries a workspace: range. */
export function assertNoWorkspaceLeak(dir: string): void {
  const scope = join(dir, "node_modules", "@atlcli");
  if (!existsSync(scope)) throw new Error(`${scope} missing — install did not produce @atlcli/*`);
  for (const entry of readdirSync(scope)) {
    const manifestPath = join(scope, entry, "package.json");
    if (!existsSync(manifestPath)) continue;
    const raw = readFileSync(manifestPath, "utf8");
    if (raw.includes('"workspace:')) {
      throw new Error(`workspace: range leaked into installed manifest ${manifestPath}`);
    }
  }
}

export interface SmokeRunResult {
  docx: string;
  pdf: string;
}

/** Run both smoke fixtures with the given runtime (["bun"] or ["node"]). */
export function runSmokes(
  dir: string,
  runtime: string[],
  env?: Record<string, string>,
): SmokeRunResult {
  const docx = run([...runtime, "docx-smoke.mjs"], dir, env);
  must(docx, `${runtime.join(" ")} docx-smoke.mjs`);
  if (!docx.stdout.includes("DOCX_SMOKE_OK")) {
    throw new Error(`docx smoke did not report success:\n${docx.stdout}\n${docx.stderr}`);
  }
  const pdf = run([...runtime, "pdf-smoke.mjs"], dir, env);
  must(pdf, `${runtime.join(" ")} pdf-smoke.mjs`);
  if (!pdf.stdout.includes("PDF_SMOKE_OK")) {
    throw new Error(`pdf smoke did not report success:\n${pdf.stdout}\n${pdf.stderr}`);
  }
  return { docx: docx.stdout.trim(), pdf: pdf.stdout.trim() };
}

/** Run the consumer-local tsc (installed by the consumer project itself). */
export function runConsumerTypecheck(dir: string): void {
  const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error(`typescript not installed in consumer at ${tsc}`);
  const res = run(["bun", tsc, "-p", "."], dir);
  must(res, "consumer tsc --noEmit (skipLibCheck: false)");
}

export const CONSUMER_DEV_DEPS = {
  typescript: "5.9.3",
  "@types/node": "25.0.5",
};

export interface TarballSmokeResult {
  projectDir: string;
  smokes: SmokeRunResult;
}

/**
 * The tarball-install suite: temp consumer project, all publishable tarballs
 * installed via bun with overrides, workspace-leak check, DOCX + PDF smokes
 * under Bun, and the skipLibCheck:false type-consumption check.
 */
export async function runTarballSmoke(baseDir?: string): Promise<TarballSmokeResult> {
  const workDir = baseDir ?? join(tmpdir(), `atlcli-consumer-smoke-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });

  buildPackages();
  const tarballs = packAll(join(workDir, "tarballs"));

  const projectDir = join(workDir, "consumer");
  const dependencies = Object.fromEntries(
    [...tarballs.entries()].map(([name, path]) => [name, `file:${path}`]),
  );
  scaffoldConsumer(projectDir, { dependencies, devDependencies: CONSUMER_DEV_DEPS });

  must(run(["bun", "install"], projectDir), "bun install (tarball consumer)");
  assertNoWorkspaceLeak(projectDir);

  const smokes = runSmokes(projectDir, ["bun"]);
  runConsumerTypecheck(projectDir);
  return { projectDir, smokes };
}

if (import.meta.main) {
  const { projectDir, smokes } = await runTarballSmoke();
  console.log(`tarball consumer smoke OK in ${projectDir}`);
  console.log(smokes.docx);
  console.log(smokes.pdf);
}
