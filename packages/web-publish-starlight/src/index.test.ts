import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1,
  STARLIGHT_PUBLISHING_EXPERIENCE_V1,
  StarlightPublishingExperienceErrorV1,
  createStarlightPublishingExperienceRuntimeV1,
} from "./index.js";

test("exposes a presentation-only Starlight experience descriptor", () => {
  expect(STARLIGHT_PUBLISHING_EXPERIENCE_V1).toMatchObject({
    schema: "atlcli.publication-experience/1",
    id: STARLIGHT_PUBLISHING_EXPERIENCE_ID_V1,
    version: "1.0.0", engine: "astro", designTokensSchema: "atlcli.starlight.tokens/1",
  });
  expect(STARLIGHT_PUBLISHING_EXPERIENCE_V1.capabilities).toContain("search-modal");
  expect(STARLIGHT_PUBLISHING_EXPERIENCE_V1.components.slots["main-content"]).toBe("StarlightDocumentBody");
});

test("exposes versioned semantic slots without Starlight DOM selectors", () => {
  const runtime = createStarlightPublishingExperienceRuntimeV1();
  expect(runtime).toMatchObject({
    schema: "atlcli.web-publish-starlight-runtime/1",
    features: { navigation: true, search: true, toc: true, colorModes: true, print: true },
  });
  expect(runtime.slots).toContain("main-content");
  expect(runtime.tokens).toContain("--atlcli-content-foreground");
  expect(() => createStarlightPublishingExperienceRuntimeV1({ slots: ["header"] })).toThrow("main-content slot is required");
  expect(() => createStarlightPublishingExperienceRuntimeV1({ slots: ["main-content", "main-content"] })).toThrow(StarlightPublishingExperienceErrorV1);
  expect(JSON.stringify(runtime)).not.toContain("sl-");
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

test("maps only public Starlight tokens into the render-kit document-body slot", async () => {
  const root = resolve(import.meta.dir, "..");
  const [component, stylesheet] = await Promise.all([
    readFile(resolve(root, "src/components/StarlightDocumentBody.astro"), "utf8"),
    readFile(resolve(root, "src/styles.css"), "utf8"),
  ]);
  expect(component).toContain('from "@atlcli/export-blocks-astro/components/ExportDocument.astro"');
  expect(component).toContain('data-atlcli-starlight-slot="main-content"');
  expect(component).not.toContain("exportBlockKind");
  for (const token of ["--sl-color-text", "--sl-color-gray-3", "--sl-color-gray-5", "--sl-color-gray-6"]) {
    expect(stylesheet).toContain(token);
  }
  expect(stylesheet).toContain('[data-atlcli-starlight-slot="main-content"]');
  for (const slot of ["breadcrumbs", "related-pages", "previous-next"]) {
    expect(stylesheet).toContain(`[data-atlcli-publication-slot="${slot}"]`);
  }
  expect(stylesheet).not.toContain(".sl-");
});

test("uses Starlight's public Expressive Code component as a closed code-block override", async () => {
  const root = resolve(import.meta.dir, "..");
  const [documentBody, codeBlock] = await Promise.all([
    readFile(resolve(root, "src/components/StarlightDocumentBody.astro"), "utf8"),
    readFile(resolve(root, "src/components/StarlightCodeBlock.astro"), "utf8"),
  ]);
  expect(documentBody).toContain("code: StarlightCodeBlock");
  expect(codeBlock).toContain('from "@astrojs/starlight/components"');
  expect(codeBlock).toContain('data-atlcli-code-renderer="starlight-expressive-code"');
  expect(codeBlock).not.toContain("set:html");
});
