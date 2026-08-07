declare module "@atlcli/pdf-compiler-browser/vendor/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs" {
  export interface TypstCompiler {
    free(): void;
    reset(): void;
    add_source(path: string, content: string): boolean;
    map_shadow(path: string, content: Uint8Array): boolean;
    reset_shadow(): void;
    get_loaded_fonts(): string[];
    compile(
      mainFilePath: string,
      inputs: Array<unknown>,
      format: string,
      diagnosticsFormat: number
    ): unknown;
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
