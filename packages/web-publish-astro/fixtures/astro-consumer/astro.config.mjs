import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { atlcliPublishingIntegration } from "@atlcli/web-publish-astro";

const profiles = {
  "nested-directory": { base: "/docs", outputProfile: "directory", format: "directory", trailingSlash: "always", outDir: "./dist/" },
  "root-directory": { base: "/", outputProfile: "directory", format: "directory", trailingSlash: "always", outDir: "./dist-root/" },
  "nested-portable": { base: "/docs", outputProfile: "portable-file", format: "file", trailingSlash: "never", outDir: "./dist-file/" },
};
const profileName = process.env.ATLCLI_ASTRO_FIXTURE_PROFILE ?? "nested-directory";
const profile = profiles[profileName];
if (!profile) throw new Error(`unknown Astro consumer fixture profile: ${profileName}`);

const bundlePath = process.env.ATLCLI_PUBLICATION_BUNDLE_PATH ??
  fileURLToPath(new URL("./publication/bundle.json", import.meta.url));
const manifestPath = process.env.ATLCLI_PUBLICATION_INVENTORY_PATH ??
  fileURLToPath(new URL(`../evidence/build-inventory${profileName === "nested-directory" ? "" : `-${profileName}`}.json`, import.meta.url));
const entrypoint = fileURLToPath(new URL("./src/publication-page.astro", import.meta.url));
const outDir = fileURLToPath(new URL(profile.outDir, import.meta.url));
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));

export default defineConfig({
  output: "static",
  base: profile.base,
  trailingSlash: profile.trailingSlash,
  build: { format: profile.format },
  outDir,
  publicDir,
  integrations: [atlcliPublishingIntegration({
    bundlePath,
    manifestPath,
    routePrefix: "/publish",
    expectedConfig: {
      base: profile.base,
      outputProfile: profile.outputProfile,
      outDir,
      publicDir,
    },
    trustedLayoutEntrypoint: entrypoint,
  })],
});
