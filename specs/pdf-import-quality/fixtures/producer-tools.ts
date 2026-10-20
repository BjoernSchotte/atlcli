#!/usr/bin/env bun
/**
 * Prepare and sanitize customer-neutral desktop producer fixtures.
 *
 *   bun specs/pdf-import-quality/fixtures/producer-tools.ts producer-source --output <file.docx>
 *   bun specs/pdf-import-quality/fixtures/producer-tools.ts sanitize-export \
 *     --input <raw.pdf> --output <fixture.pdf> --producer "<producer and version>"
 *
 * `producer-source` writes a minimal WordprocessingML document from
 * `producer-source.json`. `sanitize-export` rewrites a PDF from its trailer:
 * only reachable objects are written (unreferenced and cloned objects drop
 * out), the XMP stream is removed and the Info dictionary is replaced with
 * neutral values. Stream bytes are copied unchanged. It does not make a
 * private input safe; never run a private PDF through it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  PdfObjectReader,
  isRef,
  type PdfValue,
} from "../../../packages/import-pdf/src/pdf-objects.js";

const HERE = import.meta.dir;
const NEUTRAL_INFO = {
  Title: "Neutral Harbor Field Notes",
  Author: "AtlCLI neutral fixture generator",
  Subject: "Synthetic PDF import quality evidence",
};

// ---------------------------------------------------------------------------
// sanitize-export
// ---------------------------------------------------------------------------

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const REGULAR_NAME_BYTE = (b: number) => b > 0x20 && b < 0x7f && !"()<>[]{}/%#".includes(String.fromCharCode(b));

function utf16Text(text: string): string {
  const units = [0xfe, 0xff];
  for (const c of text) {
    const code = c.codePointAt(0)!;
    const push = (u: number) => units.push(u >> 8, u & 0xff);
    if (code > 0xffff) {
      push(0xd800 + ((code - 0x10000) >> 10));
      push(0xdc00 + ((code - 0x10000) & 0x3ff));
    } else push(code);
  }
  return `<${hex(Uint8Array.from(units))}>`;
}

function number(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 1e-9) return "0";
  return value.toFixed(10).replace(/0+$/u, "").replace(/\.$/u, "");
}

/** Rewrites every object reachable from the trailer's Root, keeping object numbers. */
export function sanitizePdf(bytes: Uint8Array, producer: string): Uint8Array {
  const reader = new PdfObjectReader(bytes);
  const reachable = new Set<number>();
  const visit = (value: PdfValue | undefined): void => {
    if (value === null || value === undefined || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.kind === "ref") {
      if (reachable.has(value.num)) return;
      reachable.add(value.num);
      return visit(reader.object(value.num));
    }
    if (value.kind === "dict") return value.entries.forEach((entry) => visit(entry));
    if (value.kind === "stream") return value.dict.entries.forEach((entry) => visit(entry));
  };
  const root = reader.trailer.entries.get("Root");
  if (!isRef(root)) throw new Error("trailer has no indirect Root");
  visit(root);

  const serialize = (value: PdfValue | undefined, skipKey?: (key: string) => boolean): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return number(value);
    if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(" ")}]`;
    switch (value.kind) {
      case "ref":
        return reachable.has(value.num) ? `${value.num} 0 R` : "null";
      case "name":
        return `/${[...value.raw].map((b) => REGULAR_NAME_BYTE(b) ? String.fromCharCode(b) : `#${b.toString(16).padStart(2, "0")}`).join("")}`;
      case "string":
        return `<${hex(value.bytes)}>`;
      case "dict":
      case "stream": {
        const dict = value.kind === "dict" ? value : value.dict;
        const entries = [...dict.entries].filter(([key]) => !skipKey?.(key));
        return `<<${entries.map(([key, entry]) => `${serialize({ kind: "name", value: key, raw: new TextEncoder().encode(key) })} ${serialize(entry)}`).join(" ")}>>`;
      }
    }
  };

  const chunks: Uint8Array[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let length = chunks[0]!.length;
  const offsets = new Map<number, number>();
  const emit = (chunk: Uint8Array) => {
    chunks.push(chunk);
    length += chunk.length;
  };
  const order = [...reachable].sort((left, right) => left - right);
  for (const num of order) {
    offsets.set(num, length);
    const value = reader.object(num);
    const isRoot = num === root.num;
    if (value && typeof value === "object" && !Array.isArray(value) && value.kind === "stream") {
      const dict = serialize(value, (key) => key === "Length").slice(0, -2) + ` /Length ${value.raw.length}>>`;
      emit(latin1(`${num} 0 obj\n${dict}\nstream\n`));
      emit(value.raw);
      emit(latin1("\nendstream\nendobj\n"));
    } else {
      // The document catalog loses its XMP stream; Info is replaced below.
      const body = isRoot ? serialize(value, (key) => key === "Metadata") : serialize(value);
      emit(latin1(`${num} 0 obj\n${body}\nendobj\n`));
    }
  }
  const infoNum = (order.at(-1) ?? 0) + 1;
  offsets.set(infoNum, length);
  const info: Record<string, string> = { ...NEUTRAL_INFO, Creator: producer, Producer: producer };
  emit(latin1(`${infoNum} 0 obj\n<<${Object.entries(info).map(([key, text]) => `/${key} ${utf16Text(text)}`).join(" ")}>>\nendobj\n`));
  const xref = length;
  emit(latin1(
    `xref\n0 ${infoNum + 1}\n0000000000 65535 f \n` +
    Array.from({ length: infoNum }, (_, index) => {
      const offset = offsets.get(index + 1);
      return offset === undefined ? "0000000000 00001 f \n" : `${String(offset).padStart(10, "0")} 00000 n \n`;
    }).join("") +
    `trailer\n<</Size ${infoNum + 1} /Root ${root.num} 0 R /Info ${infoNum} 0 R>>\nstartxref\n${xref}\n%%EOF\n`,
  ));
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// producer-source
// ---------------------------------------------------------------------------

interface ProducerSource {
  title: string;
  paragraphs: Array<Array<{ text: string; bold?: boolean }>>;
  listItems: string[];
  table: string[][];
}

const xml = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const MM = (mm: number) => Math.round((mm / 25.4) * 1440); // twips

/** Font and language properties per run, as the Python generator set them. */
function runProperties(text: string, bold: boolean): string {
  const japanese = text.includes("港");
  const arabic = text.includes("مرحبا");
  const font = japanese ? "MS Mincho" : "Arial Unicode MS";
  return `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>` +
    `${bold ? "<w:b/>" : ""}<w:sz w:val="22"/>` +
    `${japanese ? '<w:lang w:eastAsia="ja-JP"/>' : arabic ? '<w:lang w:bidi="ar-SA"/>' : ""}</w:rPr>`;
}

const run = (text: string, bold = false) =>
  `<w:r>${runProperties(text, bold)}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;

export function producerDocx(source: ProducerSource): Uint8Array {
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(source.title)}</w:p>`,
    ...source.paragraphs.map((runs) => {
      const right = runs.some((entry) => entry.text.includes("مرحبا"));
      return `<w:p>${right ? '<w:pPr><w:jc w:val="right"/></w:pPr>' : ""}${runs.map((entry) => run(entry.text, entry.bold ?? false)).join("")}</w:p>`;
    }),
    ...source.listItems.map((item) =>
      `<w:p><w:pPr><w:pStyle w:val="ListNumber"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(item)}</w:p>`
    ),
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
      `<w:tblGrid>${source.table[0]!.map(() => '<w:gridCol w:w="4320"/>').join("")}</w:tblGrid>` +
      source.table.map((cells, row) =>
        `<w:tr>${cells.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="4320" w:type="dxa"/></w:tcPr><w:p>${run(cell, row === 0)}</w:p></w:tc>`).join("")}</w:tr>`
      ).join("") + "</w:tbl>",
    `<w:p/><w:sectPr><w:pgSz w:w="${MM(210)}" w:h="${MM(297)}"/>` +
      `<w:pgMar w:top="${MM(18)}" w:right="${MM(18)}" w:bottom="${MM(18)}" w:left="${MM(18)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
  ].join("");
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const files: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>` +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/></w:style>' +
      `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders></w:tblPr></w:style>` +
      "</w:styles>",
    "word/numbering.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>` +
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
    "docProps/core.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:title>${xml(source.title)}</dc:title><dc:creator>${xml(NEUTRAL_INFO.Author)}</dc:creator><dc:subject>${xml(NEUTRAL_INFO.Subject)}</dc:subject></cp:coreProperties>`,
  };
  // A fixed timestamp keeps the archive byte-deterministic.
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, [strToU8(text), { mtime: new Date("2026-01-01T00:00:00Z") }]])));
}

// ---------------------------------------------------------------------------

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "producer-source") {
    const source = JSON.parse(await readFile(resolve(HERE, "producer-source.json"), "utf8")) as ProducerSource;
    const output = option(args, "output");
    await writeFile(output, producerDocx(source));
    console.log(`created neutral producer source: ${output}`);
  } else if (command === "sanitize-export") {
    const output = option(args, "output");
    await writeFile(output, sanitizePdf(new Uint8Array(await readFile(option(args, "input"))), option(args, "producer")));
    console.log(`sanitized neutral producer export: ${output}`);
  } else {
    console.error("usage: producer-tools.ts producer-source --output <docx> | sanitize-export --input <pdf> --output <pdf> --producer <name>");
    process.exit(2);
  }
}
