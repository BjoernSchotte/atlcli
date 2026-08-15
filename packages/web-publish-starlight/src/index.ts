import {
  PUBLICATION_EXPERIENCE_SCHEMA_V1,
  type PublicationExperienceDescriptorV1,
  type PublicationExperienceSlotV1,
} from "@atlcli/web-publish";

/** Stable identity for the supported first publishing experience. */
export const STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1 = "atlcli.starlight";

export {
  createStarlightPublicationNavigationV1,
  starlightPublicationLabelLandingV1,
  starlightPublicationHrefV1,
  starlightPublicationPageNavigationV1,
  StarlightPublicationNavigationErrorV1,
  type CreateStarlightPublicationNavigationOptionsV1,
  type StarlightPublicationLinkV1,
  type StarlightPublicationLabelLandingV1,
  type StarlightPublicationNavigationModelV1,
  type StarlightPublicationPageNavigationV1,
  type StarlightPublicationRelatedLinkV1,
  type StarlightPublicationSidebarEntryV1,
} from "./navigation.js";
export type StarlightPublishingExperienceDescriptorV1 = PublicationExperienceDescriptorV1;

/** Stable semantic regions, intentionally independent from Starlight DOM selectors. */
export const STARLIGHT_PUBLISHING_SEMANTIC_SLOTS_V1 = [
  "document-head", "header", "primary-navigation", "left-navigation", "breadcrumbs",
  "search-trigger", "search-modal", "main-content", "page-toc", "previous-next",
  "footer", "renderer-styles",
] as const satisfies readonly PublicationExperienceSlotV1[];

export type StarlightPublishingSemanticSlotV1 = (typeof STARLIGHT_PUBLISHING_SEMANTIC_SLOTS_V1)[number];

export interface StarlightPublishingExperienceRuntimeV1 {
  schema: "atlcli.web-publish-starlight-runtime/1";
  descriptor: PublicationExperienceDescriptorV1;
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
const STARLIGHT_PUBLISHING_EXPERIENCE_DESCRIPTOR_V1 = {
  schema: PUBLICATION_EXPERIENCE_SCHEMA_V1,
  id: STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1,
  version: "1.0.0",
  engine: "astro",
  capabilities: [
    "responsive-navigation", "light-dark-system", "search-modal", "search-page",
    "faceted-search", "table-of-contents", "breadcrumbs", "previous-next",
    "chart-islands", "i18n", "print-styles", "seo", "analytics-slot", "edit-link",
  ],
  slots: [...STARLIGHT_PUBLISHING_SEMANTIC_SLOTS_V1],
  designTokensSchema: "atlcli.starlight.tokens/1",
  components: {
    slots: {
      "document-head": "Head", header: "Header", "primary-navigation": "Header",
      "left-navigation": "Sidebar", breadcrumbs: "Breadcrumbs", "search-trigger": "Search",
      "search-modal": "Search", "main-content": "StarlightDocumentBody", "page-toc": "PageSidebar",
      "previous-next": "Pagination", footer: "Footer", "renderer-styles": "StarlightDocumentBody",
    },
    overrides: {
      "page-shell": "PageFrame", navigation: "Sidebar", breadcrumbs: "Breadcrumbs", search: "Search",
      "page-toc": "PageSidebar", "previous-next": "Pagination", footer: "Footer",
      "edit-link": "EditLink", analytics: "Head",
    },
    blockOverrides: { codeBlock: "StarlightCodeBlock", chart: "InteractiveChart" },
  },
} satisfies PublicationExperienceDescriptorV1;

export const STARLIGHT_PUBLISHING_EXPERIENCE_V1: Readonly<PublicationExperienceDescriptorV1> = Object.freeze(
  STARLIGHT_PUBLISHING_EXPERIENCE_DESCRIPTOR_V1,
);

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
  if (!unique.has("main-content")) throw new StarlightPublishingExperienceErrorV1("main-content slot is required");
  return Object.freeze({
    schema: "atlcli.web-publish-starlight-runtime/1",
    descriptor: STARLIGHT_PUBLISHING_EXPERIENCE_V1,
    slots: Object.freeze([...slots]),
    tokens: Object.freeze([...RENDER_KIT_TOKEN_NAMES_V1]),
    features: Object.freeze({ navigation: true, search: true, toc: true, colorModes: true, print: true }),
  });
}
