export interface PdfOutputInspection {
  pageCount: number;
  tagged: boolean;
  hasOutline: boolean;
  embeddedFontFiles: number;
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
  };
}
