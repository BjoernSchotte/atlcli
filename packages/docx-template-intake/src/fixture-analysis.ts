import { createHash } from "node:crypto";
import { unzipDocx } from "@atlcli/docx/scan";
import { SaxesParser, type SaxesTagNS } from "./vendor/saxes-runtime.js";

export const FIXTURE_ANALYSIS_SCHEMA = "atlcli.docx-template-fixture-analysis/1" as const;

export interface XmlPartMetricsV1 {
  path: string;
  bytes: number;
  characters: number;
  elements: number;
  maxDepth: number;
  attributes: number;
  maxAttributeCharacters: number;
}

export interface RasterMetricsV1 {
  path: string;
  format: "jpeg" | "png";
  bytes: number;
  width: number;
  height: number;
  pixels: number;
}

export interface SvgMetricsV1 {
  path: string;
  bytes: number;
  characters: number;
  elements: number;
  maxDepth: number;
  attributes: number;
  maxAttributeCharacters: number;
  pathDataBytes: number;
  filters: number;
}

export interface FixtureAnalysisV1 {
  schema: typeof FIXTURE_ANALYSIS_SCHEMA;
  fixture: string;
  sha256: string;
  archive: {
    compressedBytes: number;
    entries: number;
    uncompressedBytes: number;
    largestEntryBytes: number;
  };
  xml: {
    bytes: number;
    characters: number;
    elements: number;
    maxDepth: number;
    attributes: number;
    maxAttributeCharacters: number;
    parts: XmlPartMetricsV1[];
  };
  raster: RasterMetricsV1[];
  svg: SvgMetricsV1[];
  features: {
    alternateContentGroups: number;
    backgrounds: number;
    externalRelationships: number;
    footers: number;
    headers: number;
    internalRelationships: number;
    pageBorders: number;
    sections: number;
    styles: number;
    themeColorSlots: number;
  };
}

interface XmlScan {
  metrics: Omit<XmlPartMetricsV1, "path" | "bytes" | "characters">;
  localNames: Map<string, number>;
  externalRelationships: number;
  internalRelationships: number;
  svgPathDataBytes: number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function scanXml(xml: string): XmlScan {
  let depth = 0;
  let maxDepth = 0;
  let elements = 0;
  let attributes = 0;
  let maxAttributeCharacters = 0;
  let externalRelationships = 0;
  let internalRelationships = 0;
  let svgPathDataBytes = 0;
  const localNames = new Map<string, number>();
  const parser = new SaxesParser({ xmlns: true });

  parser.on("doctype", () => {
    throw new Error("DOCTYPE is forbidden in a DOCX fixture XML part");
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    depth += 1;
    maxDepth = Math.max(maxDepth, depth);
    elements += 1;
    localNames.set(tag.local, (localNames.get(tag.local) ?? 0) + 1);

    const values = Object.values(tag.attributes);
    attributes += values.length;
    for (const attribute of values) {
      maxAttributeCharacters = Math.max(maxAttributeCharacters, attribute.value.length);
      if (tag.local === "Relationship" && attribute.local === "TargetMode") {
        if (attribute.value === "External") externalRelationships += 1;
      }
      if (tag.local === "path" && attribute.local === "d") {
        svgPathDataBytes += byteLength(attribute.value);
      }
    }
    if (tag.local === "Relationship" && !values.some((value) => value.local === "TargetMode")) {
      internalRelationships += 1;
    }
  });
  parser.on("closetag", () => {
    depth -= 1;
  });
  parser.on("error", (error) => {
    throw error;
  });
  parser.write(xml).close();

  return {
    metrics: {
      elements,
      maxDepth,
      attributes,
      maxAttributeCharacters,
    },
    localNames,
    externalRelationships,
    internalRelationships,
    svgPathDataBytes,
  };
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error("Invalid PNG fixture asset");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid JPEG fixture asset");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += length;
  }
  throw new Error("JPEG fixture asset has no supported frame header");
}

function addNameCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [name, count] of source) {
    target.set(name, (target.get(name) ?? 0) + count);
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function analyzeFixture(fixture: string, bytes: Uint8Array): FixtureAnalysisV1 {
  const zip = unzipDocx(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => left.name.localeCompare(right.name));

  const parts: XmlPartMetricsV1[] = [];
  const raster: RasterMetricsV1[] = [];
  const svg: SvgMetricsV1[] = [];
  const localNames = new Map<string, number>();
  let uncompressedBytes = 0;
  let largestEntryBytes = 0;
  let externalRelationships = 0;
  let internalRelationships = 0;

  for (const entry of entries) {
    const partBytes = entry.asUint8Array();
    uncompressedBytes += partBytes.byteLength;
    largestEntryBytes = Math.max(largestEntryBytes, partBytes.byteLength);
    const lower = entry.name.toLowerCase();

    if (lower.endsWith(".xml") || lower.endsWith(".rels")) {
      const xml = decoder.decode(partBytes);
      const scan = scanXml(xml);
      parts.push({
        path: entry.name,
        bytes: partBytes.byteLength,
        characters: xml.length,
        ...scan.metrics,
      });
      addNameCounts(localNames, scan.localNames);
      externalRelationships += scan.externalRelationships;
      internalRelationships += scan.internalRelationships;
      continue;
    }

    if (lower.endsWith(".png")) {
      const dimensions = pngDimensions(partBytes);
      raster.push({
        path: entry.name,
        format: "png",
        bytes: partBytes.byteLength,
        ...dimensions,
        pixels: dimensions.width * dimensions.height,
      });
      continue;
    }

    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      const dimensions = jpegDimensions(partBytes);
      raster.push({
        path: entry.name,
        format: "jpeg",
        bytes: partBytes.byteLength,
        ...dimensions,
        pixels: dimensions.width * dimensions.height,
      });
      continue;
    }

    if (lower.endsWith(".svg")) {
      const xml = decoder.decode(partBytes);
      const scan = scanXml(xml);
      svg.push({
        path: entry.name,
        bytes: partBytes.byteLength,
        characters: xml.length,
        ...scan.metrics,
        pathDataBytes: scan.svgPathDataBytes,
        filters: scan.localNames.get("filter") ?? 0,
      });
    }
  }

  const xmlTotals = parts.reduce(
    (total, part) => ({
      bytes: total.bytes + part.bytes,
      characters: total.characters + part.characters,
      elements: total.elements + part.elements,
      maxDepth: Math.max(total.maxDepth, part.maxDepth),
      attributes: total.attributes + part.attributes,
      maxAttributeCharacters: Math.max(
        total.maxAttributeCharacters,
        part.maxAttributeCharacters
      ),
    }),
    {
      bytes: 0,
      characters: 0,
      elements: 0,
      maxDepth: 0,
      attributes: 0,
      maxAttributeCharacters: 0,
    }
  );

  return {
    schema: FIXTURE_ANALYSIS_SCHEMA,
    fixture,
    sha256: sha256Hex(bytes),
    archive: {
      compressedBytes: bytes.byteLength,
      entries: entries.length,
      uncompressedBytes,
      largestEntryBytes,
    },
    xml: { ...xmlTotals, parts },
    raster,
    svg,
    features: {
      alternateContentGroups: localNames.get("AlternateContent") ?? 0,
      backgrounds: localNames.get("background") ?? 0,
      externalRelationships,
      footers: entries.filter((entry) => /^word\/footer\d+\.xml$/i.test(entry.name)).length,
      headers: entries.filter((entry) => /^word\/header\d+\.xml$/i.test(entry.name)).length,
      internalRelationships,
      pageBorders: localNames.get("pgBorders") ?? 0,
      sections: localNames.get("sectPr") ?? 0,
      styles: localNames.get("style") ?? 0,
      themeColorSlots:
        (localNames.get("dk1") ?? 0) +
        (localNames.get("lt1") ?? 0) +
        (localNames.get("dk2") ?? 0) +
        (localNames.get("lt2") ?? 0) +
        (localNames.get("accent1") ?? 0) +
        (localNames.get("accent2") ?? 0) +
        (localNames.get("accent3") ?? 0) +
        (localNames.get("accent4") ?? 0) +
        (localNames.get("accent5") ?? 0) +
        (localNames.get("accent6") ?? 0) +
        (localNames.get("hlink") ?? 0) +
        (localNames.get("folHlink") ?? 0),
    },
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}
