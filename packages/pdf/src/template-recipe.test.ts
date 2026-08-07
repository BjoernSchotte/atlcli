import { describe, expect, it } from "bun:test";
import type {
  TemplateGeneratedPackCompilerV1,
} from "@atlcli/pdf-template-authoring";
import {
  unpackTemplate,
  type WikiPdfTemplateDesignV1,
  type WikiPdfTemplateRecipeV1,
} from "@atlcli/template-pack";
import {
  BUILTIN_PDF_DESIGN,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
} from "./builtin-template.js";
import type { PdfCompilePort } from "./compiler.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
} from "./design-catalog.js";
import {
  PDF_COMPOSITION_PROOF_TITLES_V1,
  PdfGeneratedTemplateProofCompiler,
} from "./template-authoring-runtime.js";
import {
  materializePdfTemplateRecipeV1,
  type MaterializePdfTemplateRecipeInputV1,
  type ResolvedPdfTemplateRecipeAssetV1,
} from "./template-recipe.js";

const encoder = new TextEncoder();
const COVER_SOURCE = "visuals/cover-art.svg";
const LOGO_SOURCE = "visuals/brand-mark.svg";
const COVER_BYTES = encoder.encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="297" viewBox="0 0 210 297"><path fill="#E75204" d="M0 0h210v297H0z"/></svg>'
);
const LOGO_BYTES = encoder.encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24" viewBox="0 0 80 24"><path fill="#FFFFFF" d="M0 0h80v24H0z"/></svg>'
);

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

function design(): WikiPdfTemplateDesignV1 {
  const value = structuredClone(BUILTIN_PDF_DESIGN);
  value.compositions = {
    cover: {
      kind: "type-cut",
      logo: "show",
      metadataPosition: "bottom",
      typeCut: { angle: 43, stop: 64 },
    },
    closingPage: {
      kind: "brand-lockup",
      logo: "show",
      website: "show",
      legalNotice: "show",
      align: "left",
    },
  };
  Object.assign(value.branding, {
    websiteLabel: "systems.example",
    websiteUrl: "https://systems.example/services",
    legalNotice: "Example Systems GmbH · Berlin · Qualität 🧪",
  });
  Object.assign(value.tokens.colors, {
    coverTitleInverse: "#FFFFFF",
    closingPageBackground: "#E75204",
    closingBrandText: "#FFFFFF",
  });
  Object.assign(value.tokens.layout, {
    coverTitleFrameHeight: "92mm",
    coverMetaBottomInset: "24mm",
    closingBrandBottomInset: "24mm",
    closingBrandBlockWidth: "92mm",
    closingBrandLogoWidth: "42mm",
    closingBrandLogoHeight: "18mm",
    closingBrandLogoGap: "8mm",
    closingBrandTextGap: "4mm",
  });
  Object.assign(value.typography.roles, {
    coverTitleCompact: {
      font: "body",
      size: "25pt",
      weight: "semibold",
    },
    coverTitleMinimum: {
      font: "body",
      size: "19pt",
      weight: "semibold",
    },
    closingWebsite: {
      font: "heading",
      size: "14pt",
      weight: "semibold",
    },
    closingLegal: {
      font: "heading",
      size: "9pt",
      weight: "regular",
    },
  });
  return value;
}

function recipe(): WikiPdfTemplateRecipeV1 {
  return {
    schema: "wiki.pdf-template-recipe/v1",
    template: {
      id: "fixture.executive-v4",
      name: "Executive V4",
      version: "1.0.0",
      compilerRange: ">=0.14 <0.15",
    },
    design: design(),
    localization: structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST.localization!),
    assets: {
      "asset.coverBackground": {
        source: COVER_SOURCE,
        decorative: true,
      },
      "asset.logo": {
        source: LOGO_SOURCE,
        decorative: false,
        alt: "Example Systems",
      },
    },
  };
}

async function resolvedAssets(): Promise<
  Record<string, ResolvedPdfTemplateRecipeAssetV1>
> {
  return {
    "asset.coverBackground": {
      slot: "asset.coverBackground",
      source: COVER_SOURCE,
      mediaType: "image/svg+xml",
      sha256: await digest(COVER_BYTES),
      bytes: new Uint8Array(COVER_BYTES),
    },
    "asset.logo": {
      slot: "asset.logo",
      source: LOGO_SOURCE,
      mediaType: "image/svg+xml",
      sha256: await digest(LOGO_BYTES),
      bytes: new Uint8Array(LOGO_BYTES),
    },
  };
}

const proofCompiler: TemplateGeneratedPackCompilerV1 = {
  async compile({ packBytes, manifest }) {
    expect(packBytes.byteLength).toBeGreaterThan(100);
    expect(manifest.canonicalSource?.revision).toBe("4");
    return { digest: await digest(packBytes), pageCount: 3 };
  },
};

async function input(
  overrides: Partial<MaterializePdfTemplateRecipeInputV1> = {}
): Promise<MaterializePdfTemplateRecipeInputV1> {
  return {
    recipe: recipe(),
    resolvedAssets: await resolvedAssets(),
    compiler: proofCompiler,
    ...overrides,
  };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)])
    );
  }
  return value;
}

function expectSameBytes(left: Uint8Array, right: Uint8Array): void {
  expect(left.byteLength).toBe(right.byteLength);
  expect(Array.from(left)).toEqual(Array.from(right));
}

describe("materializePdfTemplateRecipeV1", () => {
  it("pins Catalog V2/revision 4 and derives identities from slot plus digest", async () => {
    const built = await materializePdfTemplateRecipeV1(await input());
    expect(built.manifest.capabilityCatalog).toEqual({
      id: PDF_TEMPLATE_CAPABILITIES_V2.id,
      version: PDF_TEMPLATE_CAPABILITIES_V2.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
    });
    expect(built.manifest.canonicalSource).toEqual({
      api: "wiki.pdf-canonical-typst",
      revision: "4",
    });
    expect(built.manifest.design?.compositions?.cover.metadataPosition).toBe(
      "bottom"
    );
    expect(
      new TextDecoder().decode(unpackTemplate(built.bytes).files["atlcli.typ"])
    ).toContain(
      "dy: -24mm"
    );
    const paths = Object.values(built.manifest.assetDescriptors ?? {}).map(
      ({ path }) => path
    );
    expect(paths.every((path) => /^assets\/asset-[a-z-]+-[a-f0-9]{64}\.svg$/u.test(path))).toBe(true);
    expect(paths.some((path) => path.includes("cover-art"))).toBe(false);
    expect(paths.some((path) => path.includes("brand-mark"))).toBe(false);
    expect(built.manifest.decorations).toContainEqual(
      expect.objectContaining({
        id: "asset.coverBackground",
        scope: "first",
        layer: "page-background",
      })
    );
    expect(unpackTemplate(built.bytes).manifest.provenance?.payloadSha256).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(built.packDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is byte-deterministic across warm repeats, key order, parser line endings, and asset order", async () => {
    const base = await input();
    const first = await materializePdfTemplateRecipeV1(base);
    const warm = await materializePdfTemplateRecipeV1(base);
    expectSameBytes(first.bytes, warm.bytes);

    const reversedRecipe = reverseKeys(base.recipe) as WikiPdfTemplateRecipeV1;
    const reversedAssets = Object.fromEntries(
      Object.entries(base.resolvedAssets).reverse()
    );
    const reordered = await materializePdfTemplateRecipeV1({
      ...base,
      recipe: reversedRecipe,
      resolvedAssets: reversedAssets,
    });
    expectSameBytes(first.bytes, reordered.bytes);

    const lf = JSON.stringify(base.recipe, null, 2);
    const crlf = lf.replaceAll("\n", "\r\n");
    const parsedLf = JSON.parse(lf) as WikiPdfTemplateRecipeV1;
    const parsedCrlf = JSON.parse(crlf) as WikiPdfTemplateRecipeV1;
    const lfBuilt = await materializePdfTemplateRecipeV1({ ...base, recipe: parsedLf });
    const crlfBuilt = await materializePdfTemplateRecipeV1({ ...base, recipe: parsedCrlf });
    expectSameBytes(lfBuilt.bytes, crlfBuilt.bytes);
  });

  it("rejects tampered hashes, mismatched media, and unsafe SVG before compilation", async () => {
    const base = await input();
    let compileCalls = 0;
    const compiler: TemplateGeneratedPackCompilerV1 = {
      async compile() {
        compileCalls += 1;
        return { digest: "a".repeat(64), pageCount: 1 };
      },
    };
    const tampered = structuredClone(base.resolvedAssets);
    tampered["asset.logo"]!.sha256 = "0".repeat(64);
    await expect(
      materializePdfTemplateRecipeV1({ ...base, resolvedAssets: tampered, compiler })
    ).rejects.toThrow(/SHA-256 does not match/u);

    const wrongMedia = structuredClone(base.resolvedAssets);
    wrongMedia["asset.logo"]!.mediaType = "image/png";
    await expect(
      materializePdfTemplateRecipeV1({ ...base, resolvedAssets: wrongMedia, compiler })
    ).rejects.toThrow(/intrinsic dimensions/u);

    const unsafeBytes = encoder.encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"><script>alert(1)</script></svg>'
    );
    const unsafe = structuredClone(base.resolvedAssets);
    unsafe["asset.logo"]!.bytes = unsafeBytes;
    unsafe["asset.logo"]!.sha256 = await digest(unsafeBytes);
    await expect(
      materializePdfTemplateRecipeV1({ ...base, resolvedAssets: unsafe, compiler })
    ).rejects.toThrow(/unsafe SVG/u);
    expect(compileCalls).toBe(0);
  });

  it("rejects missing or unreferenced composition assets", async () => {
    const base = await input();
    const withoutLogo = structuredClone(base.recipe);
    delete (withoutLogo.assets as Record<string, unknown>)["asset.logo"];
    await expect(
      materializePdfTemplateRecipeV1({
        ...base,
        recipe: withoutLogo,
        resolvedAssets: {
          "asset.coverBackground": base.resolvedAssets["asset.coverBackground"]!,
        },
      })
    ).rejects.toThrow(/visible composition logo/u);

    const withoutBackground = structuredClone(base.recipe);
    delete (withoutBackground.assets as Record<string, unknown>)["asset.coverBackground"];
    await expect(
      materializePdfTemplateRecipeV1({
        ...base,
        recipe: withoutBackground,
        resolvedAssets: { "asset.logo": base.resolvedAssets["asset.logo"]! },
      })
    ).rejects.toThrow(/Type Cut recipes require/u);

    const hidden = structuredClone(base.recipe);
    hidden.design.compositions!.cover.logo = "hide";
    hidden.design.compositions!.closingPage.logo = "hide";
    await expect(
      materializePdfTemplateRecipeV1({ ...base, recipe: hidden })
    ).rejects.toThrow(/unreferenced/u);
  });

  it("returns no archive when compilation fails or reports invalid proof metadata", async () => {
    const base = await input();
    let output: Awaited<ReturnType<typeof materializePdfTemplateRecipeV1>> | undefined;
    await expect(
      (async () => {
        output = await materializePdfTemplateRecipeV1({
          ...base,
          compiler: {
            async compile() {
              throw new Error("synthetic compile failure");
            },
          },
        });
      })()
    ).rejects.toThrow("synthetic compile failure");
    expect(output).toBeUndefined();

    await expect(
      materializePdfTemplateRecipeV1({
        ...base,
        compiler: {
          async compile() {
            return { digest: "not-a-digest", pageCount: 0 };
          },
        },
      })
    ).rejects.toThrow(/invalid proof metadata/u);
  });

  it("uses the revision-4 proof profile with cover, closing page, and all three title tiers", async () => {
    const base = await input();
    const dormant = structuredClone(base.recipe);
    dormant.design.features.cover.enabled = false;
    dormant.design.features.closingPage.enabled = false;
    const built = await materializePdfTemplateRecipeV1({ ...base, recipe: dormant });
    const mains: string[] = [];
    const pdf = encoder.encode(
      "%PDF-1.7\n/Type /Page /Type /Catalog /Lang (en) /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n"
    );
    const port: PdfCompilePort = {
      async compile(bundle) {
        mains.push(bundle.main);
        return { pdf, diagnostics: [], compilerVersion: "test" };
      },
    };
    const proof = await new PdfGeneratedTemplateProofCompiler(port).compile({
      packBytes: built.bytes,
      manifest: built.manifest,
      runtimeSnapshot: built.runtimeSnapshot as unknown as Readonly<Record<string, unknown>>,
    });
    expect(proof.pageCount).toBe(1);
    expect(mains).toHaveLength(3);
    for (const [index, title] of PDF_COMPOSITION_PROOF_TITLES_V1.entries()) {
      expect(mains[index]).toContain(JSON.stringify(title));
      expect(mains[index]).toContain("cover: (enabled: true)");
      expect(mains[index]).toContain("closingPage: (enabled: true)");
    }
  });
});
