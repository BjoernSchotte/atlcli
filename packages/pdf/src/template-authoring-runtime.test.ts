import { describe, expect, it } from "bun:test";
import type { AuthoringResolutionSnapshotV1 } from "@atlcli/pdf-template-authoring";
import { BUILTIN_PDF_DESIGN } from "./builtin-template.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
} from "./design-catalog.js";
import { PdfTemplateRuntimeMaterializer } from "./template-authoring-runtime.js";
import {
  PDF_CANONICAL_SOURCE_REVISION,
  PDF_DOCX_AUTHORING_CANONICAL_SOURCE_REVISION,
} from "./template-pack.js";

const HASH = "a".repeat(64);

function snapshot(): AuthoringResolutionSnapshotV1 {
  return {
    schema: "wiki.pdf-template-authoring-resolution/v1",
    catalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
    },
    baseline: { id: "builtin.executive", version: "1.0.0", digest: HASH },
    sourceDigest: HASH,
    decisionDigest: HASH,
    snapshotDigest: HASH,
    design: structuredClone(BUILTIN_PDF_DESIGN) as unknown as Readonly<
      Record<string, unknown>
    >,
    assets: {},
    staleness: [],
    trace: {},
  };
}

describe("PdfTemplateRuntimeMaterializer compatibility", () => {
  it("keeps DOCX-derived authoring explicitly pinned to Catalog V1 and canonical revision 3", async () => {
    const materialized = await new PdfTemplateRuntimeMaterializer().materialize(
      snapshot(),
      []
    );
    expect(PDF_CANONICAL_SOURCE_REVISION).toBe("3");
    expect(PDF_DOCX_AUTHORING_CANONICAL_SOURCE_REVISION).toBe("3");
    expect(materialized.manifest.capabilityCatalog).toEqual({
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
    });
    expect(materialized.manifest.canonicalSource).toEqual({
      api: "wiki.pdf-canonical-typst",
      revision: "3",
    });
  });

  it("preserves the characterized DOCX descriptor ids and archive paths", async () => {
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>'
    );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
    const materialized = await new PdfTemplateRuntimeMaterializer().materialize(
      snapshot(),
      [
        {
          slot: "asset.logo",
          sha256: digest,
          mediaType: "image/svg+xml",
          bytes,
          accessibility: { decorative: false, alt: "Neutral logo" },
          rendering: { kind: "slot-default" },
        },
      ]
    );
    expect(materialized.manifest.assetDescriptors).toEqual({
      "asset-logo": {
        path: `assets/asset.logo/${digest}.svg`,
        sha256: digest,
        mediaType: "image/svg+xml",
        byteLength: bytes.byteLength,
        dimensions: { width: 20, height: 10, unit: "pixel" },
      },
    });
    expect(Object.keys(materialized.files).sort()).toEqual([
      `assets/asset.logo/${digest}.svg`,
      "atlcli.typ",
    ]);
  });
});
