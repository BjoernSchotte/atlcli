import initTypst, {
  TypstCompilerBuilder,
  type TypstCompiler,
} from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs";
import {
  mapPdfDiagnostics,
  type PdfSourceBundle,
  type PdfSourceMapEntry,
} from "@atlcli/pdf/browser";

export const PDF_COMPILER_VERSION = "typst.ts 0.7.0 / Typst 0.14.2";

export interface PdfCompilerAssets {
  wasm: ArrayBuffer | URL | Response;
  fonts: Uint8Array[];
}

export interface RawPdfDiagnostic {
  package: string;
  path: string;
  severity: string;
  range: string;
  message: string;
}

export interface PdfCompileResult {
  pdf?: Uint8Array;
  diagnostics: RawPdfDiagnostic[];
}

/**
 * Thin version-pinned adapter around typst.ts. The adapter is the only place
 * allowed to know the wrapper's mutable VFS/font APIs.
 */
export class BrowserPdfCompiler {
  private compiler: TypstCompiler | null = null;
  private initPromise: Promise<TypstCompiler> | null = null;

  constructor(private readonly assets: PdfCompilerAssets) {}

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
      for (const asset of bundle.assets) {
        compiler.map_shadow(`/${asset.path}`, asset.bytes);
      }
      const result = compiler.compile("/main.typ", [], "pdf", 3) as {
        result?: Uint8Array;
        diagnostics?: RawPdfDiagnostic[];
      };
      return {
        pdf: result.result,
        diagnostics: (result.diagnostics ?? []) as RawPdfDiagnostic[],
      };
    } finally {
      compiler.reset_shadow();
    }
  }

  async getLoadedFonts(): Promise<string[]> {
    return (await this.initialize()).get_loaded_fonts();
  }

  /** Drop all compiler state after a fatal job; the next call initializes anew. */
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

export function formatPdfDiagnostics(
  diagnostics: RawPdfDiagnostic[],
  sourceMap: PdfSourceMapEntry[] = []
): string {
  if (diagnostics.length === 0) return "Typst produced no PDF and no diagnostics.";
  const mapped = mapPdfDiagnostics(
    diagnostics.map((diagnostic) => {
      const match = diagnostic.range.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
      return {
        severity: diagnostic.severity,
        message: diagnostic.message,
        path: diagnostic.path,
        line: match ? Number(match[1]) : undefined,
        column: match ? Number(match[2]) : undefined,
        endLine: match ? Number(match[3]) : undefined,
        endColumn: match ? Number(match[4]) : undefined,
      };
    }),
    sourceMap
  );
  return mapped
    .map((diagnostic) => {
      const location = diagnostic.blockPath
        ? `${diagnostic.blockPath}: `
        : diagnostic.path
          ? `${diagnostic.path}${diagnostic.startLine ? `:${diagnostic.startLine}` : ""}: `
          : "";
      return `${location}${diagnostic.severity}: ${diagnostic.message}`;
    })
    .join("\n");
}
