/**
 * Pure fragment extraction over walked blocks (spec 004, E4/E5 shared helper).
 *
 * The storage XML tokenizer lives in `@atlcli/confluence` and cannot be imported
 * at runtime here (package boundary). But `storageToBlocks` already captures a
 * macro's `<ac:rich-text-body>` onto its `unknown` block, so extracting a named
 * excerpt is a pure walk over the walked block tree — no second parser needed.
 */
import type { ExportBlock, MacroParameter } from "@atlcli/confluence";
import { macroParamText } from "./params.js";

type UnknownBlock = Extract<ExportBlock, { type: "unknown" }>;

function nameParam(params: MacroParameter[] | undefined): string | undefined {
  return (
    macroParamText(params, "MultiExcerptName") ??
    macroParamText(params, "name") ??
    // Some excerpt macros carry the name as the unnamed first parameter.
    params?.find((p) => p.name === "")?.text
  );
}

function findUnknown(
  blocks: ExportBlock[],
  predicate: (b: UnknownBlock) => boolean
): UnknownBlock | undefined {
  for (const b of blocks) {
    if (b.type === "unknown") {
      if (predicate(b)) return b;
      if (b.body) {
        const inner = findUnknown(b.body, predicate);
        if (inner) return inner;
      }
      continue;
    }
    let children: ExportBlock[] | undefined;
    switch (b.type) {
      case "callout":
      case "blockquote":
      case "orientation":
        children = b.content;
        break;
      case "list":
        for (const item of b.items) {
          const inner = findUnknown(item.content, predicate);
          if (inner) return inner;
        }
        break;
      case "table":
        for (const row of b.rows) {
          for (const cell of row.cells) {
            const inner = findUnknown(cell.content, predicate);
            if (inner) return inner;
          }
        }
        break;
      default:
        break;
    }
    if (children) {
      const inner = findUnknown(children, predicate);
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * Find the body blocks of a named excerpt/multiexcerpt definition macro in a
 * walked block tree. `macroNames` is the set of definition-side macro names
 * (lowercased). When `name` is empty, matches the first definition macro
 * (Confluence's plain `excerpt` macro is unnamed).
 */
export function extractMacroBody(
  blocks: ExportBlock[],
  macroNames: readonly string[],
  name: string
): ExportBlock[] | undefined {
  const want = macroNames.map((n) => n.toLowerCase());
  const wantedName = name.trim();
  const match = findUnknown(blocks, (b) => {
    if (!want.includes(b.macroName.toLowerCase())) return false;
    if (wantedName === "") return true;
    const declared = nameParam(b.params)?.trim() ?? "";
    return declared.toLowerCase() === wantedName.toLowerCase();
  });
  return match?.body;
}
