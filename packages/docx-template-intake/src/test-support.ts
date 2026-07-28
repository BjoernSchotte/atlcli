import PizZip from "pizzip";

export const W_TRANSITIONAL =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const W_STRICT =
  "http://purl.oclc.org/ooxml/wordprocessingml/main";
export const R_TRANSITIONAL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const R_STRICT =
  "http://purl.oclc.org/ooxml/officeDocument/relationships";
export const A_TRANSITIONAL =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
export const A_STRICT =
  "http://purl.oclc.org/ooxml/drawingml/main";
export const WP_TRANSITIONAL =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const MC =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";

export function documentXml(
  body = "",
  options: {
    wordPrefix?: string;
    wordUri?: string;
    relationshipPrefix?: string;
    relationshipUri?: string;
    extraNamespaces?: string;
  } = {}
): string {
  const wordPrefix = options.wordPrefix ?? "w";
  const wordUri = options.wordUri ?? W_TRANSITIONAL;
  const relationshipPrefix = options.relationshipPrefix ?? "r";
  const relationshipUri = options.relationshipUri ?? R_TRANSITIONAL;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<${wordPrefix}:document xmlns:${wordPrefix}="${wordUri}"`,
    ` xmlns:${relationshipPrefix}="${relationshipUri}"`,
    options.extraNamespaces ?? "",
    `><${wordPrefix}:body>${body}</${wordPrefix}:body></${wordPrefix}:document>`,
  ].join("");
}

export function relationshipsXml(
  relationships: readonly {
    id: string;
    type: string;
    target: string;
    targetMode?: "External";
  }[]
): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
    ...relationships.map(
      ({ id, type, target, targetMode }) =>
        `<Relationship Id="${id}" Type="${type}" Target="${target}"${
          targetMode ? ` TargetMode="${targetMode}"` : ""
        }/>`
    ),
    `</Relationships>`,
  ].join("");
}

export function buildDocx(
  entries: Readonly<Record<string, string | Uint8Array>>,
  order: "forward" | "reverse" = "forward"
): Uint8Array {
  const zip = new PizZip();
  const complete: Record<string, string | Uint8Array> = {
    "word/document.xml": documentXml(),
    ...entries,
  };
  const names = Object.keys(complete).sort();
  if (order === "reverse") names.reverse();
  for (const name of names) zip.file(name, complete[name] as string | Uint8Array);
  return zip.generate({
    type: "uint8array",
    compression: "DEFLATE",
  }) as unknown as Uint8Array;
}

export function officeRelationshipType(suffix: string): string {
  return `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${suffix}`;
}
