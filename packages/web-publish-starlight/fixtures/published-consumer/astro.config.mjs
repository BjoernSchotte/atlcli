import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { fileURLToPath } from "node:url";
import { atlcliPublishingIntegration } from "@atlcli/web-publish-astro";

const bundlePath = fileURLToPath(new URL("./publication/bundle.json", import.meta.url));
const manifestPath = fileURLToPath(new URL("../evidence/published-consumer-inventory.json", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/", import.meta.url));
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));

export default defineConfig({
  output: "static",
  site: "https://publish.example",
  base: "/docs",
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "never" },
  outDir,
  publicDir,
  integrations: [
    starlight({
      title: "Published knowledge",
      description: "A bundle-driven Starlight publishing fixture.",
      pagefind: true,
      customCss: [
        "@atlcli/export-blocks-astro/styles.css",
        "@atlcli/web-publish-starlight/styles.css",
      ],
    }),
    atlcliPublishingIntegration({
      bundlePath,
      manifestPath,
      routePrefix: "/publish",
      expectedConfig: {
        base: "/docs",
        outputProfile: "directory",
        site: "https://publish.example",
        siteName: "Published knowledge",
        seo: {
          sitemap: true,
          robots: "index",
          canonical: true,
          structuredData: ["WebSite", "TechArticle", "BreadcrumbList"],
          socialCards: "metadata-only",
          feed: "rss",
        },
        i18n: {
          defaultLocale: "en",
          locales: ["en"],
          routeMode: "hide-default",
          fallback: {},
          uiTranslations: "starlight",
        },
        outDir,
        publicDir,
      },
    }),
  ],
});
