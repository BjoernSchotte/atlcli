/**
 * The `:::name` block-macro grammar shared by the markdown → storage
 * converter (`markdown.ts`) and `docs check` (`validation.ts`).
 *
 * Both consume the same regex objects in the same order (`BLOCK_MACRO_RULES`),
 * so `check` accepts exactly what push converts and flags what push would
 * leave behind as literal `:::` text. Dependency-free on purpose: importing
 * `markdown.ts` initializes Turndown.
 */

// [ \t]+ instead of \s+ so the title capture never spans a newline.
export const MACRO_REGEX = /^:::(info|note|warning|tip|expand|toc)(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;
/** Preserved unknown/3rd-party macros: :::confluence name + <!--raw ...--> */
export const CONFLUENCE_MACRO_REGEX = /^:::confluence\s+(\S+)\n([\s\S]*?)^:::\s*$/gm;
/** :::panel title="Title" bgColor="#fff" */
export const PANEL_MACRO_REGEX = /^:::panel(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;
/** :::excerpt name="name" hidden */
export const EXCERPT_MACRO_REGEX = /^:::excerpt(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;
/** :::excerpt-include page="id" name="name" */
export const EXCERPT_INCLUDE_REGEX = /^:::excerpt-include(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::include page="id" */
export const INCLUDE_MACRO_REGEX = /^:::include(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::gallery columns=3 */
export const GALLERY_MACRO_REGEX = /^:::gallery(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::attachments patterns="*.pdf" */
export const ATTACHMENTS_MACRO_REGEX = /^:::attachments(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::multimedia url="..." */
export const MULTIMEDIA_MACRO_REGEX = /^:::multimedia(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::widget url="..." */
export const WIDGET_MACRO_REGEX = /^:::widget(?:[ \t]+(.+))?\n?:::\s*$/gm;
/**
 * :::section ... :::section-end holding :::column ... :::column-end blocks.
 * The dedicated end markers avoid ambiguity with nested ::: blocks.
 */
export const SECTION_MACRO_REGEX = /^:::section(?:[ \t]+(.+))?\n([\s\S]*?)^:::section-end\s*$/gm;
/** Columns inside a section body (scanned within the body, so unanchored). */
export const SECTION_COLUMN_REGEX = /:::column(?:[ \t]+(.+))?\n([\s\S]*?):::column-end/gm;
/** :::children depth=2 sort="title" */
export const CHILDREN_MACRO_REGEX = /^:::children(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::content-by-label labels="label1,label2" */
export const CONTENT_BY_LABEL_REGEX = /^:::content-by-label(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::recently-updated max=10 */
export const RECENTLY_UPDATED_REGEX = /^:::recently-updated(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::pagetree root="PageName" */
export const PAGETREE_MACRO_REGEX = /^:::pagetree(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::toc-zone minLevel=2 maxLevel=4 (with body) */
export const TOC_ZONE_MACRO_REGEX = /^:::toc-zone(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;
/** :::page-properties id="info" (with body; Confluence "details") */
export const PAGE_PROPERTIES_MACRO_REGEX = /^:::page-properties(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;
/** :::page-properties-report labels="status" (Confluence "detailssummary") */
export const PAGE_PROPERTIES_REPORT_REGEX = /^:::page-properties-report(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::task-report spaces="DEV" labels="sprint-1" (Confluence "tasks-report-macro") */
export const TASK_REPORT_MACRO_REGEX = /^:::task-report(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::labels (labels of the current page) */
export const LABELS_LIST_MACRO_REGEX = /^:::labels\n?:::\s*$/gm;
/** :::popular-labels count=20 spaces="DEV" */
export const POPULAR_LABELS_MACRO_REGEX = /^:::popular-labels(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::related-labels labels="api,docs" */
export const RELATED_LABELS_MACRO_REGEX = /^:::related-labels(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::blog-posts max=10 spaces="TEAM" */
export const BLOG_POSTS_MACRO_REGEX = /^:::blog-posts(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::spaces-list spaces="DEV,OPS" */
export const SPACES_LIST_MACRO_REGEX = /^:::spaces-list(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::page-index */
export const PAGE_INDEX_MACRO_REGEX = /^:::page-index\n?:::\s*$/gm;
/** :::contributors mode=list limit=10 */
export const CONTRIBUTORS_MACRO_REGEX = /^:::contributors(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::change-history limit=10 */
export const CHANGE_HISTORY_MACRO_REGEX = /^:::change-history(?:[ \t]+(.+))?\n?:::\s*$/gm;
/** :::loremipsum paragraphs=3 */
export const LOREMIPSUM_MACRO_REGEX = /^:::loremipsum(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * One block macro as `markdownToStorage` consumes it. `body` is the capture
 * group whose Markdown is rendered on its own (nested `:::` lines in it end
 * up as literal text); `columns` marks the section/column construct.
 */
export interface BlockMacroRule {
  regex: RegExp;
  body?: number;
  columns?: true;
}

/** Block macros in the order `markdownToStorage` replaces them. */
export const BLOCK_MACRO_RULES: readonly BlockMacroRule[] = [
  { regex: PANEL_MACRO_REGEX, body: 2 },
  { regex: EXCERPT_MACRO_REGEX, body: 2 },
  { regex: EXCERPT_INCLUDE_REGEX },
  { regex: INCLUDE_MACRO_REGEX },
  { regex: GALLERY_MACRO_REGEX },
  { regex: ATTACHMENTS_MACRO_REGEX },
  { regex: MULTIMEDIA_MACRO_REGEX },
  { regex: WIDGET_MACRO_REGEX },
  { regex: SECTION_MACRO_REGEX, columns: true },
  { regex: CHILDREN_MACRO_REGEX },
  { regex: CONTENT_BY_LABEL_REGEX },
  { regex: RECENTLY_UPDATED_REGEX },
  { regex: PAGETREE_MACRO_REGEX },
  { regex: TOC_ZONE_MACRO_REGEX, body: 2 },
  { regex: PAGE_PROPERTIES_MACRO_REGEX, body: 2 },
  { regex: PAGE_PROPERTIES_REPORT_REGEX },
  { regex: TASK_REPORT_MACRO_REGEX },
  { regex: LABELS_LIST_MACRO_REGEX },
  { regex: POPULAR_LABELS_MACRO_REGEX },
  { regex: RELATED_LABELS_MACRO_REGEX },
  { regex: BLOG_POSTS_MACRO_REGEX },
  { regex: SPACES_LIST_MACRO_REGEX },
  { regex: PAGE_INDEX_MACRO_REGEX },
  { regex: CONTRIBUTORS_MACRO_REGEX },
  { regex: CHANGE_HISTORY_MACRO_REGEX },
  { regex: LOREMIPSUM_MACRO_REGEX },
  { regex: CONFLUENCE_MACRO_REGEX },
  { regex: MACRO_REGEX, body: 3 },
];
