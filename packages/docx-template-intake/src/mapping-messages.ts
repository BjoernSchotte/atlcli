import {
  validateTemplateDiagnostic,
  validateTemplateExplanation,
  type TemplateDiagnosticV1,
  type TemplateExplanationV1,
  type TemplateMessageDefinitionV1,
  type TemplateMessageRegistryV1,
} from "@atlcli/pdf-template-authoring";

const stable = {
  type: "string" as const,
  maxLength: 192,
  format: "stable-id" as const,
};
const fingerprint = {
  type: "string" as const,
  maxLength: 64,
  format: "fingerprint" as const,
};
const number = { type: "number" as const };

const definition = (
  code: string,
  params: TemplateMessageDefinitionV1["params"]
): TemplateMessageDefinitionV1 => ({ code, params });

/** Stable message ownership for DOCX-to-PDF mapping and resolution. */
export const DOCX_MAPPING_MESSAGE_REGISTRY_V1: TemplateMessageRegistryV1 = {
  schema: "wiki.pdf-template-message-registry/v1",
  id: "atlcli.docx-template-mapping",
  version: 1,
  definitions: [
    ...[
      "DOCX_CONCEPT_BODY",
      "DOCX_CONCEPT_CODE",
      "DOCX_CONCEPT_COLOR",
      "DOCX_CONCEPT_FOOTER",
      "DOCX_CONCEPT_HEADER",
      "DOCX_CONCEPT_HEADING_1",
      "DOCX_CONCEPT_HEADING_2",
      "DOCX_CONCEPT_HEADING_3",
      "DOCX_CONCEPT_PAGE",
      "DOCX_CONCEPT_TABLE",
    ].map((code) => definition(code, {})),
    definition("DOCX_MAPPING_CAPABILITY_ABSENT", { target: stable }),
    definition("DOCX_MAPPING_DIRECT_FORMAT_DOMINANCE", {
      count: number,
      ratio: number,
      role: stable,
    }),
    definition("DOCX_MAPPING_FONT_BUNDLED", { role: stable }),
    definition("DOCX_MAPPING_FONT_SUBSTITUTION_REQUIRED", {
      font: fingerprint,
      role: stable,
    }),
    definition("DOCX_MAPPING_OUTLINE_LEVEL", {
      level: number,
      role: stable,
    }),
    definition("DOCX_MAPPING_PAGE_FORMAT", { format: stable }),
    definition("DOCX_MAPPING_REPEATED_USAGE", {
      count: number,
      role: stable,
    }),
    definition("DOCX_MAPPING_SECTION_UNIFORM", { count: number }),
    definition("DOCX_MAPPING_STANDARD_STYLE", {
      role: stable,
      style: stable,
    }),
    definition("DOCX_MAPPING_TABLE_CONDITIONAL", {
      regions: number,
      role: stable,
    }),
    definition("DOCX_MAPPING_THEME_COLOR", { slot: stable }),
    definition("DOCX_MAPPING_THEME_FONT", {
      role: stable,
      script: stable,
    }),
    definition("DOCX_PAGE_CUSTOM_SIZE", {
      heightTwips: number,
      widthTwips: number,
    }),
    definition("DOCX_SECTION_SCOPE_UNSUPPORTED", {
      section: number,
      variant: stable,
    }),
    definition("DOCX_STYLE_CYCLE", { style: fingerprint }),
    definition("DOCX_STYLE_INVALID_PROPERTY", {
      property: stable,
      style: fingerprint,
    }),
    definition("DOCX_STYLE_MISSING_PARENT", {
      parent: fingerprint,
      style: fingerprint,
    }),
  ],
};

export function mappingDiagnostic(
  code: string,
  params: Readonly<Record<string, string | number | boolean>>,
  severity: TemplateDiagnosticV1["severity"],
  recoveryActions: TemplateDiagnosticV1["recoveryActions"] = [
    "acknowledge-inventory",
  ]
): TemplateDiagnosticV1 {
  const diagnostic: TemplateDiagnosticV1 = {
    code,
    params,
    severity,
    recoveryActions,
  };
  validateTemplateDiagnostic(diagnostic, [DOCX_MAPPING_MESSAGE_REGISTRY_V1]);
  return diagnostic;
}

export function mappingExplanation(
  code: string,
  params: Readonly<Record<string, string | number | boolean>>,
  evidenceRefs: readonly string[]
): TemplateExplanationV1 {
  const explanation: TemplateExplanationV1 = {
    code,
    params,
    evidenceRefs,
  };
  validateTemplateExplanation(explanation, [DOCX_MAPPING_MESSAGE_REGISTRY_V1]);
  return explanation;
}
