import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { publicationIntegration } from "@atlcli/web-publish-astro-spike";

const bundlePath = process.env.ATLCLI_T0_BUNDLE
  ? fileURLToPath(new URL(process.env.ATLCLI_T0_BUNDLE, `file://${process.cwd()}/`))
  : fileURLToPath(new URL("../../fixtures/publication.json", import.meta.url));
const analyticsMode = process.env.ATLCLI_T0_ANALYTICS ?? "none";
if (!["none", "plausible"].includes(analyticsMode)) {
  throw new Error(`unsupported T0 analytics mode: ${analyticsMode}`);
}

export default defineConfig({
  site: "https://docs.example.test",
  base: "/docs",
  output: "static",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Structured publishing",
      description: "A Starlight experience over a structured ExportBlock publication.",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
        ar: { label: "العربية", lang: "ar", dir: "rtl" },
      },
      pagefind: true,
      lastUpdated: false,
      customCss: ["./src/styles/publication.css"],
      components: {
        EditLink: "./src/components/ConfluenceEditLink.astro",
        Head: analyticsMode === "plausible"
          ? "./src/components/PublicationHeadPlausible.astro"
          : "./src/components/PublicationHead.astro",
        LanguageSelect: "./src/components/PublicationLanguageSelect.astro",
      },
      head: [{ tag: "meta", attrs: { name: "robots", content: "index,follow" } }],
    }),
    publicationIntegration({
      bundlePath,
      manifestPath: fileURLToPath(new URL("../../evidence/starlight-build-hook.json", import.meta.url)),
    }),
  ],
});
