import type { ExportBlock } from "@atlcli/confluence";
import {
  canonicalCodeLanguage,
  DEFAULT_CODE_THEME,
  prepareCodeHighlighting,
  type CodeHighlightTiming,
  type CodeLanguageId,
  type CodeThemeId,
} from "@atlcli/code-highlight";

export interface DocxCodeHighlightingOptions {
  codeTheme?: CodeThemeId;
}

export interface DocxCodeHighlightUsage {
  /** Non-Mermaid code blocks that follow the syntax-highlighting path. */
  codeBlocks: number;
  /** Distinct known canonical languages, in first-occurrence order. */
  languages: CodeLanguageId[];
}

/** Mutable export-wide collector shared by the body and include serializers. */
export interface DocxCodeHighlightTimingCollector {
  engineInitMs: number;
  grammarLoadMs: number;
  tokenizeMs: number;
  codeBlocks: number;
  languages: Set<CodeLanguageId>;
}

export function createDocxCodeHighlightTimingCollector(): DocxCodeHighlightTimingCollector {
  return {
    engineInitMs: 0,
    grammarLoadMs: 0,
    tokenizeMs: 0,
    codeBlocks: 0,
    languages: new Set(),
  };
}

export function addDocxCodeHighlightTiming(
  collector: DocxCodeHighlightTimingCollector,
  timing: CodeHighlightTiming,
): void {
  collector.engineInitMs += timing.engineInitMs;
  collector.grammarLoadMs += timing.grammarLoadMs;
  collector.tokenizeMs += timing.tokenizeMs;
}

/**
 * Collect only code blocks handled by Shiki. Mermaid remains on the diagram
 * path. Unknown/missing languages still count as code blocks but do not cause
 * a grammar preload.
 */
export function collectDocxCodeHighlightUsage(
  blocks: readonly ExportBlock[],
): DocxCodeHighlightUsage {
  let codeBlocks = 0;
  const languages = new Set<CodeLanguageId>();
  const walk = (list: readonly ExportBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "codeBlock": {
          const requested = (block.language ?? "").trim().toLowerCase();
          if (requested === "mermaid") break;
          codeBlocks += 1;
          const canonical = canonicalCodeLanguage(requested);
          if (canonical) languages.add(canonical);
          break;
        }
        case "callout":
        case "expand":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "layout":
          for (const column of block.columns) walk(column.content);
          break;
        case "table":
          for (const row of block.rows) {
            for (const cell of row.cells) walk(cell.content);
          }
          break;
      }
    }
  };
  walk(blocks);
  return { codeBlocks, languages: [...languages] };
}

/**
 * Await initialization and only the known grammars present in these DOCX
 * blocks. Repeated and concurrent calls share the package-level cache.
 */
export async function prepareDocxCodeHighlighting(
  blocks: readonly ExportBlock[],
  options: DocxCodeHighlightingOptions = {},
): Promise<void> {
  const usage = collectDocxCodeHighlightUsage(blocks);
  await prepareCodeHighlighting(
    usage.languages,
    options.codeTheme ?? DEFAULT_CODE_THEME,
  );
}
