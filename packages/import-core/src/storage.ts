import type { ImportBlock, ImportListBlock, ImportProjectionInput, ImportRun } from "./model.js";
import { resolveImportReference } from "./model.js";

export interface StorageEncodeOptions {
  references?: ReadonlyMap<string, string>;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function encodeRuns(runs: ImportRun[], options: StorageEncodeOptions): string {
  let output = "";
  for (const run of runs) {
    if (run.kind === "hard-break") {
      output += "<br/>";
      continue;
    }
    if (!run.text) continue;
    let text = escapeXml(run.text);
    if (run.marks?.code) text = `<code>${text}</code>`;
    if (run.marks?.italic) text = `<em>${text}</em>`;
    if (run.marks?.bold) text = `<strong>${text}</strong>`;
    if (run.marks?.link) text = `<a href="${escapeXml(run.marks.link.href)}">${text}</a>`;
    else if (run.marks?.reference) {
      const href = resolveImportReference(run.marks.reference, options.references);
      if (href) text = `<a href="${escapeXml(href)}">${text}</a>`;
    }
    output += text;
  }
  return output;
}

function encodeList(list: ImportListBlock, options: StorageEncodeOptions, assets: ReadonlyMap<string, string>): string {
  const tag = list.ordered ? "ol" : "ul";
  const items = list.items.map((item) => {
    const content = encodeBlocks(item.blocks, options, assets);
    const child = item.child ? encodeList(item.child, options, assets) : "";
    return `<li>${content || "<p/>"}${child}</li>`;
  }).join("");
  return `<${tag}>${items}</${tag}>`;
}

function encodeBlock(block: ImportBlock, options: StorageEncodeOptions, assets: ReadonlyMap<string, string>): string {
  switch (block.type) {
    case "heading":
      return `<h${block.level}>${block.label ? `${escapeXml(block.label)} ` : ""}${encodeRuns(block.runs, options)}</h${block.level}>`;
    case "paragraph":
      return `<p>${encodeRuns(block.runs, options)}</p>`;
    case "list":
      return encodeList(block, options, assets);
    case "table":
      return `<table><tbody>${block.rows.map((row) => `<tr>${row.cells.map((cell) => {
        const tag = cell.header ? "th" : "td";
        const spans = `${cell.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ""}${cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ""}`;
        return `<${tag}${spans}>${encodeBlocks(cell.blocks, options, assets) || "<p/>"}</${tag}>`;
      }).join("")}</tr>`).join("")}</tbody></table>`;
    case "image": {
      const filename = assets.get(block.assetId) ?? block.assetId.slice(block.assetId.lastIndexOf("/") + 1);
      const alt = block.alt ? ` ac:alt="${escapeXml(block.alt)}"` : "";
      const width = block.width ? ` ac:width="${block.width}"` : "";
      return `<ac:image${alt}${width}><ri:attachment ri:filename="${escapeXml(filename)}"/></ac:image>`;
    }
    case "blockquote":
      return `<blockquote>${encodeBlocks(block.blocks, options, assets) || "<p/>"}</blockquote>`;
    case "code":
      return `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${block.text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></ac:plain-text-body></ac:structured-macro>`;
    case "page-break":
      return "";
  }
}

function encodeBlocks(blocks: ImportBlock[], options: StorageEncodeOptions, assets: ReadonlyMap<string, string>): string {
  return blocks.map((block) => encodeBlock(block, options, assets)).join("");
}

export function documentToStorage(
  document: Pick<ImportProjectionInput, "blocks" | "assets">,
  options: StorageEncodeOptions = {},
): string {
  const assets = new Map(document.assets.map((asset) => [asset.id, asset.fileName]));
  return encodeBlocks(document.blocks, options, assets);
}

export function storageTagSequence(storage: string): string[] {
  const tags: string[] = [];
  const expression = /<(h[1-6]|p|ul|ol|table|blockquote|ac:image|ac:structured-macro)[\s/>]/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(storage)) !== null) tags.push(match[1]);
  return tags;
}
