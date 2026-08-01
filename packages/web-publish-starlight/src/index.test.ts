import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1, STARLIGHT_PUBLISHING_EXPERIENCE_V1 } from "./index.js";

test("exposes a presentation-only Starlight experience descriptor", () => {
  expect(STARLIGHT_PUBLISHING_EXPERIENCE_V1).toEqual({
    id: STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1,
    version: "1",
    owner: "astro-project",
    bodies: "@atlcli/export-blocks-astro",
    rendering: "astro-static",
    starlight: "^0.41.3",
  });
});

test("does not own a build runner or duplicate ExportBlock rendering", async () => {
  const root = resolve(import.meta.dir, "..");
  const [manifest, source] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "src/index.ts"), "utf8"),
  ]);
  expect(manifest).toContain('"@astrojs/starlight": "^0.41.3"');
  expect(manifest).toContain('"astro": ">=7.1.6 <8"');
  expect(manifest).toContain('"@atlcli/export-blocks-astro": "workspace:*"');
  expect(source).not.toContain("ExportDocument");
  expect(source).not.toContain("exportBlockKind");
  expect(source).not.toContain("Bun.spawn");
});
