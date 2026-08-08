declare module "@atlcli/pdf-compiler-browser/vendor/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs" {
  export interface TypstCompiler {
    free(): void;
    reset(): void;
    add_source(path: string, content: string): boolean;
    map_shadow(path: string, content: Uint8Array): boolean;
    reset_shadow(): void;
    get_loaded_fonts(): string[];
    snapshot(
      root?: string | null,
      mainFilePath?: string | null,
      inputs?: Array<unknown> | null,
    ): TypstCompileWorld;
    compile(
      mainFilePath: string,
      inputs: Array<unknown>,
      format: string,
      diagnosticsFormat: number
    ): unknown;
  }

  export interface TypstCompileWorld {
    free(): void;
    set_pdf_opts(options: {
      pdf_standard?: string;
      pdf_tags?: boolean;
      creation_timestamp?: number;
    }): void;
    get_artifact(format: number, diagnosticsFormat: number): unknown;
  }

  export class TypstCompilerBuilder {
    free(): void;
    add_raw_font(data: Uint8Array): Promise<void>;
    build(): Promise<TypstCompiler>;
  }

  export function embedded_typst_commit(): string | undefined;
  export function embedded_typst_version(): string;

  export default function initTypst(options: {
    module_or_path: ArrayBuffer | URL | Response;
  }): Promise<{ readonly memory: WebAssembly.Memory }>;
}
