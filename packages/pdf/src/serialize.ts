import type { ExportNote, InlineNode, LinkTarget } from "@atlcli/confluence";
import { escapeTypstContent, safeColor, typstLabel, typstString } from "./escape.js";
import { ATLCLI_TYPST_TEMPLATE } from "./template.js";
import type {
  PdfSerializeOptions,
  PdfSourceBundle,
  PdfSourceMapEntry,
  PreparedPdfBlock,
  PreparedPdfDocument,
} from "./types.js";

function inlinePlainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "link":
          return inlinePlainText(node.content);
        case "mention":
          return `@${node.displayName ?? node.accountId}`;
        case "status":
          return node.text;
        case "lineBreak":
          return " ";
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    })
    .join("");
}

function resolveLink(target: LinkTarget, labels: Map<string, string>): string | null {
  switch (target.kind) {
    case "external":
      return /^(https?:|mailto:)/i.test(target.href) ? target.href : null;
    case "anchor":
      return labels.get(target.anchor) ? `<${labels.get(target.anchor)}>` : null;
    case "page":
      return null;
    case "attachment":
      return null;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function serializeInline(nodes: InlineNode[], labels: Map<string, string>, notes: ExportNote[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text": {
          let out = escapeTypstContent(node.text);
          for (const mark of node.marks ?? []) {
            switch (mark) {
              case "bold":
                out = `#strong[${out}]`;
                break;
              case "italic":
                out = `#emph[${out}]`;
                break;
              case "underline":
                out = `#underline[${out}]`;
                break;
              case "strike":
                out = `#strike[${out}]`;
                break;
              case "code":
                out = `#raw(${typstString(node.text)})`;
                break;
              case "subscript":
                out = `#sub[${out}]`;
                break;
              case "superscript":
                out = `#super[${out}]`;
                break;
              default: {
                const exhaustive: never = mark;
                out = exhaustive;
              }
            }
          }
          if (node.color) out = `#text(fill: rgb(${typstString(safeColor(node.color))}))[${out}]`;
          return out;
        }
        case "lineBreak":
          return "#linebreak()";
        case "mention":
          return `#text(fill: rgb(\"#0747A6\"))[${escapeTypstContent(`@${node.displayName ?? node.accountId}`)}]`;
        case "status":
          return `#status-badge(${typstString(node.text || node.color)}, color: ${typstString(safeColor(node.color))})`;
        case "link": {
          const content = serializeInline(node.content, labels, notes);
          const href = resolveLink(node.target, labels);
          if (!href) {
            notes.push({
              level: "info",
              code: "pdf-link-unresolved",
              message: `Link target could not be represented in PDF: ${inlinePlainText(node.content) || "link"}`,
            });
            return content;
          }
          if (href.startsWith("<")) return `#link(${href})[${content}]`;
          return `#link(${typstString(href)})[${content}]`;
        }
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    })
    .join("");
}

function minHeadingLevel(blocks: PreparedPdfBlock[]): number {
  let min = Infinity;
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        min = Math.min(min, block.level);
        break;
      case "callout":
      case "blockquote":
        min = Math.min(min, minHeadingLevel(block.content));
        break;
      case "list":
        for (const item of block.items) min = Math.min(min, minHeadingLevel(item.content));
        break;
      case "table":
        for (const row of block.rows) {
          for (const cell of row.cells) min = Math.min(min, minHeadingLevel(cell.content));
        }
        break;
    }
  }
  return min;
}

function collectHeadingLabels(blocks: PreparedPdfBlock[]): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  const walk = (list: PreparedPdfBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "heading": {
          const text = inlinePlainText(block.content);
          const base = typstLabel(text);
          const count = (counts.get(base) ?? 0) + 1;
          counts.set(base, count);
          const label = count === 1 ? base : `${base}-${count}`;
          if (!labels.has(text)) labels.set(text, label);
          break;
        }
        case "callout":
        case "blockquote":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return labels;
}

interface Writer {
  lines: string[];
  sourceMap: PdfSourceMapEntry[];
  notes: ExportNote[];
  labels: Map<string, string>;
  headingOffset: number;
  headingCounts: Map<string, number>;
}

function serializeBlocks(blocks: PreparedPdfBlock[], writer: Writer, parentPath = "blocks"): string {
  return blocks
    .map((block, index) => serializeBlock(block, writer, `${parentPath}[${index}]`))
    .join("\n");
}

function writeMapped(block: PreparedPdfBlock, writer: Writer, path: string, value: string, summary?: string): string {
  const startLine = writer.lines.length + 1;
  const marker = `// atlcli:${path}`;
  const chunk = `${marker}\n${value}`;
  writer.lines.push(...chunk.split("\n"));
  writer.sourceMap.push({
    blockPath: path,
    blockType: block.type,
    startLine,
    endLine: writer.lines.length,
    summary,
  });
  return chunk;
}

function serializeBlock(block: PreparedPdfBlock, writer: Writer, path: string): string {
  let value: string;
  let summary: string | undefined;
  switch (block.type) {
    case "heading": {
      summary = inlinePlainText(block.content);
      const base = typstLabel(summary);
      const count = (writer.headingCounts.get(base) ?? 0) + 1;
      writer.headingCounts.set(base, count);
      const label = count === 1 ? base : `${base}-${count}`;
      const level = Math.max(1, Math.min(6, block.level - writer.headingOffset));
      value = `#heading(level: ${level}, outlined: true)[${serializeInline(block.content, writer.labels, writer.notes)}] <${label}>`;
      break;
    }
    case "paragraph":
      value = `#par[${serializeInline(block.content, writer.labels, writer.notes)}]`;
      break;
    case "codeBlock":
      value = `#raw(${typstString(block.code)}, lang: ${typstString(block.language ?? "text")}, block: true)`;
      break;
    case "diagram":
      value = `#figure(image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? "Diagram")}), placement: auto)`;
      break;
    case "image":
      if (!block.assetPath) {
        value = `#par[#emph[${escapeTypstContent(`[Image unavailable: ${block.fallbackLabel}]`)}]]`;
      } else {
        if (!block.alt) {
          writer.notes.push({
            level: "warning",
            code: "pdf-image-alt-fallback",
            message: `${block.fallbackLabel} uses a technical filename fallback for alternative text.`,
          });
        }
        value = `#figure(image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? block.fallbackLabel)}), placement: auto)`;
      }
      break;
    case "callout": {
      const title = block.title ? `[${escapeTypstContent(block.title)}]` : "none";
      value = `#callout(kind: ${typstString(block.kind)}, title: ${title})[\n${serializeBlocks(block.content, writer, `${path}.content`)}\n]`;
      break;
    }
    case "blockquote":
      value = `#quote(block: true)[\n${serializeBlocks(block.content, writer, `${path}.content`)}\n]`;
      break;
    case "list": {
      const fn = block.ordered ? "enum" : "list";
      const items = block.items.map((item, index) => {
        const state = item.checked === undefined ? "" : item.checked ? "☑ " : "☐ ";
        return `[${escapeTypstContent(state)}${serializeBlocks(item.content, writer, `${path}.items[${index}].content`)}]`;
      });
      value = `#${fn}(\n${items.join(",\n")}\n)`;
      break;
    }
    case "table": {
      const columns = Math.max(1, ...block.rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.colspan, 0)));
      const rows = block.rows.map((row, rowIndex) => {
        const cells = row.cells.map((cell, cellIndex) => {
          const args = [
            cell.colspan > 1 ? `colspan: ${cell.colspan}` : "",
            cell.rowspan > 1 ? `rowspan: ${cell.rowspan}` : "",
            cell.header ? 'fill: rgb("#F4F5F7")' : "",
          ].filter(Boolean);
          const content = serializeBlocks(cell.content, writer, `${path}.rows[${rowIndex}].cells[${cellIndex}].content`);
          return `table.cell(${args.length ? `${args.join(", ")}, ` : ""}[${content}])`;
        });
        return row.cells.every((cell) => cell.header)
          ? `table.header(${cells.join(", ")})`
          : cells.join(", ");
      });
      value = `#table(columns: ${columns}, inset: 6pt, stroke: rgb(\"#DFE1E6\"),\n${rows.join(",\n")}\n)`;
      break;
    }
    case "divider":
      value = `#line(length: 100%, stroke: rgb(\"#DFE1E6\"))`;
      break;
    case "unknown":
      writer.notes.push({
        level: "warning",
        code: "pdf-unknown-block",
        message: `Unsupported ${block.macroName} macro was omitted from the PDF.`,
        macroName: block.macroName,
      });
      value = "";
      break;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
  return writeMapped(block, writer, path, value, summary);
}

function typstDate(date: Date): string {
  return `datetime(year: ${date.getUTCFullYear()}, month: ${date.getUTCMonth() + 1}, day: ${date.getUTCDate()})`;
}

export function serializePdfDocument(
  document: PreparedPdfDocument,
  options: PdfSerializeOptions
): PdfSourceBundle {
  const labels = collectHeadingLabels(document.blocks);
  const min = minHeadingLevel(document.blocks);
  const writer: Writer = {
    lines: [],
    sourceMap: [],
    notes: [...document.notes],
    labels,
    headingOffset: min === Infinity ? 0 : min - 1,
    headingCounts: new Map(),
  };
  const body = serializeBlocks(document.blocks, writer);
  const meta = options.metadata;
  const author = meta.author ?? meta.exporter ?? "atlcli";
  const exportedLabel = meta.exportedAt.toISOString().slice(0, 10);
  const main = String.raw`#import "atlcli.typ": atlcli-doc, callout, status-badge

#show: atlcli-doc.with(meta: (
  title: ${typstString(meta.title)},
  space: ${typstString(meta.space ?? "Confluence")},
  version: ${typstString(meta.version === undefined ? "—" : `v${meta.version}`)},
  author: ${typstString(author)},
  exporter: ${typstString(meta.exporter ?? author)},
  exported-at: ${typstDate(meta.exportedAt)},
  exported-label: ${typstString(exportedLabel)},
))

${body}
`;

  return {
    main,
    template: ATLCLI_TYPST_TEMPLATE,
    assets: document.assets,
    sourceMap: writer.sourceMap,
    notes: writer.notes,
  };
}

export function mapPdfDiagnostics(
  diagnostics: Array<{ severity?: string; message: string; path?: string; line?: number }>,
  sourceMap: PdfSourceMapEntry[]
): Array<{ severity: "error" | "warning"; message: string; path?: string; startLine?: number; blockPath?: string }> {
  return diagnostics.map((diagnostic) => {
    const line = diagnostic.line;
    const mapped =
      diagnostic.path === "main.typ" && line !== undefined
        ? sourceMap.find((entry) => line >= entry.startLine && line <= entry.endLine)
        : undefined;
    return {
      severity: diagnostic.severity === "warning" ? "warning" : "error",
      message: diagnostic.message,
      path: diagnostic.path,
      startLine: line,
      blockPath: mapped?.blockPath,
    };
  });
}
