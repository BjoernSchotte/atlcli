/**
 * OPC package bookkeeping shared by every part the export adds: relationships
 * and `[Content_Types].xml` entries. One implementation, so "is it already
 * declared?" is answered the same way everywhere — attribute quotes in a
 * customer template are `"` or `'`, and a declaration added twice makes Word
 * report the file as corrupt.
 */
import type PizZip from "pizzip";

const CT_PATH = "[Content_Types].xml";
const OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORDPROCESSINGML_CONTENT_TYPES = "application/vnd.openxmlformats-officedocument.wordprocessingml";

export const EMPTY_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `word/header1.xml` → `word/_rels/header1.xml.rels` (OPC rels convention). */
export function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : partPath.slice(0, slash + 1);
  const base = slash === -1 ? partPath : partPath.slice(slash + 1);
  return `${dir}_rels/${base}.rels`;
}

/**
 * Append a relationship to `partPath`'s rels part (created when missing) under
 * the next free `rIdN`, and return that id. Existing ids are read in either
 * quote style: counting only `Id="…"` could re-issue an id a template spelled
 * `Id='…'`.
 */
export function addRelationship(zip: PizZip, partPath: string, type: string, target: string): string {
  const relsPath = relsPathFor(partPath);
  const rels = zip.file(relsPath)?.asText() ?? EMPTY_RELS;
  const ids = [...rels.matchAll(/Id=["']rId(\d+)["']/g)].map((m) => Number(m[1]));
  const id = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
  zip.file(
    relsPath,
    rels.replace("</Relationships>", `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`)
  );
  return id;
}

/** Add a `<Default Extension=…>` to `[Content_Types].xml` unless present. */
export function ensureContentTypeDefault(zip: PizZip, ext: string, mime: string): void {
  const ct = zip.file(CT_PATH)?.asText();
  if (!ct) return; // not a Word package — unzipDocx would have rejected it
  if (new RegExp(`<Default\\b[^>]*\\bExtension=(["'])${escapeRegExp(ext)}\\1`, "i").test(ct)) return;
  zip.file(CT_PATH, ct.replace("</Types>", `<Default Extension="${ext}" ContentType="${mime}"/></Types>`));
}

/** Add an `<Override PartName=…>` for one part (`word/numbering.xml`) unless present. */
export function ensureContentTypeOverride(zip: PizZip, partName: string, contentType: string): void {
  const ct = zip.file(CT_PATH)?.asText();
  if (!ct) return;
  if (new RegExp(`\\bPartName=(["'])/${escapeRegExp(partName)}\\1`, "i").test(ct)) return;
  zip.file(
    CT_PATH,
    ct.replace("</Types>", `<Override PartName="/${partName}" ContentType="${contentType}"/></Types>`)
  );
}

/**
 * Register one of the main document's singleton parts — `word/<kind>.xml` —
 * with its content-type override and its relationship from the document. A
 * document has at most one relationship of each of these types, so an existing
 * one (whatever its target is called) is left alone.
 */
export function registerDocumentPart(zip: PizZip, kind: "numbering" | "comments" | "settings"): void {
  ensureContentTypeOverride(zip, `word/${kind}.xml`, `${WORDPROCESSINGML_CONTENT_TYPES}.${kind}+xml`);
  const rels = zip.file(relsPathFor("word/document.xml"))?.asText() ?? "";
  if (new RegExp(`\\bType=(["'])[^"']*/relationships/${kind}\\1`).test(rels)) return;
  addRelationship(zip, "word/document.xml", `${OFFICE_RELATIONSHIPS}/${kind}`, `${kind}.xml`);
}
