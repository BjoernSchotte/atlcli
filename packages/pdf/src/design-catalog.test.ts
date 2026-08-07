import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CapabilityValidationError,
  computeCapabilityCatalogDigest,
  computeCapabilityPresentationRevision,
  flattenDesign,
  unflattenDesign,
  validateCompleteBaseline,
  validateDesignAgainstCatalog,
  BINDING_TARGET_ALLOWLIST,
  type TemplateManifest,
  type WikiPdfTemplateDesignV1,
} from "@atlcli/template-pack";
import {
  BUILTIN_PDF_DESIGN,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
} from "./builtin-template.js";
import {
  MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
} from "./curated-templates.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V2,
  PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1,
  PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V2,
  PDF_TEMPLATE_PRESENTATION_REVISION_V1,
  PDF_TEMPLATE_PRESENTATION_REVISION_V2,
  materializeLegacyPdfDesign,
  projectPdfDesignThroughCatalog,
  projectPdfDesignThroughCatalogV2,
  readPdfDesignCapability,
  readPdfDesignCapabilityV2,
} from "./design-catalog.js";
import {
  PDF_BINDABLE_LEVEL_A_SETTINGS,
  resolvePdfSettings,
  type PdfBindableLevelASetting,
} from "./settings.js";

function readPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function deletePath(value: unknown, path: string): void {
  const segments = path.split(".");
  let cursor = value as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as Record<string, unknown>;
  }
  delete cursor[segments.at(-1)!];
}

function authoringManifest(): TemplateManifest {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  design.page.size = "letter";
  design.page.orientation = "landscape";
  design.features.cover.enabled = false;
  design.features.outline.enabled = false;
  design.branding.accent = "#135724";
  design.branding.organizationName = "Baseline Organization";
  design.tokens.colors.accent = "#135724";
  design.tokens.colors.ink = "#202830";
  design.tokens.colors.paper = "#FAF7F0";
  design.tokens.contrast.minimum = 7;
  return {
    ...BUILTIN_PDF_TEMPLATE_MANIFEST,
    id: "test.authoring-complete",
    name: "Test authoring complete",
    design,
  };
}

const BINDABLE_TARGETS: Readonly<
  Record<PdfBindableLevelASetting, readonly string[]>
> = {
  accentColor: ["branding.accent", "tokens.colors.accent"],
  organizationName: ["branding.organizationName"],
  page: ["page.size"],
  orientation: ["page.orientation"],
  cover: ["features.cover.enabled"],
  outline: ["features.outline.enabled"],
};

const OVERRIDES: Readonly<Record<PdfBindableLevelASetting, unknown>> = {
  accentColor: "#ABCDEF",
  organizationName: "Override Organization",
  page: "a4",
  orientation: "portrait",
  cover: true,
  outline: true,
};

describe("PDF template capability catalog V1", () => {
  it("pins canonical runtime and presentation digests independently", async () => {
    expect(await computeCapabilityCatalogDigest(PDF_TEMPLATE_CAPABILITIES_V1)).toBe(
      PDF_TEMPLATE_CAPABILITY_DIGEST_V1
    );
    expect(
      await computeCapabilityPresentationRevision(
        PDF_TEMPLATE_CAPABILITIES_V1,
        PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
        PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1
      )
    ).toBe(PDF_TEMPLATE_PRESENTATION_REVISION_V1);

    // Localized copy is intentionally outside both digest inputs. Reordering
    // it cannot alter the pinned renderer contract.
    const messagesA = { de: { page: "Seite" }, en: { page: "Page" } };
    const messagesB = { en: { page: "Page" }, de: { page: "Seite" } };
    expect(Object.keys(messagesA)).not.toEqual(Object.keys(messagesB));
    expect(await computeCapabilityCatalogDigest(PDF_TEMPLATE_CAPABILITIES_V1)).toBe(
      PDF_TEMPLATE_CAPABILITY_DIGEST_V1
    );

    const regrouped = {
      ...PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
      descriptors: PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1.descriptors.map(
        (descriptor, index) =>
          index === 0 ? { ...descriptor, section: "document" } : descriptor
      ),
    };
    expect(
      await computeCapabilityPresentationRevision(
        PDF_TEMPLATE_CAPABILITIES_V1,
        regrouped,
        PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1
      )
    ).not.toBe(PDF_TEMPLATE_PRESENTATION_REVISION_V1);
    expect(await computeCapabilityCatalogDigest(PDF_TEMPLATE_CAPABILITIES_V1)).toBe(
      PDF_TEMPLATE_CAPABILITY_DIGEST_V1
    );
  });

  it("gives every primary target one presentation and explicitly classifies every detail", () => {
    const catalogPaths = PDF_TEMPLATE_CAPABILITIES_V1.descriptors.map(({ path }) => path);
    const primary = PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1.descriptors.map(
      ({ target }) => target
    );
    expect(new Set(primary).size).toBe(primary.length);
    expect(new Set(PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1).size).toBe(
      PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1.length
    );
    expect([...primary, ...PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1].sort()).toEqual(
      [...catalogPaths].sort()
    );
  });

  it("round-trips and validates both complete curated baselines", () => {
    for (const manifest of [
      BUILTIN_PDF_TEMPLATE_MANIFEST,
      MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
    ]) {
      const design = manifest.design!;
      const flat = flattenDesign(design);
      expect(flattenDesign(unflattenDesign(flat))).toEqual(flat);
      expect(
        flattenDesign(validateCompleteBaseline(design, PDF_TEMPLATE_CAPABILITIES_V1))
      ).toEqual(flat);
      expect(
        flattenDesign(
          unflattenDesign(flattenDesign(projectPdfDesignThroughCatalog(design)))
        )
      ).toEqual(flat);
    }
  });

  it("fails a removed required baseline value at its exact path", () => {
    const design = structuredClone(BUILTIN_PDF_DESIGN);
    deletePath(design, "tokens.layout.paragraphSpacing");
    try {
      validateCompleteBaseline(design, PDF_TEMPLATE_CAPABILITIES_V1);
      throw new Error("expected incomplete baseline");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityValidationError);
      expect((error as CapabilityValidationError).reason).toBe(
        "incomplete-baseline"
      );
      expect((error as CapabilityValidationError).path).toBe(
        "tokens.layout.paragraphSpacing"
      );
    }
  });

  it("rejects an unconsumed authoring key and reports it in explicit legacy mode", () => {
    const design = structuredClone(BUILTIN_PDF_DESIGN);
    design.tokens.colors.unconsumed = "#FFFFFF";
    expect(() =>
      validateDesignAgainstCatalog(
        design,
        PDF_TEMPLATE_CAPABILITIES_V1,
        "authoring"
      )
    ).toThrow(/tokens\.colors\.unconsumed/);

    const legacy = validateDesignAgainstCatalog(
      design,
      PDF_TEMPLATE_CAPABILITIES_V1,
      "legacy"
    );
    expect(legacy.ignoredCapabilities).toEqual(["tokens.colors.unconsumed"]);
    expect("tokens.colors.unconsumed" in legacy.flat).toBe(false);
    expect(
      materializeLegacyPdfDesign(design, BUILTIN_PDF_DESIGN)
        .ignoredCapabilities
    ).toEqual(["tokens.colors.unconsumed"]);
  });

  it("keeps foreign sparse V1 readable but not canonical-executable", () => {
    const manifest = authoringManifest();
    deletePath(manifest.design, "tokens.layout.paragraphSpacing");
    expect(() => resolvePdfSettings({}, { manifest })).toThrow(
      expect.objectContaining({
        path: "tokens.layout.paragraphSpacing",
        constraint:
          "foreign sparse template is structurally readable but not canonical-executable",
      })
    );
  });

  it("reports and drops unknown leaves from a complete foreign legacy manifest", () => {
    const manifest = authoringManifest();
    manifest.design!.tokens.colors.unconsumed = "#FFFFFF";
    const resolved = resolvePdfSettings({}, { manifest });
    expect(resolved.ignoredDesignCapabilities).toEqual([
      "tokens.colors.unconsumed",
    ]);
    expect("unconsumed" in resolved.design.tokens.colors).toBe(false);
  });

  it("preserves raw presence semantics for every bindable Level-A setting", () => {
    const manifest = authoringManifest();
    const baseline = resolvePdfSettings({}, { manifest });
    expect(
      Object.values(baseline.settingPresence).every((present) => !present)
    ).toBe(true);
    expect(
      baseline.designTrace.every(({ source }) => source === "baseline")
    ).toBe(true);

    for (const setting of PDF_BINDABLE_LEVEL_A_SETTINGS) {
      const resolved = resolvePdfSettings(
        { [setting]: OVERRIDES[setting] },
        { manifest }
      );
      for (const candidate of PDF_BINDABLE_LEVEL_A_SETTINGS) {
        for (const target of BINDABLE_TARGETS[candidate]) {
          expect(readPath(resolved.design, target)).toEqual(
            candidate === setting
              ? OVERRIDES[setting]
              : readPath(manifest.design, target)
          );
        }
      }
      expect(resolved.settingPresence[setting]).toBe(true);
      expect(
        PDF_BINDABLE_LEVEL_A_SETTINGS.filter(
          (candidate) => candidate !== setting
        ).every((candidate) => !resolved.settingPresence[candidate])
      ).toBe(true);
      expect(
        resolved.designTrace
          .filter(({ source }) => source === "runtime-binding")
          .map(({ target }) => target)
          .sort()
      ).toEqual([...BINDABLE_TARGETS[setting]].sort());
    }
  });

  it("applies only explicitly present theme fields and records their policy trace", () => {
    const manifest = authoringManifest();
    const baseline = resolvePdfSettings({}, { manifest });
    expect(baseline.design.tokens.colors.ink).toBe("#202830");
    expect(baseline.design.tokens.colors.paper).toBe("#FAF7F0");
    expect(baseline.design.tokens.contrast.minimum).toBe(7);

    const partial = resolvePdfSettings(
      {},
      { manifest, theme: { colors: { ink: "#334455" } } }
    );
    expect(partial.design.tokens.colors.ink).toBe("#334455");
    expect(partial.design.tokens.colors.paper).toBe("#FAF7F0");
    expect(partial.design.tokens.contrast.minimum).toBe(7);
    expect(
      partial.designTrace.filter(({ source }) => source === "engine-policy")
    ).toEqual([
      expect.objectContaining({
        target: "tokens.colors.ink",
        sourceId: "theme.colors.ink",
        value: "#334455",
      }),
    ]);

    const nonDesignTheme = resolvePdfSettings(
      {},
      {
        manifest,
        theme: { table: { coloredCellText: { mode: "source" } } },
      }
    );
    expect(nonDesignTheme.design.tokens.colors.ink).toBe("#202830");
    expect(
      nonDesignTheme.designTrace.some(
        ({ source }) => source === "engine-policy"
      )
    ).toBe(false);
  });

  it("traces the one-time Manuscript presence fix to the exact former default writes", () => {
    const current = resolvePdfSettings(
      {},
      { manifest: MANUSCRIPT_PDF_TEMPLATE_MANIFEST }
    );
    expect(current.design.branding.accent).toBe("#0B6E4F");
    expect(current.design.tokens.colors.accent).toBe("#0B6E4F");
    expect(current.design.tokens.colors.ink).toBe("#1B2733");
    expect(current.design.tokens.colors.paper).toBe("#FBF9F4");
    expect(current.design.tokens.contrast.minimum).toBe(4.5);
    expect(
      current.designTrace
        .filter(({ target }) =>
          [
            "branding.accent",
            "tokens.colors.accent",
            "tokens.colors.ink",
            "tokens.colors.paper",
            "tokens.contrast.minimum",
          ].includes(target)
        )
        .every(({ source }) => source === "baseline")
    ).toBe(true);

    const formerDefaults = resolvePdfSettings(
      { accentColor: "#4B57A3" },
      {
        manifest: MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
        theme: {
          colors: { ink: "#172B4D", paper: "#FCFBF8" },
          table: { coloredCellText: { minimumContrast: 4.5 } },
        },
      }
    );
    expect(
      formerDefaults.designTrace
        .filter(({ source }) => source !== "baseline")
        .map(({ target, source, sourceId, value }) => ({
          target,
          source,
          sourceId,
          value,
        }))
    ).toEqual([
      {
        target: "branding.accent",
        source: "runtime-binding",
        sourceId: "setting.accentColor",
        value: "#4B57A3",
      },
      {
        target: "tokens.colors.accent",
        source: "runtime-binding",
        sourceId: "setting.accentColor",
        value: "#4B57A3",
      },
      {
        target: "tokens.colors.ink",
        source: "engine-policy",
        sourceId: "theme.colors.ink",
        value: "#172B4D",
      },
      {
        target: "tokens.colors.paper",
        source: "engine-policy",
        sourceId: "theme.colors.paper",
        value: "#FCFBF8",
      },
      {
        target: "tokens.contrast.minimum",
        source: "engine-policy",
        sourceId: "theme.table.coloredCellText.minimumContrast",
        value: 4.5,
      },
    ]);
  });

  it("allows no undeclared runtime-writer overlap in the production catalog", () => {
    expect(
      PDF_TEMPLATE_CAPABILITIES_V1.descriptors.filter(
        ({ runtimeWriters }) => (runtimeWriters?.length ?? 0) > 1
      )
    ).toEqual([]);
  });

  it("catalogs every binding allowlist target and every curated binding writer exactly once", () => {
    const descriptors = new Map(
      PDF_TEMPLATE_CAPABILITIES_V1.descriptors.map((descriptor) => [
        descriptor.path,
        descriptor,
      ])
    );
    for (const target of BINDING_TARGET_ALLOWLIST) {
      expect(descriptors.has(target), target).toBe(true);
    }

    for (const manifest of [
      BUILTIN_PDF_TEMPLATE_MANIFEST,
      MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
    ]) {
      for (const binding of manifest.bindings ?? []) {
        for (const target of binding.targets) {
          const descriptor = descriptors.get(target);
          expect(
            descriptor?.runtimeWriters?.filter(
              ({ id }) => id === `setting.${binding.setting}`
            )
          ).toHaveLength(1);
        }
      }
    }
  });

  it("fails direct unprojected design access and uncataloged literal paths in renderer owners", () => {
    const sources = [
      resolve(import.meta.dir, "template.ts"),
      resolve(import.meta.dir, "serialize.ts"),
      resolve(import.meta.dir, "settings.ts"),
      resolve(import.meta.dir, "theme.ts"),
      resolve(import.meta.dir, "../../template-pack/src/bindings.ts"),
    ].map((path) => readFileSync(path, "utf8"));
    const codeSources = sources.map((source) =>
      source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
    );
    const combined = codeSources.join("\n");
    expect(combined).not.toMatch(/\b(?:writer|context)\.design\./);
    expect(combined).not.toMatch(
      /\bdesign\.(?:branding|features|page|semanticPalettes|tokens|typography)\b/
    );
    expect(combined).not.toContain("BUILTIN_PDF_DESIGN.tokens");
    expect(combined).not.toContain("BUILTIN_PDF_DESIGN.semanticPalettes");

    const catalogPaths = new Set(
      PDF_TEMPLATE_CAPABILITIES_V1.descriptors.map(({ path }) => path)
    );
    const literalPath =
      /"((?:branding|features|page|semanticPalettes|tokens|typography)\.[A-Za-z0-9.]+)"/g;
    for (const source of codeSources) {
      for (const match of source.matchAll(literalPath)) {
        expect(catalogPaths.has(match[1]!), match[1]).toBe(true);
      }
      for (const match of source.matchAll(
        /designColor\([^)]*,\s*"([A-Za-z0-9]+)"\)/g
      )) {
        expect(
          catalogPaths.has(`tokens.colors.${match[1]}`),
          `tokens.colors.${match[1]}`
        ).toBe(true);
      }
      for (const match of source.matchAll(
        /designLength\([^)]*,\s*"([A-Za-z0-9]+)"\)/g
      )) {
        expect(
          catalogPaths.has(`tokens.layout.${match[1]}`),
          `tokens.layout.${match[1]}`
        ).toBe(true);
      }
    }

    const projectedChain =
      /(?:catalogDesign|writer\.catalogDesign|context\.catalogDesign)((?:\.[A-Za-z][A-Za-z0-9]*)+)/g;
    for (const source of sources) {
      for (const match of source.matchAll(projectedChain)) {
        const path = match[1]!.slice(1);
        expect(
          catalogPaths.has(path) ||
            [...catalogPaths].some((candidate) => candidate.startsWith(`${path}.`)),
          path
        ).toBe(true);
      }
    }
  });
});

describe("PDF template capability catalog V2", () => {
  it("pins V2 digests while preserving the complete V1 descriptor prefix", async () => {
    expect(await computeCapabilityCatalogDigest(PDF_TEMPLATE_CAPABILITIES_V1)).toBe(
      "d871153baebf8e1cc318736ea34103213882e5d9569aa0efc820b226753a885c"
    );
    expect(PDF_TEMPLATE_CAPABILITY_DIGEST_V1).toBe(
      "d871153baebf8e1cc318736ea34103213882e5d9569aa0efc820b226753a885c"
    );
    expect(PDF_TEMPLATE_PRESENTATION_REVISION_V1).toBe(
      "4b9725c298b76d2627ab45ccd061134a011b56d27837fd68d409dd0f0e6b246d"
    );
    expect(await computeCapabilityCatalogDigest(PDF_TEMPLATE_CAPABILITIES_V2)).toBe(
      PDF_TEMPLATE_CAPABILITY_DIGEST_V2
    );
    expect(
      await computeCapabilityPresentationRevision(
        PDF_TEMPLATE_CAPABILITIES_V2,
        PDF_TEMPLATE_CAPABILITY_PRESENTATION_V2,
        PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V2
      )
    ).toBe(PDF_TEMPLATE_PRESENTATION_REVISION_V2);
    expect(
      [...PDF_TEMPLATE_CAPABILITIES_V2.descriptors.slice(
        0,
        PDF_TEMPLATE_CAPABILITIES_V1.descriptors.length
      )]
    ).toEqual([...PDF_TEMPLATE_CAPABILITIES_V1.descriptors]);
  });

  it("makes every V2-only descriptor optional, singly consumed, and classified once", () => {
    const v1Paths = new Set(
      PDF_TEMPLATE_CAPABILITIES_V1.descriptors.map(({ path }) => path)
    );
    const v2Only = PDF_TEMPLATE_CAPABILITIES_V2.descriptors.filter(
      ({ path }) => !v1Paths.has(path)
    );
    const primary = new Set(
      PDF_TEMPLATE_CAPABILITY_PRESENTATION_V2.descriptors.map(({ target }) => target)
    );
    const details = new Set(PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V2);
    expect(v2Only.length).toBeGreaterThan(0);
    for (const descriptor of v2Only) {
      expect(descriptor.required, descriptor.path).toBe(false);
      expect(descriptor.consumers, descriptor.path).toEqual(["pdf.renderer"]);
      expect(
        Number(primary.has(descriptor.path)) + Number(details.has(descriptor.path)),
        descriptor.path
      ).toBe(1);
    }
  });

  it("keeps optional V2 leaves absent without weakening required V1 completeness", () => {
    const validation = validateDesignAgainstCatalog(
      BUILTIN_PDF_DESIGN,
      PDF_TEMPLATE_CAPABILITIES_V2,
      "authoring"
    );
    expect(validation.status).toBe("canonical-executable");
    expect(validation.missingCapabilities).toEqual([]);
  });

  it("isolates V1 reads from V2 leaves and validates the explicit V2 projection", () => {
    const design = structuredClone(BUILTIN_PDF_DESIGN);
    design.compositions = {
      cover: { kind: "standard", logo: "show" },
      closingPage: {
        kind: "document-summary",
        logo: "hide",
        website: "hide",
        legalNotice: "hide",
        align: "left",
      },
    };
    expect(() =>
      readPdfDesignCapability(design, "compositions.cover.kind")
    ).toThrow(/Unknown PDF design capability/);
    expect(
      readPdfDesignCapabilityV2<string>(design, "compositions.cover.kind")
    ).toBe("standard");
    expect(projectPdfDesignThroughCatalogV2(design).compositions).toEqual(
      design.compositions
    );
    expect(() => projectPdfDesignThroughCatalog(design)).toThrow(
      /compositions\./
    );
  });
});
