/// <reference path="./vendor.d.ts" />

import initTypst, {
  TypstCompilerBuilder,
  type TypstCompiler,
} from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs";
import {
  mapPdfDiagnostics,
  type PdfCompileResult,
  type PdfSourceBundle,
} from "@atlcli/pdf/browser";

export const PDF_BROWSER_COMPILER_VERSION = "typst.ts 0.7.0 / Typst 0.14.2";

export interface BrowserPdfCompilerAssets {
  wasm: ArrayBuffer | URL | Response;
  fonts: Uint8Array[];
}

interface RawPdfDiagnostic {
  package?: string;
  path?: string;
  severity?: string;
  range?: string;
  message: string;
}

/** Version-pinned, browser-only adapter around typst.ts. */
export class BrowserPdfCompiler {
  readonly version = PDF_BROWSER_COMPILER_VERSION;
  private compiler: TypstCompiler | null = null;
  private initPromise: Promise<TypstCompiler> | null = null;

  constructor(private readonly assets: BrowserPdfCompilerAssets) {}

  private initialize(): Promise<TypstCompiler> {
    if (this.compiler) return Promise.resolve(this.compiler);
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await initTypst({ module_or_path: this.assets.wasm });
      const builder = new TypstCompilerBuilder();
      for (const font of this.assets.fonts) await builder.add_raw_font(font);
      const compiler = await builder.build();
      this.compiler = compiler;
      return compiler;
    })().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  async compile(bundle: PdfSourceBundle): Promise<PdfCompileResult> {
    const compiler = await this.initialize();
    compiler.reset_shadow();
    try {
      compiler.add_source("/main.typ", bundle.main);
      compiler.add_source("/atlcli.typ", bundle.template);
      for (const asset of bundle.assets) compiler.map_shadow(`/${asset.path}`, asset.bytes);
      const result = compiler.compile("/main.typ", [], "pdf", 3) as {
        result?: Uint8Array;
        diagnostics?: RawPdfDiagnostic[];
      };
      const diagnostics = mapPdfDiagnostics(
        (result.diagnostics ?? []).map((diagnostic) => {
          const range = diagnostic.range?.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
          return {
            severity: diagnostic.severity,
            message: diagnostic.message,
            path: diagnostic.path,
            line: range ? Number(range[1]) + 1 : undefined,
            column: range ? Number(range[2]) : undefined,
            endLine: range ? Number(range[3]) + 1 : undefined,
            endColumn: range ? Number(range[4]) : undefined,
          };
        }),
        bundle.sourceMap
      );
      return { pdf: result.result, diagnostics, compilerVersion: this.version };
    } finally {
      compiler.reset_shadow();
    }
  }

  async getLoadedFonts(): Promise<string[]> {
    return (await this.initialize()).get_loaded_fonts();
  }

  async reset(): Promise<void> {
    const compiler = this.compiler;
    this.compiler = null;
    this.initPromise = null;
    if (compiler) {
      compiler.reset();
      compiler.free();
    }
  }
}
