import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  canvasSvgRasterizer,
  memoryTemplateSource,
  prepareDocxExportRuntime,
  runExport,
  scanTemplate,
} from "./browser-entry.js";
import { DOCX_BROWSER_VITE_DEFINES } from "./vite.js";

const fixtureDirs: string[] = [];
afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

interface BuiltEntry {
  path: string;
  source: string;
}

async function buildFixture(
  entrypoint: string,
  options: { guardVendorEvaluation?: boolean } = {},
): Promise<BuiltEntry> {
  const outdir = mkdtempSync(join(tmpdir(), "atlcli-docx-browser-entry-"));
  fixtureDirs.push(outdir);
  const vendorModules = new Set<string>();
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    format: "esm",
    conditions: ["development", "browser"],
    define: DOCX_BROWSER_VITE_DEFINES,
    plugins: options.guardVendorEvaluation
      ? [{
          name: "assert-docx-runtime-before-real-vendors",
          setup(build) {
            build.onLoad(
              { filter: /(?:pizzip|docxtemplater).*[.](?:c|m)?js$/u },
              async (args) => {
                const normalized = args.path.replaceAll("\\", "/");
                const vendor = normalized.includes("/node_modules/pizzip/")
                  ? "pizzip"
                  : normalized.includes("/node_modules/docxtemplater/")
                    ? "docxtemplater"
                    : undefined;
                if (!vendor) {
                  throw new Error(`Unexpected DOCX vendor probe path: ${args.path}`);
                }
                vendorModules.add(vendor);
                return {
                  contents:
                    `if (!globalThis.__atlDocxByteHelpers) ` +
                    `throw new Error(${JSON.stringify(`${vendor} evaluated before the DOCX browser runtime`)});\n` +
                    await Bun.file(args.path).text(),
                  loader: "js",
                };
              },
            );
          },
        }]
      : [],
  });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
  if (options.guardVendorEvaluation) {
    expect([...vendorModules].sort()).toEqual(["docxtemplater", "pizzip"]);
  }

  const artifact = result.outputs.find(({ kind }) => kind === "entry-point")
    ?? result.outputs[0];
  if (!artifact) throw new Error(`Bun emitted no entry for ${entrypoint}`);
  const bytes = new Uint8Array(await artifact.arrayBuffer());
  const outputPath = artifact.path || join(
    outdir,
    `${basename(entrypoint).replace(/[.]ts$/u, "")}.js`,
  );
  if (!existsSync(outputPath)) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, bytes);
  }
  return {
    path: outputPath,
    source: new TextDecoder().decode(bytes),
  };
}

function runBuilt(path: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path], { encoding: "utf8" });
}

describe("canonical DOCX browser entry", () => {
  const combinedFixture =
    "packages/docx/test-fixtures/browser-entry-minimal.ts";
  let combinedBuild: BuiltEntry;

  beforeAll(async () => {
    combinedBuild = await buildFixture(combinedFixture, {
      guardVendorEvaluation: true,
    });
  });

  it("exposes preparation, export, template, scan, and rasterizer capabilities", () => {
    expect(typeof runExport).toBe("function");
    expect(typeof prepareDocxExportRuntime).toBe("function");
    expect(typeof memoryTemplateSource).toBe("function");
    expect(typeof canvasSvgRasterizer).toBe("function");
    expect(typeof scanTemplate).toBe("function");
  });

  it("installs the runtime before the real PizZip/docxtemplater graph evaluates", () => {
    const run = runBuilt(combinedBuild.path);

    expect(run.status, run.stderr.toString()).toBe(0);
    expect(run.stdout).toContain("ordered-browser-entry function");
  });

  it("tree-shakes the optional canvas adapter when a consumer only uses runExport", () => {
    expect(combinedBuild.source).not.toContain(
      "canvas SVG rasterization requires a document",
    );
    expect(combinedBuild.source).not.toContain(
      "the diagram SVG did not decode within",
    );
  });

  it("declares the runtime dependency before the engine re-export", () => {
    const source = readFileSync(join(import.meta.dir, "browser-entry.ts"), "utf8");
    expect(source.indexOf('import "./browser-runtime.js"')).toBeLessThan(
      source.indexOf('export * from "./index.browser.js"'),
    );
  });
});
