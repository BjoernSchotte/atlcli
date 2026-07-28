/**
 * Deterministic WordprocessingML font embedding for the bundled code face.
 *
 * ECMA-376 Part 4 §2.8.1 requires an embedded Word font to be stored as an
 * obfuscated font part: reverse the GUID bytes, then XOR that 16-byte key over
 * the first two 16-byte blocks of the original OpenType/TrueType file.
 */
import PizZip from "pizzip";

export const CODE_FONT_FAMILY = "JetBrains Mono";
export const CODE_FONT_FILE = "JetBrainsMono-Regular.ttf";
export const CODE_FONT_KEY = "{001B70DC-AA60-4AD5-90EC-18A0948E1EAE}";
export const CODE_FONT_SHA256 =
  "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f";

const FONT_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";
const FONT_TABLE_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable";
const FONT_TABLE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml";
const OBFUSCATED_FONT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.obfuscatedFont";
const WORDPROCESSING_NS =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";

const FONT_PART_NAME =
  "word/fonts/atlcli-code-001b70dc-aa60-4ad5-90ec-18a0948e1eae.odttf";
const FONT_TABLE_PART = "word/fontTable.xml";
const FONT_TABLE_RELS_PART = "word/_rels/fontTable.xml.rels";
const DOCUMENT_RELS_PART = "word/_rels/document.xml.rels";
const FONT_REL_ID = "rIdAtlcliCodeFont";
const FONT_TABLE_REL_ID = "rIdAtlcliFontTable";

export class DocxFontEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxFontEmbeddingError";
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function sfntTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/**
 * Validate enough of the sfnt directory to refuse corrupt or license-restricted
 * input before it becomes a document part. The bundled OFL face has fsType=0
 * (installable embedding); preview/print and editable embedding would also be
 * legal for a full, non-subsetted document font.
 */
export function assertEmbeddableSfnt(bytes: Uint8Array): void {
  if (bytes.byteLength < 32) {
    throw new DocxFontEmbeddingError("The DOCX code font is shorter than an sfnt header.");
  }
  const magic = readU32(bytes, 0);
  if (magic !== 0x00010000 && sfntTag(bytes, 0) !== "OTTO") {
    throw new DocxFontEmbeddingError("The DOCX code font is not a TrueType/OpenType sfnt.");
  }

  const tableCount = readU16(bytes, 4);
  const directoryEnd = 12 + tableCount * 16;
  if (directoryEnd > bytes.byteLength) {
    throw new DocxFontEmbeddingError("The DOCX code font has a truncated sfnt directory.");
  }

  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (sfntTag(bytes, record) !== "OS/2") continue;
    const offset = readU32(bytes, record + 8);
    const length = readU32(bytes, record + 12);
    if (length < 10 || offset + length > bytes.byteLength) {
      throw new DocxFontEmbeddingError("The DOCX code font has a corrupt OS/2 table.");
    }
    const fsType = readU16(bytes, offset + 8);
    if ((fsType & 0x0002) !== 0) {
      throw new DocxFontEmbeddingError(
        "The DOCX code font license forbids document embedding (OS/2 fsType restricted).",
      );
    }
    if ((fsType & 0x0200) !== 0) {
      throw new DocxFontEmbeddingError(
        "The DOCX code font permits bitmap-only embedding, not the required outline font.",
      );
    }
    return;
  }

  throw new DocxFontEmbeddingError("The DOCX code font has no OS/2 embedding-rights table.");
}

/** Verify that a host delivered the exact committed face named by the OOXML. */
export async function assertBundledCodeFont(bytes: Uint8Array): Promise<void> {
  assertEmbeddableSfnt(bytes);
  const owned = Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
  const actual = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== CODE_FONT_SHA256) {
    throw new DocxFontEmbeddingError(
      `The DOCX code font checksum does not match the committed ${CODE_FONT_FILE} asset.`,
    );
  }
}

function guidBytes(fontKey: string): Uint8Array {
  const compact = fontKey.replace(/[{}-]/gu, "");
  if (!/^[0-9a-f]{32}$/iu.test(compact)) {
    throw new DocxFontEmbeddingError(`Invalid DOCX font obfuscation key: ${fontKey}.`);
  }
  return Uint8Array.from(
    compact.match(/[0-9a-f]{2}/giu)!.map((hex) => Number.parseInt(hex, 16)),
  );
}

/** Apply (or reverse) ECMA-376's symmetric first-32-byte font obfuscation. */
export function obfuscateFont(bytes: Uint8Array, fontKey = CODE_FONT_KEY): Uint8Array {
  assertEmbeddableSfnt(bytes);
  const output = bytes.slice();
  const key = guidBytes(fontKey).reverse();
  for (let index = 0; index < 32; index += 1) {
    output[index] = output[index]! ^ key[index % key.byteLength]!;
  }
  return output;
}

function relationshipsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PACKAGE_REL_NS}"></Relationships>`
  );
}

function removeRelationshipById(xml: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return xml.replace(
    new RegExp(
      `<Relationship\\b(?=[^>]*\\bId=(["'])${escaped}\\1)[^>]*/>`,
      "giu",
    ),
    "",
  );
}

function appendRelationship(
  xml: string,
  relationship: { id: string; type: string; target: string },
): string {
  const clean = removeRelationshipById(xml, relationship.id);
  return clean.replace(
    "</Relationships>",
    `<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${relationship.target}"/></Relationships>`,
  );
}

function ensureContentTypes(zip: PizZip): void {
  const path = "[Content_Types].xml";
  const source = zip.file(path)?.asText();
  if (!source) {
    throw new DocxFontEmbeddingError("The DOCX package has no [Content_Types].xml part.");
  }
  let xml = source;
  if (!/Extension=(["'])odttf\1/iu.test(xml)) {
    xml = xml.replace(
      "</Types>",
      `<Default Extension="odttf" ContentType="${OBFUSCATED_FONT_CONTENT_TYPE}"/></Types>`,
    );
  }
  if (!xml.includes(`PartName="/${FONT_TABLE_PART}"`)) {
    xml = xml.replace(
      "</Types>",
      `<Override PartName="/${FONT_TABLE_PART}" ContentType="${FONT_TABLE_CONTENT_TYPE}"/></Types>`,
    );
  }
  zip.file(path, xml);
}

function codeFontXml(): string {
  return (
    `<w:font w:name="${CODE_FONT_FAMILY}">` +
    `<w:family w:val="modern"/>` +
    `<w:pitch w:val="fixed"/>` +
    `<w:embedRegular r:id="${FONT_REL_ID}" w:fontKey="${CODE_FONT_KEY}"/>` +
    `</w:font>`
  );
}

function ensureFontTable(zip: PizZip): void {
  const source =
    zip.file(FONT_TABLE_PART)?.asText() ??
    (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:fonts xmlns:w="${WORDPROCESSING_NS}" xmlns:r="${OFFICE_REL_NS}"></w:fonts>`
    );
  let xml = source;
  if (!/\bxmlns:r=/u.test(xml)) {
    xml = xml.replace(/<w:fonts\b/u, `<w:fonts xmlns:r="${OFFICE_REL_NS}"`);
  }
  xml = xml
    .replace(
      /<w:font\b(?=[^>]*\bw:name=(["'])JetBrains Mono\1)[^>]*>[\s\S]*?<\/w:font>/giu,
      "",
    )
    .replace(
      /<w:font\b(?=[^>]*\bw:name=(["'])JetBrains Mono\1)[^>]*\/>/giu,
      "",
    )
    .replace("</w:fonts>", `${codeFontXml()}</w:fonts>`);
  if (!xml.includes(codeFontXml())) {
    throw new DocxFontEmbeddingError("The DOCX font table could not be updated.");
  }
  zip.file(FONT_TABLE_PART, xml);
}

function ensureFontRelationships(zip: PizZip): void {
  const fontTableRels = appendRelationship(
    zip.file(FONT_TABLE_RELS_PART)?.asText() ?? relationshipsXml(),
    {
      id: FONT_REL_ID,
      type: FONT_RELATIONSHIP,
      target: `fonts/${FONT_PART_NAME.split("/").at(-1)!}`,
    },
  );
  zip.file(FONT_TABLE_RELS_PART, fontTableRels);

  const documentRels = zip.file(DOCUMENT_RELS_PART)?.asText() ?? relationshipsXml();
  if (!new RegExp(`Type=(["'])${FONT_TABLE_RELATIONSHIP}\\1`, "u").test(documentRels)) {
    zip.file(
      DOCUMENT_RELS_PART,
      appendRelationship(documentRels, {
        id: FONT_TABLE_REL_ID,
        type: FONT_TABLE_RELATIONSHIP,
        target: "fontTable.xml",
      }),
    );
  }
}

/**
 * Add the bundled regular code face to a DOCX package. Re-running this function
 * is idempotent: the owned relationship IDs, font-table entry, and font part are
 * replaced deterministically instead of accumulating duplicates.
 */
export function ensureEmbeddedCodeFont(zip: PizZip, fontBytes: Uint8Array): void {
  // Validate before touching any XML part so a bad or non-embeddable delivery
  // cannot leave a half-mutated archive behind.
  assertEmbeddableSfnt(fontBytes);
  ensureContentTypes(zip);
  ensureFontTable(zip);
  ensureFontRelationships(zip);
  zip.file(FONT_PART_NAME, obfuscateFont(fontBytes));
}

type BundledCodeFontLoader = () => Promise<Uint8Array>;

let hostCodeFontLoader: BundledCodeFontLoader | undefined;
let bundledCodeFontPromise: Promise<Uint8Array> | undefined;
let validatedBundledCodeFontPromise: Promise<Uint8Array> | undefined;

/**
 * Install the package-host loader used by the Node entry point. Kept behind
 * `./internal`; browser consumers use the URL/fetch path below and never pull a
 * Node builtin into their graph.
 */
export function configureBundledCodeFontLoader(loader: BundledCodeFontLoader): void {
  hostCodeFontLoader = loader;
  bundledCodeFontPromise = undefined;
  validatedBundledCodeFontPromise = undefined;
}

/**
 * Load the package's committed code face in Node/Bun or through a browser
 * bundler's `new URL(..., import.meta.url)` asset transform.
 */
export function loadBundledCodeFont(): Promise<Uint8Array> {
  if (bundledCodeFontPromise) return bundledCodeFontPromise;
  const promise = (async () => {
    if (hostCodeFontLoader) return hostCodeFontLoader();
    // Keep this path literal so browser bundlers can discover and copy the asset.
    const url = new URL("../fonts/JetBrainsMono-Regular.ttf", import.meta.url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new DocxFontEmbeddingError(
        `Could not load the bundled DOCX code font (${response.status}).`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  })();
  bundledCodeFontPromise = promise;
  promise.catch(() => {
    // A host may install a replacement loader while an older request is still
    // in flight. Only the promise that still owns the cache may clear it.
    if (bundledCodeFontPromise === promise) bundledCodeFontPromise = undefined;
  });
  return promise;
}

/**
 * Load and validate the exact committed code face through one retryable,
 * concurrent-safe promise shared by explicit preload and renderer demand.
 *
 * A validation rejection clears both the validated promise and the raw-byte
 * promise that supplied it. This lets a transient or replaced host source
 * provide fresh bytes on retry instead of retaining a rejected validation or
 * repeatedly hashing the same invalid delivery.
 */
export function loadValidatedBundledCodeFont(): Promise<Uint8Array> {
  if (validatedBundledCodeFontPromise) return validatedBundledCodeFontPromise;
  const loading = loadBundledCodeFont();
  const promise = (async () => {
    const bytes = await loading;
    await assertBundledCodeFont(bytes);
    return bytes;
  })();
  validatedBundledCodeFontPromise = promise;
  promise.catch(() => {
    if (validatedBundledCodeFontPromise === promise) {
      validatedBundledCodeFontPromise = undefined;
    }
    if (bundledCodeFontPromise === loading) bundledCodeFontPromise = undefined;
  });
  return promise;
}
