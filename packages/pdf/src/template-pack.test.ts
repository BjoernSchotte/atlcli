import { describe, expect, it } from "bun:test";
import {
  packTemplate,
  validateManifest,
  type TemplateManifest,
} from "@atlcli/template-pack";
import {
  PDF_TEMPLATE_WRITERS_V1,
  PDF_CANONICAL_SOURCE_REVISION,
  PdfTemplateValidationError,
  buildUniformPdfPageBorderV1,
  loadPdfTemplatePack,
  validatePdfTemplateManifest,
  validatePdfTemplatePack,
} from "./template-pack.js";
import { BUILTIN_PDF_DESIGN } from "./builtin-template.js";
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
      }
    >
  >,
  options: {
    canonical?: boolean;
    decorations?: readonly Record<string, unknown>[];
    requiredFonts?: TemplateManifest["requiredFonts"];
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
      design: BUILTIN_PDF_DESIGN,
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

  it("keeps the prior canonical revision readable and gives future revisions a migration diagnostic", async () => {
    expect(PDF_CANONICAL_SOURCE_REVISION).toBe("2");
    const prior = await manifestWith({}, { canonical: true });
    prior.manifest.canonicalSource!.revision = "1";
    expect(validatePdfTemplateManifest(prior.manifest)).toBe(prior.manifest);

    const future = structuredClone(prior.manifest);
    future.canonicalSource!.revision = "3";
    await expectPdfReason(
      () => validatePdfTemplateManifest(future),
      "unsupported-canonical-revision"
    );
    expect(() => validatePdfTemplateManifest(future)).toThrow(
      /explicit template migration/
    );
  });

  it("allows only meaningful logo and decorative page ornaments", async () => {
    const valid = await manifestWith({
      "asset.logo": {
        descriptorId: "logo",
        bytes: svg(),
        decorative: false,
        alt: "Organization logo",
      },
      "asset.headerDecoration": {
        descriptorId: "header",
        bytes: svg("#223344"),
      },
    });
    expect(validatePdfTemplateManifest(valid.manifest)).toBe(valid.manifest);

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
