import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PDF_RUNTIME_ASSETS } from "@atlcli/pdf/browser";

const ROOT = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function sourceFiles(path: string): string[] {
  const absolute = join(ROOT, path);
  return readdirSync(absolute).flatMap((name) => {
    const child = join(absolute, name);
    return statSync(child).isDirectory() ? sourceFiles(join(path, name)) : [child];
  });
}

describe("browser harness boundaries", () => {
  it("loads one combined DOCX entry inside the explicit app-intent graph", () => {
    const main = read("src/main.ts");
    const app = read("src/app.ts");
    const combined = sourceFiles("src")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(main).toContain(`import("./app.js")`);
    expect(main).not.toContain("@atlcli/docx/browser-runtime");
    expect(main).not.toContain("@atlcli/docx/browser-entry");
    expect(app.split("\n").find((line) => line.startsWith("import "))).toBe(
      'import { runExport } from "@atlcli/docx/browser-entry";',
    );
    expect(combined).not.toMatch(
      /from\s+["']@atlcli\/docx\/(?:browser|browser-runtime|scan)["']/,
    );
  });

  it("uses relative Vite output and the package-owned DOCX defines", () => {
    const config = read("vite.config.ts");
    expect(config).toContain(`base: "./"`);
    expect(config).toContain("DOCX_BROWSER_VITE_DEFINES");
    expect(config).toContain("assetsInlineLimit: 0");
  });

  it("never imports extension or WXT source", () => {
    const combined = sourceFiles("src").map((path) => readFileSync(path, "utf8")).join("\n");
    expect(combined).not.toMatch(/(?:apps\/extension|@atlcli\/extension|from\s+["']wxt)/);
  });

  it("uses a direct Worker protocol without IndexedDB or extension messages", () => {
    const combined = ["src/pdf-worker.ts", "src/pdf-worker-client.ts", "src/pdf-worker-protocol.ts"]
      .map(read)
      .join("\n");
    expect(combined).not.toMatch(/indexedDB|job-store|pdf:compile|pdf:cancel|chrome\./);
    expect(combined).toContain("PdfSourceBundle");
    expect(combined).toContain("new Worker(new URL");
  });

  it("keeps PDFium in the isolated import Worker and PDF.js out of the importer graph", () => {
    const worker = read("src/import-pdf-worker.ts");
    const importerFiles = [
      "src/import-pdf-case.ts",
      "src/import-pdf-worker.ts",
      "src/import-pdf-worker-protocol.ts",
    ].map(read).join("\n");
    expect(worker).toContain('@atlcli/import-pdf/wasm?url&no-inline');
    expect(worker).toContain('@atlcli/import-pdf/browser-worker');
    expect(worker).toContain("sameOriginBytes");
    expect(importerFiles).not.toContain("pdfjs-dist");
    expect(importerFiles).not.toContain("DEFAULT_PDFIUM_WASM_URL");
    expect(importerFiles).not.toContain("@embedpdf/pdfium");
  });

  it("keeps every font import static and checks it against the manifest", () => {
    const worker = read("src/pdf-worker.ts");
    const staticFontImports = [...worker.matchAll(/from\s+"@atlcli\/pdf\/fonts\/([^?]+)\?url"/g)]
      .map((match) => match[1])
      .sort();
    expect(staticFontImports).toEqual(PDF_RUNTIME_ASSETS.fonts.map((asset) => asset.fileName).sort());
    expect(worker).toContain("assertStaticAssetParity");
  });

  it("compares browser output against the same demand-aware compiler shape", () => {
    const parity = read("scripts/check-parity.ts");
    expect(parity).toContain("BrowserPdfCompilerFontSourceV1");
    expect(parity).toContain("assetId: font.assetId");
    expect(parity).toContain("sha256: font.sha256");
    expect(parity).toContain('load: () => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)');
    expect(parity).not.toContain("const [wasm, ...fonts]");
  });

  it("serves a restrictive CSP without unsafe-eval", () => {
    const server = read("scripts/serve-dist.ts");
    expect(server).toContain("'wasm-unsafe-eval'");
    expect(server).not.toMatch(/(?:^|[\s"'])'unsafe-eval'(?:[\s"']|$)/m);
    expect(server).toContain("worker-src 'self'");
  });

  it("typechecks DOM and Worker programs separately from the root program", () => {
    const rootConfig = JSON.parse(read("../../tsconfig.json")) as { exclude?: string[] };
    const rootPackage = JSON.parse(read("../../package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(rootConfig.exclude).toContain("apps/browser-export-harness");
    expect(rootPackage.scripts?.typecheck).toContain("typecheck:browser-export-harness");
    expect(read("package.json")).toContain("tsconfig.worker.json");
    expect(JSON.parse(read("tsconfig.worker.json")).exclude).toEqual([]);
    expect(JSON.parse(read("tsconfig.tools.json")).exclude).toEqual([]);
  });

  it("installs the same pinned Playwright version in CI that runs the harness", () => {
    const harnessPackage = JSON.parse(read("package.json")) as {
      devDependencies: { "@playwright/test": string };
    };
    const version = harnessPackage.devDependencies["@playwright/test"];
    expect(read("../../.github/workflows/ci.yml")).toContain(
      `bunx playwright@${version} install --with-deps chromium`
    );
  });
});
