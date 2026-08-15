import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { fileURLToPath } from "node:url";
import { publicationLoader, type T0PublicationPage } from "@atlcli/web-publish-astro-spike";

const bundlePath = process.env.ATLCLI_T0_BUNDLE
  ? fileURLToPath(new URL(process.env.ATLCLI_T0_BUNDLE, `file://${process.cwd()}/`))
  : fileURLToPath(new URL("../../../fixtures/publication.json", import.meta.url));

const publicationPageSchema = z.custom<T0PublicationPage>(
  (value) => Boolean(value && typeof value === "object" && "blocks" in value),
  "expected a structured publication page",
);

export const collections = {
  publicationPages: defineCollection({
    loader: publicationLoader({ bundlePath }),
    schema: publicationPageSchema,
  }),
};
