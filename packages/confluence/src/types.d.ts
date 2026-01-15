// Type declarations for markdown-it plugins without bundled types

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
