import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { atlcliPublishingIntegration } from "@atlcli/web-publish-astro";

const bundlePath = fileURLToPath(new URL("./publication/bundle.json", import.meta.url));
const manifestPath = fileURLToPath(new URL("../evidence/build-inventory.json", import.meta.url));
const entrypoint = fileURLToPath(new URL("./src/publication-page.astro", import.meta.url));

export default defineConfig({
  output: "static",
  base: "/docs",
  trailingSlash: "always",
  integrations: [atlcliPublishingIntegration({
    bundlePath,
    manifestPath,
    routePrefix: "/publish",
    trustedLayoutEntrypoint: entrypoint,
  })],
});
