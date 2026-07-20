export interface PdfOutputInspection {
  pageCount: number;
  tagged: boolean;
  hasOutline: boolean;
  embeddedFontFiles: number;
  /**
   * Whether the document catalog declares a natural language (`/Lang`) —
   * PDF/UA-1 7.2 and ISO 32000 14.9.2 both require it, and a screen reader
   * without it guesses the pronunciation of every word (spec 011, PDF/UA).
   *
   * Reported, never thrown: the built-in template always emits `/Lang` (it is
   * verified against the real compiler in
   * `packages/pdf-compiler-browser/src/pdf-lang-catalog.test.ts`), but a
   * Level-B custom template is not obliged to, and refusing to emit a
   * compiled document over a missing language would be a harsher gate than
   * the missing-alt audit next to it. `runPdfExport` turns a `false` here into
   * a `pdf-language-missing` warning on the report.
   */
  hasLang: boolean;
}

/**
 * `/Lang` in the document catalog. Matched against the catalog dictionary
 * specifically (not anywhere in the file) so an XMP `dc:language` packet or a
 * `/Lang` on some structure element cannot be mistaken for the document-level
 * declaration that PDF/UA requires.
 *
 * The built-in template's compiler (typst.ts 0.7.0 / Typst 0.14.2) writes the
 * catalog uncompressed, so a byte scan is sufficient and no stream inflation is
 * needed — verified by compiling real PDFs, see the test named above.
 */
function hasCatalogLang(text: string): boolean {
  for (const match of text.matchAll(/\/Type\s*\/Catalog\b/g)) {
    // The enclosing indirect object: from the `obj` keyword that opens it to
    // the `endobj` that closes it. Scanning the whole object (not just forward
    // from `/Type`) keeps the check independent of key order inside the dict.
    const objStart = text.lastIndexOf(" obj", match.index);
    const objEnd = text.indexOf("endobj", match.index);
    const body = text.slice(objStart < 0 ? match.index : objStart, objEnd < 0 ? text.length : objEnd);
    if (/\/Lang\s*[(<]/.test(body)) return true;
  }
  return false;
}

/** Cheap structural gate before a browser host emits compiled PDF bytes. */
export function validatePdfOutput(bytes: Uint8Array): PdfOutputInspection {
  if (bytes.byteLength < 32) throw new Error("PDF compiler returned a truncated document.");
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.startsWith("%PDF-")) throw new Error("PDF compiler returned invalid file bytes.");
  if (!/%%EOF\s*$/.test(text)) throw new Error("PDF compiler returned an incomplete document.");

  const pageCount = text.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  if (pageCount === 0) throw new Error("PDF contains no pages.");
  const tagged = /\/StructTreeRoot\b/.test(text) && /\/MarkInfo\b/.test(text);
  if (!tagged) throw new Error("PDF compiler output is missing the required tag structure.");
  const embeddedFontFiles = text.match(/\/FontFile(?:2|3)?\b/g)?.length ?? 0;
  if (embeddedFontFiles === 0) throw new Error("PDF compiler output has no embedded font files.");

  return {
    pageCount,
    tagged,
    hasOutline: /\/Outlines\b/.test(text),
    embeddedFontFiles,
    hasLang: hasCatalogLang(text),
  };
}
