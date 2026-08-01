/** Stable identity for the supported first publishing experience. */
export const STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1 = "atlcli.starlight/1";

export interface StarlightPublishingExperienceDescriptorV1 {
  id: typeof STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1;
  version: "1";
  owner: "astro-project";
  bodies: "@atlcli/export-blocks-astro";
  rendering: "astro-static";
  starlight: "^0.41.3";
}

/** Stable semantic regions, intentionally independent from Starlight DOM selectors. */
export const STARLIGHT_PUBLISHING_SEMANTIC_SLOTS_V1 = [
  "site-header", "primary-navigation", "breadcrumb", "page-actions", "page-toc",
  "document-body", "related-pages", "previous-next", "search-trigger", "footer",
  "landing-hero", "not-found", "analytics", "edit-link",
] as const;

export type StarlightPublishingSemanticSlotV1 = (typeof STARLIGHT_PUBLISHING_SEMANTIC_SLOTS_V1)[number];

export interface StarlightPublishingExperienceRuntimeV1 {
  schema: "atlcli.web-publish-starlight-runtime/1";
  descriptor: StarlightPublishingExperienceDescriptorV1;
  slots: readonly StarlightPublishingSemanticSlotV1[];
  tokens: readonly string[];
  features: Readonly<{
    navigation: true;
    search: true;
    toc: true;
    colorModes: true;
    print: true;
  }>;
}

export class StarlightPublishingExperienceErrorV1 extends Error {}

const RENDER_KIT_TOKEN_NAMES_V1 = [
  "--atlcli-content-foreground", "--atlcli-content-muted", "--atlcli-content-border",
  "--atlcli-content-surface", "--atlcli-content-code-background",
] as const;

/**
 * This descriptor is intentionally presentation-only. Acquisition, routes,
 * cache ownership, build execution, and ExportBlock dispatch remain elsewhere.
 */
export const STARLIGHT_PUBLISHING_EXPERIENCE_V1: Readonly<StarlightPublishingExperienceDescriptorV1> = Object.freeze({
  id: STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1,
  version: "1",
  owner: "astro-project",
  bodies: "@atlcli/export-blocks-astro",
  rendering: "astro-static",
  starlight: "^0.41.3",
});

/** Create the immutable, presentation-only runtime contract for a trusted project. */
export function createStarlightPublishingExperienceRuntimeV1(input?: {
  slots?: readonly StarlightPublishingSemanticSlotV1[];
}): Readonly<StarlightPublishingExperienceRuntimeV1> {
  const slots = input?.slots ?? STARLIGHT_PUBLISHING_SEMANTIC_SLOTS_V1;
  const unique = new Set<string>();
  for (const slot of slots) {
    if (!(STARLIGHT_PUBLISHING_SEMANTIC_SLOTS_V1 as readonly string[]).includes(slot)) {
      throw new StarlightPublishingExperienceErrorV1(`unsupported semantic slot: ${slot}`);
    }
    if (unique.has(slot)) throw new StarlightPublishingExperienceErrorV1(`duplicate semantic slot: ${slot}`);
    unique.add(slot);
  }
  if (!unique.has("document-body")) throw new StarlightPublishingExperienceErrorV1("document-body slot is required");
  return Object.freeze({
    schema: "atlcli.web-publish-starlight-runtime/1",
    descriptor: STARLIGHT_PUBLISHING_EXPERIENCE_V1,
    slots: Object.freeze([...slots]),
    tokens: Object.freeze([...RENDER_KIT_TOKEN_NAMES_V1]),
    features: Object.freeze({ navigation: true, search: true, toc: true, colorModes: true, print: true }),
  });
}
