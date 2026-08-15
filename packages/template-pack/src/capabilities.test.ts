import { describe, expect, it } from "bun:test";
import {
  CapabilityValidationError,
  TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1,
  TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
  canonicalCapabilityJson,
  computeCapabilityCatalogDigest,
  computeCapabilityPresentationRevision,
  flattenDesign,
  unflattenDesign,
  validateCapabilityCatalogV1,
  validateCapabilityPresentationRegistryV1,
  validateCompleteBaseline,
  validateDesignAgainstCatalog,
  type TemplateCapabilityCatalogV1,
  type TemplateCapabilityPresentationRegistryV1,
} from "./capabilities.js";

const catalog = (): TemplateCapabilityCatalogV1 => ({
  schema: TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1,
  id: "test.pdf",
  version: 1,
  descriptors: [
    {
      path: "tokens.colors.ink",
      valueKind: "color",
      required: true,
      consumers: ["renderer"],
    },
    {
      path: "page.size",
      valueKind: "enum",
      enumValues: ["a4", "letter"],
      required: true,
      consumers: ["renderer"],
      runtimeWriters: [{ kind: "runtime-binding", id: "setting.page" }],
    },
  ],
});

const presentation = (): TemplateCapabilityPresentationRegistryV1 => ({
  schema: TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
  id: "test.pdf.primary",
  version: 1,
  descriptors: [
    {
      target: "page.size",
      section: "page",
      order: 0,
      messageCode: "ATLCLI_TEST_PAGE_SIZE",
      valueFormat: "text",
      comparisonKind: "exact",
      editKind: "choice",
    },
  ],
});

describe("template capability catalog V1", () => {
  it("rejects duplicate capabilities and undeclared multiple runtime writers by exact path", () => {
    const duplicate = catalog();
    duplicate.descriptors = [...duplicate.descriptors, duplicate.descriptors[0]!];
    expect(() => validateCapabilityCatalogV1(duplicate)).toThrow(
      new CapabilityValidationError(
        "catalog-invalid",
        "tokens.colors.ink: has more than one descriptor",
        "tokens.colors.ink"
      )
    );

    const overlap = catalog();
    overlap.descriptors = [
      {
        ...overlap.descriptors[0]!,
        runtimeWriters: [
          { kind: "runtime-binding", id: "setting.ink" },
          { kind: "engine-policy", id: "theme.colors.ink" },
        ],
      },
      overlap.descriptors[1]!,
    ];
    expect(() => validateCapabilityCatalogV1(overlap)).toThrow(
      /writeOrder: must declare every runtime writer exactly once/
    );
    overlap.descriptors = [
      {
        ...overlap.descriptors[0]!,
        writeOrder: ["setting.ink", "theme.colors.ink"],
      },
      overlap.descriptors[1]!,
    ];
    expect(validateCapabilityCatalogV1(overlap)).toBe(overlap);
  });

  it("requires exactly one primary presentation or an explicit details-only classification", () => {
    expect(validateCapabilityPresentationRegistryV1(catalog(), presentation(), [
      "tokens.colors.ink",
    ])).toEqual(presentation());

    expect(() =>
      validateCapabilityPresentationRegistryV1(catalog(), presentation(), [])
    ).toThrow(/tokens\.colors\.ink: must have exactly one presentation descriptor/);

    const duplicate = presentation();
    duplicate.descriptors = [...duplicate.descriptors, duplicate.descriptors[0]!];
    expect(() =>
      validateCapabilityPresentationRegistryV1(catalog(), duplicate, [
        "tokens.colors.ink",
      ])
    ).toThrow(/page\.size: has more than one presentation descriptor/);

    const unknown = presentation();
    unknown.descriptors = [{ ...unknown.descriptors[0]!, target: "page.unknown" }];
    expect(() =>
      validateCapabilityPresentationRegistryV1(catalog(), unknown, [
        "tokens.colors.ink",
      ])
    ).toThrow(/page\.unknown: presentation target is unknown/);
  });

  it("round-trips canonical flat/nested designs and rejects path conflicts", () => {
    const design = { tokens: { colors: { ink: "#172B4D" } }, page: { size: "a4" } };
    const flat = flattenDesign(design);
    expect(flat).toEqual({
      "page.size": "a4",
      "tokens.colors.ink": "#172B4D",
    });
    expect(flattenDesign(unflattenDesign(flat))).toEqual(flat);
    expect(canonicalCapabilityJson(unflattenDesign(flat))).toBe(
      canonicalCapabilityJson(design)
    );
    expect(() =>
      unflattenDesign({ page: "a4", "page.size": "letter" })
    ).toThrow(/conflicts with a leaf capability/);
  });

  it("rejects unknown authoring leaves and reports them without executing in legacy mode", () => {
    const design = {
      page: { size: "a4" },
      tokens: { colors: { ink: "#172B4D", unconsumed: "#FFFFFF" } },
    };
    try {
      validateDesignAgainstCatalog(design, catalog(), "authoring");
      throw new Error("expected authoring rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityValidationError);
      expect((error as CapabilityValidationError).reason).toBe("unknown-capability");
      expect((error as CapabilityValidationError).path).toBe(
        "tokens.colors.unconsumed"
      );
    }
    const legacy = validateDesignAgainstCatalog(design, catalog(), "legacy");
    expect(legacy.status).toBe("legacy-readable");
    expect(legacy.ignoredCapabilities).toEqual(["tokens.colors.unconsumed"]);
    expect("tokens.colors.unconsumed" in legacy.flat).toBe(false);
  });

  it("fails a missing required baseline at the exact capability path", () => {
    expect(() =>
      validateCompleteBaseline(
        { page: { size: "a4" }, tokens: { colors: {} } },
        catalog()
      )
    ).toThrow(/tokens\.colors\.ink: required capability is missing/);
  });

  it("digests logical catalog identity independent of object key order", async () => {
    const first = catalog();
    const reordered = {
      descriptors: first.descriptors.map((entry) => ({
        consumers: entry.consumers,
        required: entry.required,
        valueKind: entry.valueKind,
        path: entry.path,
        ...(entry.enumValues ? { enumValues: entry.enumValues } : {}),
        ...(entry.runtimeWriters ? { runtimeWriters: entry.runtimeWriters } : {}),
      })),
      version: first.version,
      id: first.id,
      schema: first.schema,
    } as TemplateCapabilityCatalogV1;
    expect(await computeCapabilityCatalogDigest(first)).toBe(
      await computeCapabilityCatalogDigest(reordered)
    );
  });

  it("presentation changes only its revision, never the runtime catalog digest", async () => {
    const runtimeDigest = await computeCapabilityCatalogDigest(catalog());
    const first = presentation();
    const regrouped: TemplateCapabilityPresentationRegistryV1 = {
      ...first,
      descriptors: first.descriptors.map((entry) => ({
        ...entry,
        section: "document",
      })),
    };
    expect(await computeCapabilityCatalogDigest(catalog())).toBe(runtimeDigest);
    expect(
      await computeCapabilityPresentationRevision(catalog(), first, [
        "tokens.colors.ink",
      ])
    ).not.toBe(
      await computeCapabilityPresentationRevision(catalog(), regrouped, [
        "tokens.colors.ink",
      ])
    );
  });
});
