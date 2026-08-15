import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { publicationIntegration } from "@atlcli/web-publish-astro-spike";

const bundlePath = process.env.ATLCLI_T0_BUNDLE
  ? fileURLToPath(new URL(process.env.ATLCLI_T0_BUNDLE, `file://${process.cwd()}/`))
  : fileURLToPath(new URL("../../fixtures/publication.json", import.meta.url));

export default defineConfig({
  site: "https://docs.example.test",
  base: "/docs",
  output: "static",
  trailingSlash: "always",
  integrations: [
    publicationIntegration({
      bundlePath,
      manifestPath: fileURLToPath(new URL("../../evidence/plain-build-hook.json", import.meta.url)),
    }),
  ],
});
