import { describe, expect, it } from "bun:test";
import {
  packTemplate,
  validateManifest,
  type TemplateManifest,
} from "@atlcli/template-pack";
import {
  PDF_TEMPLATE_WRITERS_V1,
  PDF_CANONICAL_SOURCE_REVISION,
  PDF_CANONICAL_SOURCE_REVISION_1,
  PDF_CANONICAL_SOURCE_REVISION_2,
  PDF_CANONICAL_SOURCE_REVISION_3,
  PDF_CANONICAL_SOURCE_REVISION_4,
  PDF_DOCX_AUTHORING_CANONICAL_SOURCE_REVISION,
  PdfTemplateValidationError,
  buildUniformPdfPageBorderV1,
  loadPdfTemplatePack,
  generateCanonicalPdfTemplateSourceV1,
  validatePdfTemplateManifest,
  validatePdfTemplatePack,
  type PdfTemplateVisualsV1,
} from "./template-pack.js";
import { BUILTIN_PDF_DESIGN } from "./builtin-template.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
} from "./design-catalog.js";
import { createAtlcliTypstTemplate } from "./template.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";

const encoder = new TextEncoder();

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer
  );
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function svg(
  color = "#DDEEFF",
  width = 120,
  height = 80,
  inner = ""
): Uint8Array {
  return encoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${color}"/>${inner}</svg>`
  );
}

async function manifestWith(
  slots: Readonly<
    Record<
      string,
      {
        descriptorId: string;
        bytes: Uint8Array;
        path?: string;
        mediaType?: "image/png" | "image/jpeg" | "image/svg+xml";
        decorative?: boolean;
        alt?: string;
        placement?: {
          relativeTo: "page" | "margin";
          fit?: "contain" | "cover" | "stretch";
          x: string;
          y: string;
          width: string;
          height: string;
          rotation?: number;
        };
      }
    >
  >,
  options: {
    canonical?: boolean;
    decorations?: readonly Record<string, unknown>[];
    requiredFonts?: TemplateManifest["requiredFonts"];
    design?: TemplateManifest["design"];
  } = {}
): Promise<{
  manifest: TemplateManifest;
  files: Record<string, Uint8Array>;
}> {
  const descriptors: Record<string, unknown> = {};
  const assets: Record<string, unknown> = {};
  const files: Record<string, Uint8Array> = {
    "atlcli.typ": encoder.encode("// canonical fixture"),
  };
  for (const [slot, value] of Object.entries(slots)) {
    const path = value.path ?? `assets/${value.descriptorId}.svg`;
    const source = new TextDecoder().decode(value.bytes);
    const width = Number(/\bwidth="(\d+)"/u.exec(source)?.[1] ?? 1);
    const height = Number(/\bheight="(\d+)"/u.exec(source)?.[1] ?? 1);
    descriptors[value.descriptorId] = {
      path,
      sha256: await digest(value.bytes),
      mediaType: value.mediaType ?? "image/svg+xml",
      byteLength: value.bytes.byteLength,
      dimensions: { width, height, unit: "pixel" },
    };
    assets[slot] = {
      descriptor: value.descriptorId,
      writer:
        slot === "asset.logo"
          ? PDF_TEMPLATE_WRITERS_V1.logo
          : PDF_TEMPLATE_WRITERS_V1.imageDecoration,
      decorative: value.decorative ?? slot !== "asset.logo",
      ...(value.alt === undefined ? {} : { alt: value.alt }),
      ...(value.placement === undefined
        ? {}
        : { placement: value.placement }),
    };
    files[path] = value.bytes;
  }
  const defaultDecorations = Object.keys(slots)
    .filter((slot) => slot !== "asset.logo")
    .map((slot) => {
      const layer =
        slot === "asset.headerDecoration"
          ? "header"
          : slot === "asset.footerDecoration"
            ? "footer"
            : "page-background";
      return {
        kind: "image",
        id: slot,
        writer: PDF_TEMPLATE_WRITERS_V1.imageDecoration,
        scope: slot === "asset.coverBackground" ? "first" : "all",
        layer,
        asset: slot,
        placement: {
          relativeTo: layer === "page-background" ? "page" : "margin",
          fit: "contain",
          x: "0mm",
          y: "0mm",
          width: layer === "page-background" ? "210mm" : "35mm",
          height: layer === "page-background" ? "297mm" : "8mm",
        },
        decorative: true,
      };
    });
  const manifest = validateManifest({
      schemaVersion: 1,
      id: "fixture.assets",
      name: "Asset fixture",
      version: "1.0.0",
      engine: {
        kind: "typst",
        api: "wiki.pdf-template/v1",
        entry: "atlcli.typ",
        compilerRange: ">=0.14 <0.15",
      },
      design: options.design ?? BUILTIN_PDF_DESIGN,
      requiredFonts: options.requiredFonts ?? PDF_RUNTIME_ASSETS.fonts,
      assetDescriptors: descriptors,
      assets,
      decorations: options.decorations ?? defaultDecorations,
      ...(options.canonical
        ? {
            canonicalSource: {
              api: "wiki.pdf-canonical-typst",
              revision: "1",
            },
          }
        : {}),
    });
  if (options.canonical) {
    files["atlcli.typ"] = encoder.encode(
      createAtlcliTypstTemplate(
        manifest.design!,
        {}
      )
    );
  }
  return { manifest, files };
}

function revision4Design(): NonNullable<TemplateManifest["design"]> {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  design.compositions = {
    cover: {
      kind: "type-cut",
      logo: "hide",
      typeCut: { angle: 43, stop: 58 },
    },
    closingPage: {
      kind: "brand-lockup",
      logo: "show",
      website: "show",
      legalNotice: "show",
      align: "left",
    },
  };
  design.branding.websiteLabel = "example.invalid";
  design.branding.websiteUrl = "https://example.invalid";
  design.branding.legalNotice = "© Example Systems GmbH";
  Object.assign(design.tokens.colors, {
    coverTitleInverse: "#FFFFFF",
    closingPageBackground: "#E75204",
    closingBrandText: "#FFFFFF",
  });
  Object.assign(design.tokens.layout, {
    coverTitleFrameHeight: "35mm",
    closingBrandBottomInset: "24mm",
    closingBrandBlockWidth: "90mm",
    closingBrandLogoWidth: "42mm",
    closingBrandLogoHeight: "12mm",
    closingBrandLogoGap: "8mm",
    closingBrandTextGap: "4mm",
  });
  Object.assign(design.typography.roles, {
    coverTitle: { font: "heading", size: "44pt", weight: "bold" },
    coverTitleCompact: { font: "heading", size: "34pt", weight: "bold" },
    coverTitleMinimum: { font: "heading", size: "24pt", weight: "bold" },
    closingWebsite: { font: "heading", size: "14pt", weight: "semibold" },
    closingLegal: { font: "heading", size: "9pt", weight: "regular" },
  });
  return design;
}

function catalogReference(
  version: 1 | 2
): NonNullable<TemplateManifest["capabilityCatalog"]> {
  return version === 1
    ? {
        id: PDF_TEMPLATE_CAPABILITIES_V1.id,
        version: PDF_TEMPLATE_CAPABILITIES_V1.version,
        digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
      }
    : {
        id: PDF_TEMPLATE_CAPABILITIES_V2.id,
        version: PDF_TEMPLATE_CAPABILITIES_V2.version,
        digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
      };
}

function visualsForManifest(manifest: TemplateManifest): PdfTemplateVisualsV1 {
  return {
    assets: Object.fromEntries(
      Object.entries(manifest.assets ?? {}).map(([slot, reference]) => {
        const descriptor = manifest.assetDescriptors?.[reference.descriptor];
        if (!descriptor) throw new Error(`missing descriptor for ${slot}`);
        const extension =
          descriptor.mediaType === "image/png"
            ? "png"
            : descriptor.mediaType === "image/jpeg"
              ? "jpg"
              : "svg";
        return [
          slot,
          {
            vfsPath: `template-assets/${reference.descriptor
              .toLowerCase()
              .replace(/[._]+/gu, "-")}.${extension}`,
            reference,
          },
        ];
      })
    ),
    decorations: manifest.decorations ?? [],
  };
}

function expectPdfReason(
  callback: () => unknown | Promise<unknown>,
  reason: PdfTemplateValidationError["reason"]
): Promise<void> {
  return Promise.resolve()
    .then(callback)
    .then(
      () => {
        throw new Error("expected PdfTemplateValidationError");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(PdfTemplateValidationError);
        expect((error as PdfTemplateValidationError).reason).toBe(reason);
      }
    );
}

describe("PDF template manifest phase", () => {
  it("rejects unknown slots, writers, scopes, geometry, and unproven image execution", async () => {
    const fixture = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "background",
        bytes: svg(),
      },
    });
    const unknownSlot = structuredClone(fixture.manifest);
    unknownSlot.assets = {
      ...unknownSlot.assets,
      "asset.freeform": unknownSlot.assets!["asset.pageBackground"]!,
    };
    await expectPdfReason(
      () => validatePdfTemplateManifest(unknownSlot),
      "unknown-slot"
    );

    const writer = structuredClone(fixture.manifest);
    writer.assets!["asset.pageBackground"]!.writer = "typst.raw";
    await expectPdfReason(
      () => validatePdfTemplateManifest(writer),
      "unknown-writer"
    );

    const scope = structuredClone(fixture.manifest);
    const scopedDecoration = scope.decorations![0]!;
    if (scopedDecoration.kind !== "image") throw new Error("fixture drift");
    scope.decorations = [
      { ...scopedDecoration, scope: "first" },
      ...scope.decorations!.slice(1),
    ];
    await expectPdfReason(
      () => validatePdfTemplateManifest(scope),
      "invalid-scope"
    );

    const geometry = structuredClone(fixture.manifest);
    const image = geometry.decorations![0]!;
    if (image.kind !== "image") throw new Error("fixture drift");
    image.placement.width = "1001mm";
    await expectPdfReason(
      () => validatePdfTemplateManifest(geometry),
      "invalid-geometry"
    );

    const crop = structuredClone(fixture.manifest);
    const cropped = crop.decorations![0]!;
    if (cropped.kind !== "image") throw new Error("fixture drift");
    cropped.placement.crop = { left: 0.1, top: 0, right: 0, bottom: 0 };
    await expectPdfReason(
      () => validatePdfTemplateManifest(crop),
      "unsupported-decoration"
    );
  });

  it("keeps revisions 1-3 pinned and gives revision 5 a migration diagnostic", async () => {
    expect(PDF_CANONICAL_SOURCE_REVISION).toBe("3");
    expect(PDF_DOCX_AUTHORING_CANONICAL_SOURCE_REVISION).toBe("3");
    expect([
      PDF_CANONICAL_SOURCE_REVISION_1,
      PDF_CANONICAL_SOURCE_REVISION_2,
      PDF_CANONICAL_SOURCE_REVISION_3,
      PDF_CANONICAL_SOURCE_REVISION_4,
    ]).toEqual(["1", "2", "3", "4"]);
    const prior = await manifestWith({}, { canonical: true });
    expect(validatePdfTemplateManifest(prior.manifest)).toBe(prior.manifest);

    prior.manifest.canonicalSource!.revision = "2";
    prior.manifest.capabilityCatalog = catalogReference(1);
    expect(validatePdfTemplateManifest(prior.manifest)).toBe(prior.manifest);

    const future = structuredClone(prior.manifest);
    future.canonicalSource!.revision = "5";
    await expectPdfReason(
      () => validatePdfTemplateManifest(future),
      "unsupported-canonical-revision"
    );
    expect(() => validatePdfTemplateManifest(future)).toThrow(
      /explicit template migration/
    );
  });

  it("validates revision 4 only with Catalog V2 and complete conditional composition data", async () => {
    const fixture = await manifestWith(
      {
        "asset.coverBackground": {
          descriptorId: "cover",
          bytes: svg(),
        },
        "asset.logo": {
          descriptorId: "logo",
          bytes: svg("#E75204"),
          decorative: false,
          alt: "Example Systems",
        },
      },
      { design: revision4Design() }
    );
    fixture.manifest.canonicalSource = {
      api: "wiki.pdf-canonical-typst",
      revision: PDF_CANONICAL_SOURCE_REVISION_4,
    };
    fixture.manifest.capabilityCatalog = catalogReference(2);
    expect(validatePdfTemplateManifest(fixture.manifest)).toBe(fixture.manifest);
    const source = generateCanonicalPdfTemplateSourceV1(
      fixture.manifest,
      visualsForManifest(fixture.manifest)
    );
    const cover = source.slice(
      source.indexOf('  if cover-config.at("enabled"'),
      source.indexOf("  set page(fill: white)")
    );
    expect(cover.match(/#meta\.title/gu)).toHaveLength(1);
    expect(cover).toContain("angle: 43deg");
    expect(cover).toContain('(rgb("#202A44"), 58%)');
    expect(cover).toContain('(rgb("#FFFFFF"), 58%)');
    expect(cover).not.toContain("logo-path");
    expect(source).toContain("template-page-decorations()");
    expect(source).toContain('image("template-assets/cover.svg"');

    const v1Digest = structuredClone(fixture.manifest);
    v1Digest.capabilityCatalog = catalogReference(1);
    await expectPdfReason(
      () => validatePdfTemplateManifest(v1Digest),
      "canonical-source-mismatch"
    );

    const wrongDigest = structuredClone(fixture.manifest);
    wrongDigest.capabilityCatalog!.digest = "0".repeat(64);
    await expectPdfReason(
      () => validatePdfTemplateManifest(wrongDigest),
      "canonical-source-mismatch"
    );

    const missing = structuredClone(fixture.manifest);
    delete missing.design!.tokens.colors.coverTitleInverse;
    await expectPdfReason(
      () => validatePdfTemplateManifest(missing),
      "invalid-composition"
    );
    expect(() => validatePdfTemplateManifest(missing)).toThrow(
      /tokens\.colors\.coverTitleInverse/
    );

    const missingLogo = structuredClone(fixture.manifest);
    delete (missingLogo.assets as Record<string, unknown>)["asset.logo"];
    await expectPdfReason(
      () => validatePdfTemplateManifest(missingLogo),
      "invalid-composition"
    );
  });

  it("rejects a revision-3 manifest pinned to Catalog V2", async () => {
    const fixture = await manifestWith({}, { canonical: true });
    fixture.manifest.canonicalSource!.revision = PDF_CANONICAL_SOURCE_REVISION_3;
    fixture.manifest.capabilityCatalog = catalogReference(2);
    await expectPdfReason(
      () => validatePdfTemplateManifest(fixture.manifest),
      "canonical-source-mismatch"
    );
  });

  it("allows only meaningful logo and decorative page ornaments", async () => {
    const valid = await manifestWith({
      "asset.logo": {
        descriptorId: "logo",
        bytes: svg(),
        decorative: false,
        alt: "Organization logo",
        placement: {
          relativeTo: "margin",
          fit: "contain",
          x: "-1.94mm",
          y: "-0.423mm",
          width: "49.989mm",
          height: "11.342mm",
        },
      },
      "asset.headerDecoration": {
        descriptorId: "header",
        bytes: svg("#223344"),
      },
    });
    expect(validatePdfTemplateManifest(valid.manifest)).toBe(valid.manifest);

    const positionedOrnament = structuredClone(valid.manifest);
    positionedOrnament.assets!["asset.headerDecoration"]!.placement = {
      relativeTo: "margin",
      fit: "contain",
      x: "0mm",
      y: "0mm",
      width: "35mm",
      height: "8mm",
    };
    await expectPdfReason(
      () => validatePdfTemplateManifest(positionedOrnament),
      "unsupported-decoration"
    );

    const meaningfulOrnament = structuredClone(valid.manifest);
    meaningfulOrnament.assets!["asset.headerDecoration"]!.decorative = false;
    meaningfulOrnament.assets!["asset.headerDecoration"]!.alt = "Essential";
    await expectPdfReason(
      () => validatePdfTemplateManifest(meaningfulOrnament),
      "unsupported-decoration"
    );
  });

  it("rejects image/foreground watermarks and section-specific decorations", async () => {
    const fixture = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "background",
        bytes: svg(),
      },
    });

    const imageWatermark = structuredClone(fixture.manifest);
    imageWatermark.decorations = [
      {
        ...imageWatermark.decorations![0]!,
        id: "asset.watermark",
      },
    ];
    await expectPdfReason(
      () => validatePdfTemplateManifest(imageWatermark),
      "unknown-decoration"
    );

    const foreground = structuredClone(fixture.manifest);
    foreground.decorations = [
      {
        ...foreground.decorations![0]!,
        layer: "foreground",
      } as never,
    ];
    await expectPdfReason(
      () => validatePdfTemplateManifest(foreground),
      "invalid-geometry"
    );

    const sectionSpecific = structuredClone(fixture.manifest);
    sectionSpecific.decorations = [
      {
        ...sectionSpecific.decorations![0]!,
        scope: "section:1",
      } as never,
    ];
    await expectPdfReason(
      () => validatePdfTemplateManifest(sectionSpecific),
      "invalid-scope"
    );
  });
});

describe("PDF template pack integrity phase", () => {
  it("pins and loads the characterized canonical source for revisions 1, 2, and 3", async () => {
    const revision1 = await manifestWith({}, { canonical: true });
    const source1 = generateCanonicalPdfTemplateSourceV1(
      revision1.manifest,
      visualsForManifest(revision1.manifest)
    );
    expect(await digest(encoder.encode(source1))).toBe(
      "690fd6bb3d13e102886245ee8fdc0ffd0e84b7090ab45c8a92c2e68586d0cc3f"
    );
    revision1.files["atlcli.typ"] = encoder.encode(source1);
    expect(
      (await loadPdfTemplatePack(await packTemplate(revision1))).canonicalSource.revision
    ).toBe("1");

    for (const [revision, expected] of [
      [
        PDF_CANONICAL_SOURCE_REVISION_2,
        "e5fbf3cbc79557ecd62a69eb70f8bd013b45b81b25d1d08b92e199969b6fe333",
      ],
      [
        PDF_CANONICAL_SOURCE_REVISION_3,
        "01a978f09f902705664eaadb309f1560adce791ac747b17c8885cd565696ecb8",
      ],
    ] as const) {
      const fixture = await manifestWith({
        "asset.coverBackground": {
          descriptorId: "cover",
          bytes: svg(),
        },
      });
      fixture.manifest.canonicalSource = {
        api: "wiki.pdf-canonical-typst",
        revision,
      };
      fixture.manifest.capabilityCatalog = catalogReference(1);
      const source = generateCanonicalPdfTemplateSourceV1(
        fixture.manifest,
        visualsForManifest(fixture.manifest)
      );
      expect(await digest(encoder.encode(source))).toBe(expected);
      fixture.files["atlcli.typ"] = encoder.encode(source);
      expect(
        (await loadPdfTemplatePack(await packTemplate(fixture))).canonicalSource.revision
      ).toBe(revision);
    }
  });

  it("accepts verified assets and returns compiler-owned VFS paths", async () => {
    const fixture = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "page.art",
        bytes: svg(),
      },
    }, { canonical: true });
    validatePdfTemplateManifest(fixture.manifest);
    const loaded = await validatePdfTemplatePack(
      fixture.manifest,
      fixture.files
    );
    expect(loaded.assets["asset.pageBackground"]?.vfsPath).toBe(
      "template-assets/page-art.svg"
    );
  });

  it("rejects missing, hash/magic/descriptor mismatches and resource excess", async () => {
    const fixture = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "background",
        bytes: svg(),
      },
    });
    const path = fixture.manifest.assetDescriptors!.background!.path;
    const missing = { ...fixture.files };
    delete missing[path];
    await expectPdfReason(
      () => validatePdfTemplatePack(fixture.manifest, missing),
      "missing-payload"
    );

    const wrongHash = structuredClone(fixture.manifest);
    wrongHash.assetDescriptors!.background!.sha256 = "0".repeat(64);
    await expectPdfReason(
      () => validatePdfTemplatePack(wrongHash, fixture.files),
      "hash-mismatch"
    );

    const wrongMagicFixture = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "background",
        bytes: svg(),
      },
    });
    wrongMagicFixture.manifest.assetDescriptors!.background!.mediaType =
      "image/png";
    await expectPdfReason(
      async () =>
        validatePdfTemplatePack(
          wrongMagicFixture.manifest,
          wrongMagicFixture.files
        ),
      "media-mismatch"
    );

    const wrongDimensions = structuredClone(fixture.manifest);
    wrongDimensions.assetDescriptors!.background!.dimensions.width += 1;
    await expectPdfReason(
      () => validatePdfTemplatePack(wrongDimensions, fixture.files),
      "descriptor-mismatch"
    );

    const huge = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "background",
        bytes: svg("#DDEEFF", 16_384, 16_384),
      },
    });
    await expectPdfReason(
      () => validatePdfTemplatePack(huge.manifest, huge.files),
      "asset-budget-exceeded"
    );

    const complex = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "background",
        bytes: svg("#DDEEFF", 120, 80, "<path d=\"M0 0\"/>".repeat(2_001)),
      },
    });
    await expectPdfReason(
      () => validatePdfTemplatePack(complex.manifest, complex.files),
      "asset-budget-exceeded"
    );
  });

  it("rejects hostile/external SVG and fixed-path collisions before compilation", async () => {
    for (const inner of [
      "<script>alert(1)</script>",
      '<image href="https://example.invalid/tracker.png"/>',
      '<rect style="fill:url(data:image/png;base64,AAAA)"/>',
    ]) {
      const fixture = await manifestWith({
        "asset.pageBackground": {
          descriptorId: "background",
          bytes: svg("#DDEEFF", 120, 80, inner),
        },
      });
      await expectPdfReason(
        () => validatePdfTemplatePack(fixture.manifest, fixture.files),
        "unsafe-svg"
      );
    }

    const collision = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "same.one",
        bytes: svg(),
      },
      "asset.headerDecoration": {
        descriptorId: "same_one",
        bytes: svg("#223344"),
      },
    });
    await expectPdfReason(
      () => validatePdfTemplatePack(collision.manifest, collision.files),
      "vfs-collision"
    );
  });

  it("rejects foreign canonical payloads and non-canonical executable packs", async () => {
    const canonical = await manifestWith(
      {
        "asset.pageBackground": {
          descriptorId: "background",
          bytes: svg(),
        },
      },
      { canonical: true }
    );
    const withForeign = {
      ...canonical.files,
      "notes/private.txt": encoder.encode("must not ship"),
    };
    await expectPdfReason(
      () => validatePdfTemplatePack(canonical.manifest, withForeign),
      "unreferenced-payload"
    );

    const legacy = await manifestWith({
      "asset.pageBackground": {
        descriptorId: "background",
        bytes: svg(),
      },
    });
    await expectPdfReason(
      async () =>
        validatePdfTemplatePack(legacy.manifest, {
          ...legacy.files,
          "legacy/opaque.bin": new Uint8Array([1, 2, 3]),
        }),
      "non-canonical-template-source"
    );
  });

  it("orchestrates all phases and rejects non-bundled fonts before returning", async () => {
    const fixture = await manifestWith(
      {
        "asset.pageBackground": {
          descriptorId: "background",
          bytes: svg(),
        },
      },
      { canonical: true }
    );
    const archive = await packTemplate(fixture);
    const loaded = await loadPdfTemplatePack(archive);
    expect(loaded.assets["asset.pageBackground"]).toBeDefined();

    const badFont = await manifestWith(
      {},
      {
        canonical: true,
        requiredFonts: [
          { family: "Remote Font", style: "normal", weight: 400 },
        ],
      }
    );
    const badArchive = await packTemplate(badFont);
    await expect(loadPdfTemplatePack(badArchive)).rejects.toThrow(
      /not in the bundled font inventory/
    );
  });

  it("rejects manifest, canonical Typst, and asset-byte mutation with phase-specific reasons", async () => {
    const fixture = await manifestWith(
      {
        "asset.pageBackground": {
          descriptorId: "background",
          bytes: svg("#DDEEFF"),
        },
      },
      { canonical: true }
    );

    const changedManifest = structuredClone(fixture.manifest);
    changedManifest.design!.branding.accent = "#123456";
    await expectPdfReason(
      async () =>
        loadPdfTemplatePack(
          await packTemplate({
            manifest: changedManifest,
            files: fixture.files,
          })
        ),
      "non-canonical-template-source"
    );

    await expectPdfReason(
      async () =>
        loadPdfTemplatePack(
          await packTemplate({
            manifest: fixture.manifest,
            files: {
              ...fixture.files,
              "atlcli.typ": encoder.encode(
                '#let atlcli-doc(body) = body\n// free Typst'
              ),
            },
          })
        ),
      "non-canonical-template-source"
    );

    const assetPath =
      fixture.manifest.assetDescriptors!.background!.path;
    await expectPdfReason(
      async () =>
        loadPdfTemplatePack(
          await packTemplate({
            manifest: fixture.manifest,
            files: {
              ...fixture.files,
              [assetPath]: svg("#CCDDEE"),
            },
          })
        ),
      "hash-mismatch"
    );
  });

  it("returns a structured-clone-compatible runtime and rejects a foreign catalog pin", async () => {
    const fixture = await manifestWith({}, { canonical: true });
    const runtime = await loadPdfTemplatePack(await packTemplate(fixture));
    expect(structuredClone(runtime)).toEqual(runtime);
    expect(runtime.runtimeSnapshot.capabilityCatalog.digest).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(runtime.canonicalSource.source).toBe(runtime.entrySource);

    const foreign = structuredClone(fixture.manifest);
    foreign.canonicalSource!.revision = "2";
    foreign.capabilityCatalog = {
      id: "wiki.pdf.design-capabilities",
      version: 1,
      digest: "0".repeat(64),
    };
    await expectPdfReason(
      () => validatePdfTemplateManifest(foreign),
      "canonical-source-mismatch"
    );
  });
});

describe("uniform page-border builder", () => {
  const section = (index: number, color = "112233") => ({
    section: index,
    offsetFrom: "page",
    sides: (["top", "right", "bottom", "left"] as const).map((side) => ({
      side,
      style: "single",
      color,
      widthEighthPoints: 8,
    })),
  });

  it("materializes one uniform page-relative border across sections", () => {
    expect(buildUniformPdfPageBorderV1([section(0), section(1)])).toMatchObject({
      id: "decoration.pageBorder",
      scope: "all",
      offsetFrom: "page",
      stroke: { style: "single", color: "#112233", width: "1pt" },
    });
  });

  it("retains section-specific, text-relative, side-specific, and art borders as unsupported", async () => {
    await expectPdfReason(
      () => buildUniformPdfPageBorderV1([section(0), section(1, "445566")]),
      "unsupported-section-scope"
    );
    await expectPdfReason(
      () =>
        buildUniformPdfPageBorderV1([
          { ...section(0), offsetFrom: "text" },
        ]),
      "unsupported-decoration"
    );
    await expectPdfReason(
      () =>
        buildUniformPdfPageBorderV1([
          {
            ...section(0),
            sides: section(0).sides.map((side, index) => ({
              ...side,
              style: index === 0 ? "double" : "single",
            })),
          },
        ]),
      "unsupported-decoration"
    );
    await expectPdfReason(
      () =>
        buildUniformPdfPageBorderV1([
          {
            ...section(0),
            sides: section(0).sides.slice(0, 3),
          },
        ]),
      "unsupported-decoration"
    );
    await expectPdfReason(
      () =>
        buildUniformPdfPageBorderV1([
          {
            ...section(0),
            sides: section(0).sides.map((side) => ({
              ...side,
              style: "apples",
            })),
          },
        ]),
      "unsupported-decoration"
    );
  });
});
