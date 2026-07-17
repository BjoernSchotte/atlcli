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
