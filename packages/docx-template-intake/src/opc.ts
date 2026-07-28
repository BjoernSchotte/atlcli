import { sha256Hex } from "@atlcli/core";
import {
  DOCX_TEMPLATE_INTAKE_BUDGET,
  unzipDocx,
} from "@atlcli/docx/scan";
import {
  validateTemplateDiagnostic,
  validateTemplateImportProgressEvent,
  type TemplateDiagnosticV1,
  type TemplateMessageDefinitionV1,
  type TemplateMessageRegistryV1,
  type TemplateImportProgressEventV1,
} from "@atlcli/pdf-template-authoring";
import { canonicalIntakeJson } from "./canonical.js";
import { streamXmlPart } from "./streaming.js";

export const DOCX_OPC_FACTS_SCHEMA_V1 = "atlcli.docx-opc-facts/1" as const;

export const DOCX_INTAKE_MESSAGE_REGISTRY_V1: TemplateMessageRegistryV1 = {
  schema: "wiki.pdf-template-message-registry/v1",
  id: "atlcli.docx-template-intake",
  version: 1,
  definitions: [
    ...[
      "DOCX_INTAKE_DUPLICATE_RELATIONSHIP",
      "DOCX_INTAKE_MISSING_PART",
      "DOCX_INTAKE_RELATIONSHIP_TRAVERSAL",
    ].map(
      (code): TemplateMessageDefinitionV1 => ({
        code,
        params: {
          relationship: {
            type: "string",
            maxLength: 96,
            format: "stable-id",
          },
        },
      })
    ),
    {
      code: "DOCX_INTAKE_EXTERNAL_RELATIONSHIP",
      params: {
        scheme: {
          type: "string",
          maxLength: 16,
          format: "stable-id",
        },
      },
    },
    {
      code: "DOCX_INTAKE_UNSUPPORTED_BINARY",
      params: {
        kind: {
          type: "string",
          maxLength: 48,
          format: "stable-id",
        },
        declaredBytes: { type: "number" },
      },
    },
    {
      code: "DOCX_INTAKE_UNKNOWN_RELATIONSHIP",
      params: {
        kind: {
          type: "string",
          maxLength: 48,
          format: "stable-id",
        },
      },
    },
  ],
};

export type OpcRelationshipKindV1 =
  | "document"
  | "font-table"
  | "footer"
  | "header"
  | "image"
  | "numbering"
  | "settings"
  | "styles"
  | "theme"
  | "drawing"
  | "endnotes"
  | "footnotes"
  | "unsupported-binary"
  | "unknown";

export interface OpcPartFactV1 {
  partRef: string;
  declaredBytes: number;
  kind: "binary" | "relationship" | "xml";
}

export interface OpcRelationshipFactV1 {
  sourcePartRef: string;
  relationshipRef: string;
  relationshipFingerprint: string;
  kind: OpcRelationshipKindV1;
  target:
    | { kind: "external-unresolved"; scheme: string; fingerprint: string }
    | { kind: "internal"; partRef: string; exists: boolean }
    | { kind: "invalid" };
}

export interface DocxOpcFactsV1 {
  schema: typeof DOCX_OPC_FACTS_SCHEMA_V1;
  parts: readonly OpcPartFactV1[];
  relationships: readonly OpcRelationshipFactV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
}

interface ZipEntry {
  name: string;
  dir: boolean;
  asUint8Array(): Uint8Array;
  _data?: { uncompressedSize?: number };
}

interface RawRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function diagnostic(
  code: string,
  params: Readonly<Record<string, string | number | boolean>>,
  severity: TemplateDiagnosticV1["severity"]
): TemplateDiagnosticV1 {
  const item: TemplateDiagnosticV1 = {
    code,
    params,
    severity,
    recoveryActions:
      severity === "error" ? ["reanalyze"] : ["acknowledge-inventory"],
  };
  validateTemplateDiagnostic(item, [DOCX_INTAKE_MESSAGE_REGISTRY_V1]);
  return item;
}

function sourceForRelationshipPart(part: string): string | undefined {
  if (part === "_rels/.rels") return "";
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(part);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function normalizeInternalTarget(
  sourcePart: string,
  target: string
): string | undefined {
  if (
    target.length === 0 ||
    target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("\0")
  ) {
    return undefined;
  }
  const base = sourcePart.includes("/")
    ? sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1)
    : "";
  const stack: string[] = [];
  for (const segment of `${base}${target}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.join("/");
}

function relationshipKind(type: string): OpcRelationshipKindV1 {
  const suffix = type.slice(type.lastIndexOf("/") + 1).toLowerCase();
  if (suffix === "officedocument") return "document";
  if (suffix === "styles") return "styles";
  if (suffix === "theme") return "theme";
  if (suffix === "settings") return "settings";
  if (suffix === "numbering") return "numbering";
  if (suffix === "fonttable") return "font-table";
  if (suffix === "header") return "header";
  if (suffix === "footer") return "footer";
  if (suffix === "footnotes") return "footnotes";
  if (suffix === "endnotes") return "endnotes";
  if (suffix === "image") return "image";
  if (
    ["chart", "diagramdata", "diagramlayout", "diagramcolors", "diagramquickstyle"].includes(
      suffix
    )
  ) {
    return "drawing";
  }
  if (
    [
      "audio",
      "embeddedpackage",
      "externaldata",
      "oleobject",
      "package",
      "video",
    ].includes(suffix)
  ) {
    return "unsupported-binary";
  }
  return "unknown";
}

function unsupportedBinaryClass(type: string): string {
  const suffix = type.slice(type.lastIndexOf("/") + 1).toLowerCase();
  if (suffix === "oleobject") return "ole";
  if (suffix === "embeddedpackage" || suffix === "package") {
    return "embedded-package";
  }
  if (suffix === "externaldata") return "external-data";
  if (suffix === "audio") return "audio";
  if (suffix === "video") return "video";
  return "unknown-binary";
}

function schemeClass(target: string): string {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    return scheme;
  }
  if (scheme === "file") return "file";
  return scheme ? "other" : "relative";
}

async function fingerprint(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

function parseRelationships(partRef: string, bytes: Uint8Array): RawRelationship[] {
  const relationships: RawRelationship[] = [];
  streamXmlPart(partRef, bytes, {
    open(event) {
      if (event.local !== "Relationship") return;
      const attr = (name: string): string =>
        event.attributes.find(({ local }) => local === name)?.value ?? "";
      relationships.push({
        id: attr("Id"),
        type: attr("Type"),
        target: attr("Target"),
        external: attr("TargetMode").toLowerCase() === "external",
      });
    },
  });
  return relationships;
}

function emitProgress(
  callback: ((event: TemplateImportProgressEventV1) => void) | undefined,
  completed: number,
  total: number
): void {
  const event: TemplateImportProgressEventV1 = {
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "docx.intake",
    phase: "scanning",
    completed,
    total,
  };
  validateTemplateImportProgressEvent(event);
  callback?.(event);
}

/**
 * Build a portable OPC graph without filesystem or network access. Binary
 * relationship targets are classified from metadata and never inflated.
 */
export async function analyzeDocxOpc(
  bytes: Uint8Array,
  options: {
    progress?: (event: TemplateImportProgressEventV1) => void;
  } = {}
): Promise<DocxOpcFactsV1> {
  const zip = unzipDocx(bytes, DOCX_TEMPLATE_INTAKE_BUDGET);
  return analyzeDocxOpcArchive(zip, options);
}

/** @internal Analyze an archive that already passed the shared DOCX preflight. */
export async function analyzeDocxOpcArchive(
  zip: ReturnType<typeof unzipDocx>,
  options: {
    progress?: (event: TemplateImportProgressEventV1) => void;
  } = {}
): Promise<DocxOpcFactsV1> {
  const entries = (Object.values(zip.files) as unknown as ZipEntry[])
    .filter(({ dir }) => !dir)
    .sort((left, right) => left.name.localeCompare(right.name));
  const partNames = new Set(entries.map(({ name }) => name));
  const parts: OpcPartFactV1[] = entries.map((entry) => ({
    partRef: entry.name,
    declaredBytes: entry._data?.uncompressedSize ?? 0,
    kind: /\.rels$/i.test(entry.name)
      ? "relationship"
      : /\.xml$/i.test(entry.name)
        ? "xml"
        : "binary",
  }));
  const diagnostics: TemplateDiagnosticV1[] = [];
  const relationships: OpcRelationshipFactV1[] = [];
  emitProgress(options.progress, 0, entries.length);
  let completed = 0;
  for (const entry of entries) {
    completed += 1;
    if (!/\.rels$/i.test(entry.name)) {
      emitProgress(options.progress, completed, entries.length);
      continue;
    }
    const sourcePartRef = sourceForRelationshipPart(entry.name);
    if (sourcePartRef === undefined) {
      emitProgress(options.progress, completed, entries.length);
      continue;
    }
    const raw = parseRelationships(entry.name, entry.asUint8Array());
    const ids = new Set<string>();
    for (const item of raw) {
      const relationshipFingerprint = await fingerprint(
        `${sourcePartRef}\0${item.id}\0${item.type}\0${item.target}`
      );
      const relationshipRef = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(item.id)
        ? item.id
        : `rel.${relationshipFingerprint.slice(0, 24)}`;
      let kind = relationshipKind(item.type);
      if (ids.has(item.id)) {
        diagnostics.push(
          diagnostic(
            "DOCX_INTAKE_DUPLICATE_RELATIONSHIP",
            { relationship: `rel.${relationshipFingerprint.slice(0, 24)}` },
            "error"
          )
        );
      }
      ids.add(item.id);
      let target: OpcRelationshipFactV1["target"];
      let binaryClass: string | undefined =
        kind === "unsupported-binary"
          ? unsupportedBinaryClass(item.type)
          : undefined;
      if (item.external) {
        const scheme = schemeClass(item.target);
        target = {
          kind: "external-unresolved",
          scheme,
          fingerprint: await fingerprint(item.target),
        };
        diagnostics.push(
          diagnostic(
            "DOCX_INTAKE_EXTERNAL_RELATIONSHIP",
            { scheme },
            "warning"
          )
        );
      } else {
        const normalized = normalizeInternalTarget(sourcePartRef, item.target);
        if (!normalized) {
          target = { kind: "invalid" };
          diagnostics.push(
            diagnostic(
              "DOCX_INTAKE_RELATIONSHIP_TRAVERSAL",
              { relationship: `rel.${relationshipFingerprint.slice(0, 24)}` },
              "error"
            )
          );
        } else {
          const exists = partNames.has(normalized);
          target = { kind: "internal", partRef: normalized, exists };
          if (!exists) {
            diagnostics.push(
              diagnostic(
                "DOCX_INTAKE_MISSING_PART",
                { relationship: `rel.${relationshipFingerprint.slice(0, 24)}` },
                "error"
              )
            );
          }
          const targetPart = parts.find(({ partRef }) => partRef === normalized);
          if (
            kind === "unknown" &&
            targetPart?.kind === "binary"
          ) {
            kind = "unsupported-binary";
            binaryClass = "unknown-binary";
          }
        }
      }
      if (kind === "unsupported-binary") {
        const declaredBytes =
          target.kind === "internal"
            ? (parts.find(({ partRef }) => partRef === target.partRef)
                ?.declaredBytes ?? 0)
            : 0;
        diagnostics.push(
          diagnostic(
            "DOCX_INTAKE_UNSUPPORTED_BINARY",
            {
              kind: binaryClass ?? "unknown-binary",
              declaredBytes,
            },
            "warning"
          )
        );
      } else if (kind === "unknown") {
        diagnostics.push(
          diagnostic(
            "DOCX_INTAKE_UNKNOWN_RELATIONSHIP",
            { kind },
            "warning"
          )
        );
      }
      relationships.push({
        sourcePartRef,
        relationshipRef,
        relationshipFingerprint,
        kind,
        target,
      });
    }
    emitProgress(options.progress, completed, entries.length);
  }
  relationships.sort((left, right) =>
    left.relationshipFingerprint.localeCompare(right.relationshipFingerprint)
  );
  diagnostics.sort((left, right) =>
    `${left.code}:${JSON.stringify(left.params)}`.localeCompare(
      `${right.code}:${JSON.stringify(right.params)}`
    )
  );
  return {
    schema: DOCX_OPC_FACTS_SCHEMA_V1,
    parts,
    relationships,
    diagnostics,
  };
}

export function canonicalDocxOpcFactsJson(facts: DocxOpcFactsV1): string {
  return canonicalIntakeJson(facts);
}
