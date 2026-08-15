import { defineCollection, z } from "astro:content";
import { atlcliPublicationLoader } from "@atlcli/web-publish-astro";
import { bundlePath } from "virtual:atlcli-publication";

const publications = defineCollection({
  loader: atlcliPublicationLoader({
    bundlePath,
  }),
  schema: z.object({
    sourceId: z.string(),
    title: z.string(),
    route: z.string(),
    blocks: z.array(z.unknown()),
    bundleDigest: z.string(),
  }),
});

export const collections = { publications };
