import { defineConfig } from "astro/config";

export default defineConfig({
  base: "/docs",
  output: "static",
  trailingSlash: "always",
});
