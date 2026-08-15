/**
 * Neutral IR → Confluence Storage XHTML encoder for the Data Center path
 * (MVP §2.2: the body representation is selected by capability — DC gets
 * Storage through REST v1, Cloud gets ADF through v2; the two encoders
 * stay independent per §6.2).
 *
 * Deterministic and self-contained: images reference their attachment by
 * FILENAME (`<ac:image><ri:attachment ri:filename="…"/></ac:image>`), the
 * documented DC contract — no upload-time identity is needed inside the
 * body, unlike Cloud's media fileId.
 */
import type { ImportBlock, ImportListBlock, ImportRun, ImportedDocument } from "./model.js";

export interface StorageEncodeOptions {
  /** Bookmark name → absolute page URL (unused until DC split ships). */
  anchors?: ReadonlyMap<string, string>;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function encodeRuns(runs: ImportRun[], options: StorageEncodeOptions): string {
  let out = "";
  for (const run of runs) {
    if (run.kind === "hard-break") {
      out += "<br/>";
      continue;
    }
    if (run.text.length === 0) continue;
    let text = escapeXml(run.text);
    if (run.marks?.code) text = `<code>${text}</code>`;
    if (run.marks?.italic) text = `<em>${text}</em>`;
    if (run.marks?.bold) text = `<strong>${text}</strong>`;
    if (run.marks?.link) {
      text = `<a href="${escapeXml(run.marks.link.href)}">${text}</a>`;
    } else if (run.marks?.anchorLink) {
      const href = options.anchors?.get(run.marks.anchorLink.anchor);
      if (href) text = `<a href="${escapeXml(href)}">${text}</a>`;
    }
    out += text;
  }
  return out;
}

function encodeList(list: ImportListBlock, options: StorageEncodeOptions): string {
  const tag = list.ordered ? "ol" : "ul";
  const items = list.items
    .map((item) => {
      const content = item.blocks.map((b) => encodeBlock(b, options)).join("");
      const child = item.child ? encodeList(item.child, options) : "";
      return `<li>${content || "<p/>"}${child}</li>`;
    })
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

function encodeBlock(block: ImportBlock, options: StorageEncodeOptions): string {
  switch (block.type) {
    case "heading": {
      const label = block.label ? `${escapeXml(block.label)} ` : "";
      return `<h${block.level}>${label}${encodeRuns(block.runs, options)}</h${block.level}>`;
    }
    case "paragraph":
      return `<p>${encodeRuns(block.runs, options)}</p>`;
    case "list":
      return encodeList(block, options);
    case "table": {
      const rows = block.rows
        .map((row) => {
          const cells = row.cells
            .map((cell) => {
              const tag = cell.header ? "th" : "td";
              const content = cell.blocks.map((b) => encodeBlock(b, options)).join("") || "<p/>";
              return `<${tag}>${content}</${tag}>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<table><tbody>${rows}</tbody></table>`;
    }
    case "image": {
      // The asset id is the package part path; the upload uses its basename.
      const filename = block.assetId.slice(block.assetId.lastIndexOf("/") + 1);
      const alt = block.alt ? ` ac:alt="${escapeXml(block.alt)}"` : "";
      const width = block.width ? ` ac:width="${block.width}"` : "";
      return `<ac:image${alt}${width}><ri:attachment ri:filename="${escapeXml(filename)}"/></ac:image>`;
    }
    case "blockquote":
      return `<blockquote>${block.blocks.map((b) => encodeBlock(b, options)).join("") || "<p/>"}</blockquote>`;
    case "code":
      return (
        `<ac:structured-macro ac:name="code"><ac:plain-text-body>` +
        `<![CDATA[${block.text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>` +
        `</ac:plain-text-body></ac:structured-macro>`
      );
  }
}

export function documentToStorage(doc: ImportedDocument, options: StorageEncodeOptions = {}): string {
  return doc.blocks.map((b) => encodeBlock(b, options)).join("");
}

/**
 * Coarse structural fingerprint of a Storage body: the sequence of
 * top-level-ish structural tags. Used by the DC readback verification —
 * DC may normalize attribute order/whitespace, but the structural tag
 * sequence must survive a create/read roundtrip.
 */
export function storageTagSequence(storage: string): string[] {
  const tags: string[] = [];
  const re = /<(h[1-6]|p|ul|ol|table|blockquote|ac:image|ac:structured-macro)[\s/>]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(storage)) !== null) tags.push(match[1]);
  return tags;
}
