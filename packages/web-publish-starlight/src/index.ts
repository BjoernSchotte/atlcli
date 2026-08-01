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
