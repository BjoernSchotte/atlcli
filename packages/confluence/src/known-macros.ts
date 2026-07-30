/**
 * Macros the storage/Markdown converters recognize.
 *
 * This vocabulary lives in its own dependency-free module because the
 * document-free storage tokenizer also needs it. Importing `markdown.ts` only
 * for this constant would initialize Turndown and therefore require `document`
 * in dedicated MV3 workers.
 */
export const KNOWN_MACROS: string[] = [
  "info",
  "note",
  "warning",
  "tip",
  "expand",
  "toc",
  "status",
  "anchor",
  "jira",
  "panel",
  "code",
  "noformat",
  "excerpt",
  "excerpt-include",
  "include",
  "gallery",
  "attachments",
  "multimedia",
  "widget",
  "section",
  "column",
  "children",
  "content-by-label",
  "recently-updated",
  "pagetree",
  "date",
  "toc-zone",
  "details",
  "detailssummary",
  "tasks-report-macro",
  "labels-list",
  "popular-labels",
  "related-labels",
  "blog-posts",
  "spaces-list",
  "index",
  "contributors",
  "change-history",
  "loremipsum",
];
