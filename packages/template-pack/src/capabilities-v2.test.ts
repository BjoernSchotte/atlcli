import { describe, expect, it } from "bun:test";
import {
  CapabilityValidationError,
  TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2,
  canonicalCapabilityCatalogV2,
  computeCapabilityCatalogDigestV2,
  evaluateCapabilityConstraintsV2,
  validateCapabilityCatalogV2,
  validateCompleteBaselineV2,
  validateDesignOverlayAgainstCatalogV2,
  type TemplateCapabilityCatalogV2
} from "./index.js";

function catalog(): TemplateCapabilityCatalogV2 {
  return {
    schema: TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2,
    id: "test.pdf.v3",
    version: 3,
    assets: ["asset.coverBackground", "asset.logo"],
    labels: ["coverEyebrow"],
    descriptors: [
      {
        path: "compositions.cover.kind",
        valueKind: "enum",
        enumValues: ["editorial", "type-cut"],
        required: true,
        owner: "template",
        consumers: ["pdf.renderer"],
        compilerRange: ">=0.15.1 <0.16",
        stability: "stable",
        proofs: ["contract", "canonical-source", "compile"]
      },
      {
        path: "compositions.cover.typeCut.angle",
        valueKind: "number",
        minimum: 0,
        maximum: 360,
        required: false,
        owner: "template",
        consumers: ["pdf.renderer"],
        compilerRange: ">=0.15.1 <0.16",
        stability: "stable",
        proofs: ["contract", "visual-pdf"]
      },
      {
        path: "compositions.closing.kind",
        valueKind: "enum",
        enumValues: ["editorial", "brand-lockup"],
        required: true,
        owner: "template",
        consumers: ["pdf.renderer"],
        stability: "stable",
        proofs: ["contract", "compile"]
      },
      {
        path: "metadata.direction",
        valueKind: "enum",
        enumValues: ["ltr", "rtl"],
        required: false,
        owner: "source",
        consumers: ["pdf.serializer"],
        stability: "stable",
        proofs: ["contract", "semantic-pdf"]
      },
      {
        path: "output.classification",
        valueKind: "string",
        required: false,
        owner: "export",
        consumers: ["pdf.renderer"],
        stability: "experimental",
        proofs: ["contract"]
      }
    ],
    constraints: [
      {
        when: [
          { path: "compositions.cover.kind", equals: "type-cut" },
          { path: "compositions.closing.kind", equals: "brand-lockup" }
        ],
        require: [
          { kind: "path", id: "compositions.cover.typeCut.angle" },
          { kind: "asset", id: "asset.coverBackground" },
          { kind: "asset", id: "asset.logo" },
          { kind: "label", id: "coverEyebrow" }
        ]
      }
    ]
  };
}

const completeDesign = {
  compositions: {
    cover: { kind: "type-cut", typeCut: { angle: 43 } },
    closing: { kind: "brand-lockup" }
  }
};

describe("template capability catalog V2", () => {
  it("validates ownership, compiler availability, stability, and proof metadata", () => {
    const value = catalog();
    expect(validateCapabilityCatalogV2(value)).toEqual(value);
    expect(
      validateDesignOverlayAgainstCatalogV2(
        { compositions: { cover: { typeCut: { angle: 52 } } } },
        value
      ).suppliedCapabilities
    ).toEqual(["compositions.cover.typeCut.angle"]);

    expect(() =>
      validateDesignOverlayAgainstCatalogV2({ output: { classification: "internal" } }, value)
    ).toThrow(/export-owned capability cannot appear in template design/);
  });

  it("requires only template-owned baseline leaves and rejects unknown overlays", () => {
    expect(validateCompleteBaselineV2(completeDesign, catalog())).toEqual(completeDesign);
    expect(() =>
      validateCompleteBaselineV2({ compositions: { cover: { kind: "type-cut" } } }, catalog())
    ).toThrow(/compositions\.closing\.kind: required capability is missing/);
    expect(() =>
      validateDesignOverlayAgainstCatalogV2(
        { compositions: { cover: { unboundedTypst: "show" } } },
        catalog()
      )
    ).toThrow(/unboundedTypst: is not declared/);
  });

  it("evaluates conjunctive path, asset, and label requirements", () => {
    expect(
      evaluateCapabilityConstraintsV2(completeDesign, catalog(), {
        assets: ["asset.coverBackground"],
        labels: [],
        compilerVersion: "0.15.1"
      })
    ).toEqual([
      {
        constraint: 0,
        effect: "required",
        target: { kind: "asset", id: "asset.logo" }
      },
      {
        constraint: 0,
        effect: "required",
        target: { kind: "label", id: "coverEyebrow" }
      }
    ]);

    expect(
      evaluateCapabilityConstraintsV2(completeDesign, catalog(), {
        assets: ["asset.coverBackground", "asset.logo"],
        labels: ["coverEyebrow"],
        compilerVersion: "0.15.1"
      })
    ).toEqual([]);
  });

  it("reports an unavailable compiler only for a supplied gated capability", () => {
    expect(
      evaluateCapabilityConstraintsV2(completeDesign, catalog(), {
        assets: ["asset.coverBackground", "asset.logo"],
        labels: ["coverEyebrow"],
        compilerVersion: "0.15.0"
      })
    ).toContainEqual({
      constraint: -1,
      effect: "compiler-unavailable",
      target: { kind: "path", id: "compositions.cover.kind" }
    });
  });

  it("rejects invalid predicates, requirements, duplicates, and contradictions", () => {
    const unknownPredicate = catalog();
    unknownPredicate.constraints = [
      {
        when: [{ path: "compositions.cover.unknown", equals: true }],
        require: [{ kind: "asset", id: "asset.logo" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(unknownPredicate)).toThrow(/unknown predicate path/);

    const wrongPredicate = catalog();
    wrongPredicate.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: true }],
        require: [{ kind: "asset", id: "asset.logo" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(wrongPredicate)).toThrow(
      /incompatible with the predicate capability/
    );

    const unknownAsset = catalog();
    unknownAsset.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        require: [{ kind: "asset", id: "asset.unknown" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(unknownAsset)).toThrow(/references an unknown asset/);

    const duplicate = catalog();
    duplicate.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        require: [
          { kind: "asset", id: "asset.logo" },
          { kind: "asset", id: "asset.logo" }
        ]
      }
    ];
    expect(() => validateCapabilityCatalogV2(duplicate)).toThrow(/contains a duplicate target/);

    const contradiction = catalog();
    contradiction.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        require: [{ kind: "asset", id: "asset.logo" }],
        forbid: [{ kind: "asset", id: "asset.logo" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(contradiction)).toThrow(
      /both requires and forbids asset:asset\.logo/
    );

    const duplicateConstraint = catalog();
    duplicateConstraint.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        require: [{ kind: "asset", id: "asset.logo" }]
      },
      {
        require: [{ kind: "asset", id: "asset.logo" }],
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(duplicateConstraint)).toThrow(
      /duplicates another constraint/
    );

    const splitContradiction = catalog();
    splitContradiction.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        require: [{ kind: "asset", id: "asset.logo" }]
      },
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        forbid: [{ kind: "asset", id: "asset.logo" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(splitContradiction)).toThrow(
      /contradicts require target asset:asset\.logo/
    );
  });

  it("rejects self-dependencies and cycles", () => {
    const self = catalog();
    self.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        require: [{ kind: "path", id: "compositions.cover.kind" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(self)).toThrow(/self-dependency/);

    const cycle = catalog();
    cycle.constraints = [
      {
        when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
        require: [{ kind: "path", id: "compositions.closing.kind" }]
      },
      {
        when: [{ path: "compositions.closing.kind", equals: "brand-lockup" }],
        require: [{ kind: "path", id: "compositions.cover.kind" }]
      }
    ];
    expect(() => validateCapabilityCatalogV2(cycle)).toThrow(/dependency cycle/);
  });

  it("rejects unsupported compiler ranges and unknown schema keys", () => {
    const invalidRange = catalog();
    invalidRange.descriptors = invalidRange.descriptors.map((descriptor, index) =>
      index === 0 ? { ...descriptor, compilerRange: "^0.15.1" } : descriptor
    );
    expect(() => validateCapabilityCatalogV2(invalidRange)).toThrow(
      /compilerRange: must be a supported semver range/
    );

    expect(() => validateCapabilityCatalogV2({ ...catalog(), typst: "raw" })).toThrow(
      /typst: is not allowed/
    );
  });

  it("produces one digest independent of descriptor, constraint, and nested ordering", async () => {
    const first = catalog();
    const reordered: TemplateCapabilityCatalogV2 = {
      constraints: [...first.constraints].reverse().map((constraint) => ({
        require: constraint.require ? [...constraint.require].reverse() : undefined,
        when: [...constraint.when].reverse()
      })),
      labels: first.labels ? [...first.labels].reverse() : undefined,
      assets: first.assets ? [...first.assets].reverse() : undefined,
      descriptors: [...first.descriptors].reverse().map((descriptor) => ({
        ...descriptor,
        consumers: [...descriptor.consumers].reverse(),
        proofs: [...descriptor.proofs].reverse(),
        enumValues: descriptor.enumValues ? [...descriptor.enumValues].reverse() : undefined
      })),
      version: first.version,
      id: first.id,
      schema: first.schema
    };
    expect(canonicalCapabilityCatalogV2(reordered)).toEqual(canonicalCapabilityCatalogV2(first));
    expect(await computeCapabilityCatalogDigestV2(reordered)).toBe(
      await computeCapabilityCatalogDigestV2(first)
    );
  });

  it("uses typed capability errors", () => {
    try {
      validateCapabilityCatalogV2({});
      throw new Error("expected catalog rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityValidationError);
      expect((error as CapabilityValidationError).reason).toBe("catalog-invalid");
    }
  });
});
