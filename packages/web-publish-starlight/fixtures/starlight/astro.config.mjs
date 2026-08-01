import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  output: "static",
  build: { inlineStylesheets: "never" },
  integrations: [starlight({
    title: "Published knowledge",
    description: "A Starlight presentation of normalized ExportBlock content.",
    pagefind: true,
    disable404Route: true,
    customCss: [
      "@atlcli/export-blocks-astro/styles.css",
      "@atlcli/web-publish-starlight/styles.css",
    ],
  })],
});
