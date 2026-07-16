/**
 * Ambient declarations for the untyped markdown/turndown plugins that
 * `@atlcli/confluence`'s converter (markdown.ts) imports.
 *
 * The extension consumes `@atlcli/confluence/browser` as workspace SOURCE, so
 * the extension's `tsc` typechecks markdown.ts and its imports directly. These
 * third-party plugins ship no types; the confluence package covers sub/sup in
 * its own `src/types.d.ts`, but that file is outside the extension's program.
 * Declaring all four here keeps the extension typecheck self-contained.
 */
declare module "markdown-it-sub" {
  import type MarkdownIt from "markdown-it";
  function plugin(md: MarkdownIt): void;
  export default plugin;
}

declare module "markdown-it-sup" {
  import type MarkdownIt from "markdown-it";
  function plugin(md: MarkdownIt): void;
  export default plugin;
}

declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  function plugin(md: MarkdownIt, options?: unknown): void;
  export default plugin;
}

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}

declare module "*.ttf?url" {
  const url: string;
  export default url;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "*.txt?url&no-inline" {
  const url: string;
  export default url;
}

declare module "*?url&no-inline" {
  const url: string;
  export default url;
}

/**
 * The package ships this declaration next to the ESM file but omits an exports
 * mapping for it. Keep the adapter's deliberately small API surface typed.
 */
declare module "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs" {
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
    add_raw_font(data: Uint8Array): Promise<void>;
    build(): Promise<TypstCompiler>;
  }

  export default function initTypst(options: {
    module_or_path: ArrayBuffer | URL | Response;
  }): Promise<unknown>;
}
