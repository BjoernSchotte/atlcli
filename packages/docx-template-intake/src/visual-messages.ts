import type {
  TemplateMessageDefinitionV1,
  TemplateMessageRegistryV1,
} from "@atlcli/pdf-template-authoring";

const stable = {
  type: "string" as const,
  maxLength: 64,
  format: "stable-id" as const,
};

export const DOCX_VISUAL_MESSAGE_REGISTRY_V1: TemplateMessageRegistryV1 = {
  schema: "wiki.pdf-template-message-registry/v1",
  id: "atlcli.docx-template-visuals",
  version: 1,
  definitions: [
    {
      code: "DOCX_CONCEPT_VISUAL_ASSET",
      params: {},
    },
    ...[
      "DOCX_VISUAL_ASSET_CORRUPT",
      "DOCX_VISUAL_ASSET_LIMIT",
      "DOCX_VISUAL_EXTERNAL_IMAGE",
      "DOCX_VISUAL_SVG_UNSAFE",
      "DOCX_VISUAL_UNSUPPORTED",
    ].map(
      (code): TemplateMessageDefinitionV1 => ({
        code,
        params: { reason: stable },
      })
    ),
    {
      code: "DOCX_VISUAL_ROLE_REPEATED_HEADER",
      params: { occurrences: { type: "number" } },
    },
    {
      code: "DOCX_VISUAL_ROLE_PAGE_FILL",
      params: { coverage: { type: "number" } },
    },
    {
      code: "DOCX_VISUAL_ROLE_FIRST_ONLY",
      params: { section: { type: "number" } },
    },
    {
      code: "DOCX_VISUAL_ROLE_WATERMARK",
      params: {
        rotation: { type: "number" },
        opacity: { type: "number" },
      },
    },
  ],
};
