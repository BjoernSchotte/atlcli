import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  canvasSvgRasterizer,
  installDocxBrowserRuntime,
  memoryTemplateSource,
  prepareDocxCodeHighlighting,
  prepareDocxExportRuntime,
  type DocxByteHelpers,
} from "./browser-runtime.js";
import type { ExportBlock } from "@atlcli/confluence";
import { DOCX_BROWSER_VITE_DEFINES } from "./vite.js";

type RuntimeGlobal = typeof globalThis & {
  __atlDocxByteHelpers?: DocxByteHelpers;
  Buffer?: unknown;
};

describe("DOCX browser byte helpers", () => {
  it("installs once under a DOCX-specific namespace", () => {
    const scope = globalThis as RuntimeGlobal;
    const installed = scope.__atlDocxByteHelpers;
    expect(installed).toBeDefined();

    installDocxBrowserRuntime();
    installDocxBrowserRuntime();

    expect(scope.__atlDocxByteHelpers).toBe(installed);
    expect(installed!.from("Grüße")).toEqual(new TextEncoder().encode("Grüße"));
    expect(installed!.from(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(installed!.alloc(3)).toEqual(new Uint8Array([0, 0, 0]));
    expect(installed!.isBuffer(new Uint8Array())).toBe(false);
  });

  it("does not create or replace a global Buffer", () => {
    const scope = globalThis as RuntimeGlobal;
    const before = scope.Buffer;
    installDocxBrowserRuntime();
    expect(scope.Buffer).toBe(before);
  });

  it("awaits only nested non-Mermaid DOCX languages and is idempotent", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "callout",
        kind: "info",
        content: [{ type: "codeBlock", language: "ts", code: "const x = 1;" }],
      },
      {
        type: "table",
        rows: [{
          cells: [{
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [
              { type: "codeBlock", language: "typescript", code: "const y = 2;" },
              { type: "codeBlock", language: "mermaid", code: "graph TD; A-->B" },
            ],
          }],
        }],
      },
    ];
    await Promise.all([
      prepareDocxCodeHighlighting(blocks),
      prepareDocxCodeHighlighting(blocks),
    ]);
    await prepareDocxCodeHighlighting(blocks);
  });

  it("does not infer font demand from an empty or partial block tree", async () => {
    const empty = await prepareDocxExportRuntime([]);
    const partial = await prepareDocxExportRuntime([
      {
        type: "paragraph",
        content: [{ type: "text", text: "INLINE_TOKEN", marks: ["code"] }],
      },
    ]);
    expect(empty.codeFontBytes).toBe(0);
    expect(empty.codeFontMs).toBe(0);
    expect(partial.codeFontBytes).toBe(0);
    expect(partial.codeFontMs).toBe(0);
  });

  it("explicitly preloads highlighting and the validated bundled code font", async () => {
    const prepared = await prepareDocxExportRuntime([
      {
        type: "callout",
        kind: "info",
        content: [{ type: "codeBlock", language: "ts", code: "const x = 1;" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "INLINE_TOKEN", marks: ["code"] }],
      },
    ], { preloadCodeFont: true });
    expect(prepared.codeFontBytes).toBe(273_900);
    expect(prepared.totalMs).toBeGreaterThanOrEqual(0);
    expect(prepared.highlightingMs).toBeGreaterThanOrEqual(0);
    expect(prepared.codeFontMs).toBeGreaterThanOrEqual(0);
  });

  it("exports the exact frozen Vite define map", () => {
    expect(DOCX_BROWSER_VITE_DEFINES).toEqual({
      "Buffer.from": "globalThis.__atlDocxByteHelpers.from",
      "Buffer.alloc": "globalThis.__atlDocxByteHelpers.alloc",
      "Buffer.isBuffer": "globalThis.__atlDocxByteHelpers.isBuffer",
    });
    expect(Object.isFrozen(DOCX_BROWSER_VITE_DEFINES)).toBe(true);
  });
});

describe("memoryTemplateSource", () => {
  it("snapshots only a non-zero-offset view and returns a fresh copy per read", async () => {
    const owner = new Uint8Array([9, 1, 2, 8]);
    const view = owner.subarray(1, 3);
    const source = memoryTemplateSource(view);

    owner[1] = 7;
    const first = await source.getBytes("current");
    expect(first).toEqual(new Uint8Array([1, 2]));
    expect(first.buffer.byteLength).toBe(2);

    first[0] = 6;
    const second = await source.getBytes("current");
    expect(second).toEqual(new Uint8Array([1, 2]));
    expect(second).not.toBe(first);
  });

  it("also snapshots ArrayBuffer input", async () => {
    const owner = new Uint8Array([80, 75, 3, 4]);
    const source = memoryTemplateSource(owner.buffer);
    owner[0] = 0;
    expect(await source.getBytes("current")).toEqual(new Uint8Array([80, 75, 3, 4]));
  });
});

describe("canvasSvgRasterizer", () => {
  it("reports per-call decode/draw/encode timing without owning host aggregates", async () => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/png;base64,AQIDBA==",
    };
    const doc = {
      defaultView: {
        URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
        Blob,
        Image: FakeImage,
        atob,
      },
      createElement: () => canvas,
    } as unknown as Document;
    const timings: unknown[] = [];
    const values = [0, 5, 5, 8, 8, 12];
    const originalNow = Date.now;
    Date.now = () => values.shift()!;
    try {
      const bytes = await canvasSvgRasterizer({
        document: doc,
        onTiming: (timing) => timings.push(timing),
      }).rasterize("<svg/>", { widthPx: 8, heightPx: 6 });
      expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(timings).toEqual([{ decodeMs: 5, drawMs: 3, encodeMs: 4 }]);
    } finally {
      Date.now = originalNow;
    }
  });
});

const fixtureDirs: string[] = [];
afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

async function buildAndRunEntry(entrySource: string): Promise<ReturnType<typeof spawnSync>> {
  const dir = mkdtempSync(join(tmpdir(), "atlcli-docx-runtime-order-"));
  fixtureDirs.push(dir);
  const outdir = join(dir, "out");
  const probe = join(dir, "probe.ts");
  const entry = join(dir, "entry.ts");
  writeFileSync(
    probe,
    "declare const Buffer: { from(value: string): Uint8Array };\n" +
      "export const value = Buffer.from('ok');\n"
  );
  writeFileSync(entry, entrySource);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    format: "esm",
    define: DOCX_BROWSER_VITE_DEFINES,
  });
  expect(result.success).toBe(true);
  return spawnSync(process.execPath, [join(outdir, "entry.js")], { encoding: "utf8" });
}

describe("browser runtime module evaluation order", () => {
  const runtimePath = join(import.meta.dir, "browser-runtime-bootstrap.ts");

  it("works when the runtime is installed before a dynamic engine import", async () => {
    const run = await buildAndRunEntry(
      `import ${JSON.stringify(runtimePath)};\n` +
        `const { value } = await import("./probe.ts");\n` +
        `console.log(Array.from(value).join(","));\n`
    );
    expect(run.status, run.stderr.toString()).toBe(0);
    expect(run.stdout).toContain("111,107");
  });

  it("fails without the bootstrap", async () => {
    const run = await buildAndRunEntry(
      `const { value } = await import("./probe.ts");\n` +
        `console.log(Array.from(value).join(","));\n`
    );
    expect(run.status).not.toBe(0);
  });

  it("fails when a static engine dependency evaluates before the bootstrap", async () => {
    const run = await buildAndRunEntry(
      `import { value } from "./probe.ts";\n` +
        `import ${JSON.stringify(runtimePath)};\n` +
        `console.log(Array.from(value).join(","));\n`
    );
    expect(run.status).not.toBe(0);
  });
});

describe("barrel boundaries", () => {
  it("does not re-export browser runtime from the normal browser or Node barrel", () => {
    const browserBarrel = readFileSync(join(import.meta.dir, "index.browser.ts"), "utf8");
    const nodeBarrel = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(browserBarrel).not.toMatch(/export\s+[^;]*browser-runtime/);
    expect(nodeBarrel).not.toMatch(/export\s+[^;]*browser-runtime/);
  });
});
