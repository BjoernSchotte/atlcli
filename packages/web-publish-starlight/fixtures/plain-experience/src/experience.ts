import {
  PUBLICATION_EXPERIENCE_SCHEMA_V1,
  type PublicationExperienceDescriptorV1,
} from "@atlcli/web-publish";

/**
 * Deliberately small, non-shipped conformance experience. It proves that the
 * publication contract does not make Starlight the owner of document bodies.
 */
export const PLAIN_PUBLISHING_EXPERIENCE_FIXTURE_V1 = {
  schema: PUBLICATION_EXPERIENCE_SCHEMA_V1,
  id: "fixture.plain-astro",
  version: "1.0.0",
  engine: "astro",
  capabilities: [],
  slots: ["main-content"],
  designTokensSchema: "fixture.plain-astro.tokens/1",
  components: {
    slots: { "main-content": "ExportDocument" },
    overrides: {},
    blockOverrides: {},
  },
} as const satisfies PublicationExperienceDescriptorV1;
