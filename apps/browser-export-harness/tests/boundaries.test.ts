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
  it("bootstraps the DOCX runtime before dynamically loading the app graph", () => {
    const source = read("src/main.ts");
    expect(source.indexOf(`@atlcli/docx/browser-runtime`)).toBeLessThan(source.indexOf(`import("./app.js")`));
    expect(source).not.toMatch(/from\s+["']@atlcli\/docx\/browser["']/);
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

  it("keeps every font import static and checks it against the manifest", () => {
    const worker = read("src/pdf-worker.ts");
    const staticFontImports = [...worker.matchAll(/from\s+"@atlcli\/pdf\/fonts\/([^?]+)\?url"/g)]
      .map((match) => match[1])
      .sort();
    expect(staticFontImports).toEqual(PDF_RUNTIME_ASSETS.fonts.map((asset) => asset.fileName).sort());
    expect(worker).toContain("assertStaticAssetParity");
  });

  it("serves a restrictive CSP without unsafe-eval", () => {
    const server = read("scripts/serve-dist.ts");
    expect(server).toContain("'wasm-unsafe-eval'");
    expect(server).not.toMatch(/(?:^|[\s"'])'unsafe-eval'(?:[\s"']|$)/m);
    expect(server).toContain("worker-src 'self'");
  });
});
