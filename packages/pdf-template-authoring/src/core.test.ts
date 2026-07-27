import { describe, expect, test } from "bun:test";
import {
  TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1,
  TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
  canonicalCapabilityJson,
  computeCapabilityCatalogDigest,
  type TemplateCapabilityCatalogV1,
  type TemplateCapabilityPresentationRegistryV1,
} from "@atlcli/template-pack";
import {
  ACCEPT_RECOMMENDED_POLICY_V1,
  ACCEPT_SAFE_POLICY_V1,
  AUTHORING_MESSAGE_REGISTRY_V1,
  TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1,
  InMemoryTemplateAssetStore,
  InMemoryTemplatePreviewCompiler,
  InMemoryTemplateProjectRepository,
  TemplateAuthoringError,
  TemplateLayerConflictError,
  TemplateProjectGenerationConflictError,
  acceptRecommendedCandidates,
  acceptSafeCandidates,
  analyzeCandidatesAgainstCatalog,
  canonicalTemplateImportViewJson,
  createTemplateCandidate,
  createTemplateDecisionState,
  deriveRecommendedCandidates,
  deriveSafeCandidates,
  deriveSemanticReconciliationKey,
  diffTemplateLayers,
  projectTemplateImportView,
  reconcileTemplateDecisions,
  reduceTemplateDecision,
  reduceTemplateImportAction,
  resolveTemplateLayers,
  validateTemplateDiagnostic,
  validateTemplateImportProgressEvent,
  validateTemplateMessageOwnership,
  type AuthoringResolutionSnapshotV1,
  type CreateTemplateCandidateInputV1,
  type TemplateCandidateV1,
  type TemplateDecisionContextV1,
  type TemplateDecisionStateV1,
  type TemplateDiagnosticV1,
  type TemplateImportActionV1,
  type TemplateImportActionKindV1,
  type TemplateImportProjectionInputV1,
  type TemplateImportStageV1,
  type TemplateMessageRegistryV1,
  type TemplateMessageV1,
} from "./index.browser.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const catalog: TemplateCapabilityCatalogV1 = {
  schema: TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1,
  id: "test.pdf",
  version: 1,
  descriptors: [
    {
      path: "branding.accent",
      valueKind: "color",
      required: true,
      consumers: ["test"],
    },
    {
      path: "branding.organizationName",
      valueKind: "string",
      required: false,
      consumers: ["test"],
    },
    {
      path: "page.orientation",
      valueKind: "enum",
      enumValues: ["portrait", "landscape"],
      required: true,
      consumers: ["test"],
    },
    {
      path: "page.size",
      valueKind: "enum",
      enumValues: ["a4", "letter"],
      required: true,
      consumers: ["test"],
    },
    {
      path: "typography.fonts.body",
      valueKind: "font-family",
      required: true,
      consumers: ["test"],
    },
  ],
};

const presentation: TemplateCapabilityPresentationRegistryV1 = {
  schema: TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
  id: "test.pdf.presentation",
  version: 1,
  descriptors: [
    {
      target: "page.size",
      section: "page",
      order: 1,
      messageCode: "PDF_PAGE_SIZE",
      valueFormat: "text",
      comparisonKind: "exact",
      editKind: "choice",
    },
    {
      target: "page.orientation",
      section: "page",
      order: 2,
      messageCode: "PDF_PAGE_ORIENTATION",
      valueFormat: "text",
      comparisonKind: "exact",
      editKind: "choice",
    },
    {
      target: "branding.accent",
      section: "colors",
      order: 1,
      messageCode: "PDF_BRANDING_ACCENT",
      valueFormat: "color",
      comparisonKind: "visual",
      editKind: "color",
    },
    {
      target: "typography.fonts.body",
      section: "typography",
      order: 1,
      messageCode: "PDF_BODY_FONT",
      valueFormat: "font",
      comparisonKind: "visual",
      editKind: "font",
    },
    {
      target: "branding.organizationName",
      section: "details",
      order: 1,
      messageCode: "PDF_ORGANIZATION",
      valueFormat: "text",
      comparisonKind: "exact",
      editKind: "text",
    },
  ],
};

const baseline = {
  page: { size: "a4", orientation: "portrait" },
  branding: { accent: "#4F46E5", organizationName: "Baseline" },
  typography: { fonts: { body: "Inter" } },
};

let catalogDigest = "";
let context: TemplateDecisionContextV1;

async function initialize(): Promise<void> {
  if (catalogDigest) return;
  catalogDigest = await computeCapabilityCatalogDigest(catalog);
  context = {
    catalog,
    baseline,
    catalogDigest,
    sourceDigest: HASH_A,
    importerVersion: "1",
    mappingVersion: "1",
  };
}

async function candidate(
  overrides: Partial<CreateTemplateCandidateInputV1> = {}
): Promise<TemplateCandidateV1> {
  await initialize();
  const base: CreateTemplateCandidateInputV1 = {
    analysisDigest: HASH_A,
    ordinal: 0,
    semanticKey: "semantic.page",
    group: { id: "group.page", cardinality: "zero-or-one", atomic: true },
    writes: [
      { target: "page.size", value: "letter" },
      { target: "page.orientation", value: "landscape" },
    ],
    rank: 100,
    kind: "token",
    valueNature: "source-explicit",
    confidence: "conclusive",
    compatibility: "native",
    adoption: "safe",
    evidence: [
      { id: "evidence.page", partRef: "document", locator: "section.0" },
    ],
    rule: { id: "page-master", version: "1" },
    explanations: [],
    diagnostics: [],
  };
  return createTemplateCandidate({ ...base, ...overrides });
}

async function acceptedState(
  value = "letter",
  origin: "policy" | "user" = "user"
): Promise<{ state: TemplateDecisionStateV1; candidate: TemplateCandidateV1 }> {
  await initialize();
  const valueCandidate = await candidate({
    writes: [{ target: "page.size", value }],
    group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
  });
  const decidedBy =
    origin === "user"
      ? ({ kind: "user" } as const)
      : ({
          kind: "policy",
          id: ACCEPT_SAFE_POLICY_V1.id,
          version: ACCEPT_SAFE_POLICY_V1.version,
          inputDigest: HASH_B,
        } as const);
  return {
    candidate: valueCandidate,
    state: reduceTemplateDecision(
      createTemplateDecisionState(),
      { kind: "accept-candidate", candidate: valueCandidate, decidedBy },
      context
    ),
  };
}

async function snapshotFor(
  decisions: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[] = []
): Promise<AuthoringResolutionSnapshotV1> {
  await initialize();
  return resolveTemplateLayers({
    catalog,
    catalogDigest,
    baseline: { id: "editorial", version: "1", design: baseline },
    sourceDigest: context.sourceDigest,
    decisions,
    candidates,
    mappingVersion: context.mappingVersion,
  });
}

async function projection(
  decisions: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[],
  options: Partial<TemplateImportProjectionInputV1> = {}
): Promise<TemplateImportProjectionInputV1> {
  const snapshot = options.snapshot ?? (await snapshotFor(decisions, candidates));
  return {
    generation: "generation-1",
    analysisDigest: HASH_A,
    baseline,
    candidates,
    decisions,
    snapshot,
    catalog,
    presentation,
    diagnostics: [],
    inventoryDiagnosticCodes: [],
    previewDigest: snapshot.snapshotDigest,
    hasHistory: false,
    ...options,
  };
}

describe("candidate identities and canonical inputs", () => {
  test("derives independent local, source, candidate, and semantic identities", async () => {
    const first = await candidate();
    const newLocalHandle = await candidate({ ordinal: 1 });
    const movedSource = await candidate({
      evidence: [
        { id: "evidence.page", partRef: "document", locator: "section.1" },
      ],
    });
    const changedWrite = await candidate({
      writes: [{ target: "page.size", value: "a4" }],
    });

    expect(newLocalHandle.id).not.toBe(first.id);
    expect(newLocalHandle.candidateFingerprint).toBe(
      first.candidateFingerprint
    );
    expect(newLocalHandle.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(movedSource.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(movedSource.candidateFingerprint).not.toBe(
      first.candidateFingerprint
    );
    expect(changedWrite.candidateFingerprint).not.toBe(
      first.candidateFingerprint
    );
    expect(
      await deriveSemanticReconciliationKey({
        ruleId: "page-master",
        concept: "page",
        scope: "document",
      })
    ).toBe(
      await deriveSemanticReconciliationKey({
        scope: "document",
        concept: "page",
        ruleId: "page-master",
      })
    );
  });

  test("catalog analysis classifies invalid and safe candidates without mutation", async () => {
    const safe = await candidate({
      writes: [{ target: "page.size", value: "letter" }],
    });
    const invalid = await candidate({
      ordinal: 1,
      writes: [{ target: "page.size", value: "tabloid" }],
    });
    const state = createTemplateDecisionState();
    const before = canonicalCapabilityJson([state, safe, invalid]);
    const analysis = analyzeCandidatesAgainstCatalog(
      state,
      [invalid, safe],
      context
    );
    expect(analysis.valid.map(({ id }) => id)).toEqual([safe.id]);
    expect(analysis.invalidCandidateIds).toEqual([invalid.id]);
    expect(analysis.safeCandidateIds).toEqual([safe.id]);
    expect(canonicalCapabilityJson([state, safe, invalid])).toBe(before);
  });
});

describe("explicit authoring layers", () => {
  test("baseline-only is complete and every trace entry is baseline", async () => {
    const snapshot = await snapshotFor(createTemplateDecisionState());
    expect(snapshot.design).toEqual(baseline);
    expect(Object.values(snapshot.trace)).toHaveLength(5);
    expect(new Set(Object.values(snapshot.trace).map(({ source }) => source))).toEqual(
      new Set(["baseline"])
    );
    expect(snapshot.staleness).toEqual([]);
  });

  test("override wins and clear-override exposes the frozen candidate again", async () => {
    const { state, candidate: valueCandidate } = await acceptedState("letter");
    const overridden = reduceTemplateDecision(
      state,
      { kind: "override", target: "page.size", value: "a4" },
      context
    );
    const overrideSnapshot = await snapshotFor(overridden, [valueCandidate]);
    expect((overrideSnapshot.design.page as { size: string }).size).toBe("a4");
    expect(overrideSnapshot.trace["page.size"]?.source).toBe("override");

    const cleared = reduceTemplateDecision(
      overridden,
      { kind: "clear-override", target: "page.size" },
      context
    );
    const candidateSnapshot = await snapshotFor(cleared, [valueCandidate]);
    expect((candidateSnapshot.design.page as { size: string }).size).toBe(
      "letter"
    );
    expect(candidateSnapshot.trace["page.size"]?.source).toBe("candidate");
  });

  test("equal-rank unequal writes report deterministic ambiguity", async () => {
    const left = await candidate({
      semanticKey: "semantic.left",
      group: { id: "group.left", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.accent", value: "#112233" }],
    });
    const right = await candidate({
      ordinal: 1,
      semanticKey: "semantic.right",
      group: { id: "group.right", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.accent", value: "#445566" }],
    });
    const accept = (order: readonly TemplateCandidateV1[]) =>
      order.reduce(
        (state, item) =>
          reduceTemplateDecision(
            state,
            { kind: "accept-candidate", candidate: item, decidedBy: { kind: "user" } },
            context
          ),
        createTemplateDecisionState()
      );
    const errors: TemplateLayerConflictError[] = [];
    for (const order of [
      [left, right],
      [right, left],
    ]) {
      try {
        await snapshotFor(accept(order), order);
      } catch (error) {
        expect(error).toBeInstanceOf(TemplateLayerConflictError);
        errors.push(error as TemplateLayerConflictError);
      }
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]?.conflicts).toEqual(errors[1]?.conflicts);
    expect(errors[0]?.conflicts[0]?.kind).toBe("ambiguous-conflict");
  });

  test("an atomic candidate writes all targets or leaves state untouched", async () => {
    const atomic = await candidate();
    const state = reduceTemplateDecision(
      createTemplateDecisionState(),
      { kind: "accept-candidate", candidate: atomic, decidedBy: { kind: "user" } },
      context
    );
    const snapshot = await snapshotFor(state, [atomic]);
    expect(snapshot.design.page).toEqual({
      orientation: "landscape",
      size: "letter",
    });

    const invalid = {
      ...atomic,
      candidateFingerprint: HASH_C,
      writes: [
        { target: "page.size", value: "letter" },
        { target: "page.orientation", value: "diagonal" },
      ],
    };
    const initial = createTemplateDecisionState();
    expect(() =>
      reduceTemplateDecision(
        initial,
        {
          kind: "accept-candidate",
          candidate: invalid,
          decidedBy: { kind: "user" },
        },
        context
      )
    ).toThrow();
    expect(initial).toEqual(createTemplateDecisionState());
  });

  test("diff reports only changed effective targets and their source", async () => {
    const { state, candidate: valueCandidate } = await acceptedState();
    const snapshot = await snapshotFor(state, [valueCandidate]);
    expect(diffTemplateLayers(baseline, snapshot)).toEqual([
      {
        target: "page.size",
        baseline: "a4",
        effective: "letter",
        source: "candidate",
      },
    ]);
  });
});

describe("tombstones, rejection, and policy boundaries", () => {
  test("specific and wildcard tombstones block policy and reset exactly", async () => {
    const first = await candidate({
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.size", value: "letter" }],
    });
    const sameMeaningNewId = await candidate({
      ordinal: 9,
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.size", value: "letter" }],
    });
    expect(sameMeaningNewId.id).not.toBe(first.id);
    let state = reduceTemplateDecision(
      createTemplateDecisionState(),
      {
        kind: "use-baseline",
        semanticKey: first.semanticKey,
        scope: { kind: "target", target: "page.size" },
      },
      context
    );
    state = await acceptRecommendedCandidates(state, [sameMeaningNewId], context);
    expect(state.decisions.some(({ kind }) => kind === "accept-candidate")).toBe(
      false
    );
    const neighboringMeaning = await candidate({
      ordinal: 10,
      semanticKey: "semantic.neighbor",
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
      evidence: [
        { id: "evidence.neighbor", partRef: "document", locator: "section.2" },
      ],
      writes: [{ target: "page.size", value: "letter" }],
    });
    state = await acceptRecommendedCandidates(
      state,
      [neighboringMeaning],
      context
    );
    expect(
      state.decisions.some(
        (decision) =>
          decision.kind === "accept-candidate" &&
          decision.semanticKey === neighboringMeaning.semanticKey
      )
    ).toBe(true);

    state = reduceTemplateDecision(
      state,
      {
        kind: "use-baseline",
        semanticKey: "*",
        scope: { kind: "group", groupId: "group.size" },
      },
      context
    );
    const futureMeaning = await candidate({
      ordinal: 11,
      semanticKey: "semantic.future",
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
      evidence: [
        { id: "evidence.future", partRef: "document", locator: "section.3" },
      ],
      writes: [{ target: "page.size", value: "letter" }],
    });
    state = await acceptRecommendedCandidates(state, [futureMeaning], context);
    expect(state.decisions.some(({ kind }) => kind === "accept-candidate")).toBe(
      false
    );
    state = reduceTemplateDecision(
      state,
      {
        kind: "override",
        target: "branding.accent",
        value: "#112233",
      },
      context
    );
    const reset = reduceTemplateDecision(
      state,
      {
        kind: "reset-tombstone",
        semanticKey: first.semanticKey,
        scope: { kind: "target", target: "page.size" },
      },
      context
    );
    expect(
      reset.decisions.filter(({ kind }) => kind === "use-baseline")
    ).toHaveLength(1);
    expect(reset.decisions.some(({ kind }) => kind === "override")).toBe(true);
  });

  test("reject-candidate is fingerprint-exact, stable, and leaves alternatives", async () => {
    const rejected = await candidate({
      writes: [{ target: "page.size", value: "letter" }],
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
    });
    const alternative = await candidate({
      ordinal: 1,
      evidence: [
        { id: "evidence.page.2", partRef: "document", locator: "section.1" },
      ],
      writes: [{ target: "page.size", value: "letter" }],
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
    });
    const state = reduceTemplateDecision(
      createTemplateDecisionState(),
      { kind: "reject-candidate", candidate: rejected },
      context
    );
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(deriveSafeCandidates(state, [rejected, alternative], context)).toEqual([
      alternative,
    ]);
    const view = projectTemplateImportView(
      await projection(state, [rejected, alternative])
    );
    expect(view.sections[0]?.items[0]?.details.candidateIds).toEqual([
      alternative.id,
    ]);
  });

  test("safe and recommended policies have distinct, versioned sets", async () => {
    const safe = await candidate({
      ordinal: 1,
      semanticKey: "semantic.safe",
      group: { id: "group.safe", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.accent", value: "#112233" }],
    });
    const corroborated = await candidate({
      ordinal: 2,
      semanticKey: "semantic.corroborated",
      group: {
        id: "group.corroborated",
        cardinality: "zero-or-one",
        atomic: true,
      },
      writes: [{ target: "typography.fonts.body", value: "Arial" }],
      confidence: "corroborated",
      adoption: "review",
    });
    const derived = await candidate({
      ordinal: 8,
      semanticKey: "semantic.derived",
      group: { id: "group.derived", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.orientation", value: "landscape" }],
      valueNature: "source-derived",
    });
    const asset = await candidate({
      ordinal: 3,
      semanticKey: "semantic.asset",
      group: { id: "group.asset", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.organizationName", value: "Logo" }],
      kind: "asset",
    });
    const font = await candidate({
      ordinal: 4,
      semanticKey: "semantic.font",
      group: { id: "group.font", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.organizationName", value: "Custom Font" }],
      kind: "font",
    });
    const conversion = await candidate({
      ordinal: 5,
      semanticKey: "semantic.convert",
      group: { id: "group.convert", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.size", value: "letter" }],
      compatibility: "needs-conversion",
    });
    const blocked = await candidate({
      ordinal: 6,
      semanticKey: "semantic.blocked",
      group: { id: "group.blocked", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.orientation", value: "landscape" }],
      confidence: "blocked",
      adoption: "blocked",
    });
    const invalid = await candidate({
      ordinal: 7,
      semanticKey: "semantic.invalid",
      group: { id: "group.invalid", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.orientation", value: "diagonal" }],
    });
    const candidates = [
      safe,
      derived,
      corroborated,
      asset,
      font,
      conversion,
      blocked,
      invalid,
    ];
    expect(
      deriveSafeCandidates(createTemplateDecisionState(), candidates, context)
    ).toEqual(
      [safe, derived].sort((left, right) =>
        left.candidateFingerprint.localeCompare(right.candidateFingerprint)
      )
    );
    expect(
      new Set(
        deriveRecommendedCandidates(
          createTemplateDecisionState(),
          candidates,
          context
        ).map(({ id }) => id)
      )
    ).toEqual(new Set([safe.id, derived.id, corroborated.id]));

    const safeState = await acceptSafeCandidates(
      createTemplateDecisionState(),
      candidates,
      context
    );
    const recommendedState = await acceptRecommendedCandidates(
      createTemplateDecisionState(),
      candidates,
      context
    );
    expect(
      safeState.decisions.filter(({ kind }) => kind === "accept-candidate")
    ).toHaveLength(2);
    expect(
      recommendedState.decisions.filter(
        ({ kind }) => kind === "accept-candidate"
      )
    ).toHaveLength(3);
    for (const decision of recommendedState.decisions) {
      if (decision.kind !== "accept-candidate") continue;
      expect(decision.decidedBy.kind).toBe("policy");
      if (decision.decidedBy.kind === "policy") {
        expect(
          [
            ACCEPT_SAFE_POLICY_V1.id,
            ACCEPT_RECOMMENDED_POLICY_V1.id,
          ].includes(
            decision.decidedBy.id as
              | typeof ACCEPT_SAFE_POLICY_V1.id
              | typeof ACCEPT_RECOMMENDED_POLICY_V1.id
          )
        ).toBe(true);
        expect(decision.decidedBy.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(decision).not.toHaveProperty("timestamp");
    }
  });

  test("user decisions do not invent policy origin or timestamps", async () => {
    const { state } = await acceptedState("letter", "user");
    const accepted = state.decisions.find(
      ({ kind }) => kind === "accept-candidate"
    );
    expect(accepted).toMatchObject({ decidedBy: { kind: "user" } });
    expect(accepted).not.toHaveProperty("timestamp");
    expect(accepted).not.toHaveProperty("decidedBy.id");
  });
});

describe("asset decisions", () => {
  test("requires role, rights, accessibility, rendering, and local-exact placement", async () => {
    const asset = await candidate({
      kind: "asset",
      semanticKey: "semantic.logo",
      group: { id: "group.logo", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.organizationName", value: "Logo" }],
      layoutDependent: true,
    });
    const command = {
      kind: "accept-asset" as const,
      candidate: asset,
      assetSha256: HASH_B,
      role: "asset.logo",
      rightsConfirmed: true,
      accessibility: { decorative: false, alt: "Company logo" },
      rendering: { kind: "slot-default" as const },
    };
    expect(
      reduceTemplateDecision(createTemplateDecisionState(), command, context)
        .decisions[0]
    ).toMatchObject({
      kind: "accept-asset",
      role: "asset.logo",
      rightsConfirmed: true,
    });
    for (const invalid of [
      { ...command, role: "" },
      { ...command, rightsConfirmed: false },
      {
        ...command,
        accessibility: { decorative: false as const, alt: "" },
      },
      {
        ...command,
        rendering: {
          kind: "candidate-placement" as const,
          placement: { x: 1 },
        },
      },
    ]) {
      expect(() =>
        reduceTemplateDecision(
          createTemplateDecisionState(),
          invalid,
          context
        )
      ).toThrow(TemplateAuthoringError);
    }
  });
});

describe("reanalysis and frozen values", () => {
  test("proves all six staleness states without changing decisions", async () => {
    const { state, candidate: original } = await acceptedState();
    const frozen = canonicalCapabilityJson(state);
    const changed = await candidate({
      ordinal: 4,
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.size", value: "a4" }],
    });
    const sameValueNewSource = await candidate({
      analysisDigest: HASH_B,
      ordinal: 5,
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.size", value: "letter" }],
    });
    const cases = [
      {
        expected: "current",
        input: {
          candidates: [original],
          sourceDigest: HASH_A,
          mappingVersion: "1",
          catalogDigest,
        },
      },
      {
        expected: "candidate-changed",
        input: {
          candidates: [changed],
          sourceDigest: HASH_A,
          mappingVersion: "1",
          catalogDigest,
        },
      },
      {
        expected: "candidate-missing",
        input: {
          candidates: [],
          sourceDigest: HASH_A,
          mappingVersion: "1",
          catalogDigest,
        },
      },
      {
        expected: "mapping-changed",
        input: {
          candidates: [original],
          sourceDigest: HASH_A,
          mappingVersion: "2",
          catalogDigest,
        },
      },
      {
        expected: "source-changed-same-value",
        input: {
          candidates: [sameValueNewSource],
          sourceDigest: HASH_B,
          mappingVersion: "1",
          catalogDigest,
        },
      },
      {
        expected: "catalog-migration-required",
        input: {
          candidates: [original],
          sourceDigest: HASH_A,
          mappingVersion: "1",
          catalogDigest: HASH_C,
        },
      },
    ] as const;
    for (const item of cases) {
      const result = reconcileTemplateDecisions(state, item.input);
      expect(result.staleness[0]?.state).toBe(item.expected);
      expect(result.decisions).toBe(state);
      expect(canonicalCapabilityJson(state)).toBe(frozen);
    }
  });
});

describe("typed messages", () => {
  test("requires exactly one owning registry and exact bounded parameters", () => {
    const valid = {
      code: "AUTHORING_REVIEW_REQUIRED",
      params: { count: 2 },
    };
    expect(() =>
      validateTemplateMessageOwnership(valid, [
        AUTHORING_MESSAGE_REGISTRY_V1,
      ])
    ).not.toThrow();
    expect(() =>
      validateTemplateMessageOwnership(
        valid,
        [
          AUTHORING_MESSAGE_REGISTRY_V1,
          {
            ...AUTHORING_MESSAGE_REGISTRY_V1,
            id: "duplicate.owner",
          },
        ]
      )
    ).toThrow();
    const invalidMessages: TemplateMessageV1[] = [
      { code: "UNKNOWN", params: {} },
      {
        code: "AUTHORING_REVIEW_REQUIRED",
        params: { count: "2" },
      },
      {
        code: "AUTHORING_REVIEW_REQUIRED",
        params: { count: 2, extra: true },
      },
      {
        code: "AUTHORING_SOURCE_CHANGED",
        params: { state: "x".repeat(65) },
      },
      {
        code: "AUTHORING_SOURCE_CHANGED",
        params: { state: "https://private.example/a" },
      },
      {
        code: "AUTHORING_SOURCE_CHANGED",
        params: { state: "<strong>changed</strong>" },
      },
      {
        code: "AUTHORING_SOURCE_CHANGED",
        params: { state: "\u001b[31mchanged" },
      },
    ];
    for (const invalid of invalidMessages) {
      expect(() =>
        validateTemplateMessageOwnership(invalid, [
          AUTHORING_MESSAGE_REGISTRY_V1,
        ])
      ).toThrow();
    }
  });

  test("blocking diagnostics require recovery unless unreadable", () => {
    const recoverable: TemplateDiagnosticV1 = {
      code: "AUTHORING_SOURCE_CHANGED",
      params: { state: "candidate-changed" },
      severity: "error",
      recoveryActions: ["reanalyze"],
    };
    expect(() =>
      validateTemplateDiagnostic(recoverable, [
        AUTHORING_MESSAGE_REGISTRY_V1,
      ])
    ).not.toThrow();
    expect(() =>
      validateTemplateDiagnostic(
        { ...recoverable, recoveryActions: [] },
        [AUTHORING_MESSAGE_REGISTRY_V1]
      )
    ).toThrow();
    expect(() =>
      validateTemplateDiagnostic(
        {
          code: "AUTHORING_SOURCE_UNREADABLE",
          params: { technicalRef: "support.ref.1" },
          severity: "error",
          recoveryActions: [],
          technicalRef: "support.ref.1",
        },
        [AUTHORING_MESSAGE_REGISTRY_V1]
      )
    ).not.toThrow();
  });

  test("unknown code ownership is rejected even with a structurally valid registry", () => {
    const otherRegistry: TemplateMessageRegistryV1 = {
      schema: "wiki.pdf-template-message-registry/v1",
      id: "other",
      version: 1,
      definitions: [],
    };
    expect(() =>
      validateTemplateMessageOwnership(
        { code: "OTHER_CODE", params: {} },
        [otherRegistry]
      )
    ).toThrow();
  });

  test("progress events are bounded, host-neutral, and registry-backed", () => {
    expect(() =>
      validateTemplateImportProgressEvent(
        {
          schema: TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1,
          operationId: "import.1",
          phase: "matching",
          completed: 2,
          total: 4,
          detailCode: "AUTHORING_REVIEW_REQUIRED",
          detailParams: { count: 2 },
        },
        [AUTHORING_MESSAGE_REGISTRY_V1]
      )
    ).not.toThrow();
    for (const invalid of [
      {
        schema: TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1,
        operationId: "import.1",
        phase: "matching" as const,
        completed: 5,
        total: 4,
      },
      {
        schema: TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1,
        operationId: "import.1",
        phase: "opening" as const,
        completed: 0,
        total: null,
        detailParams: { count: 2 },
      },
    ]) {
      expect(() =>
        validateTemplateImportProgressEvent(invalid)
      ).toThrow(TemplateAuthoringError);
    }
  });
});

describe("host-neutral journey projection and actions", () => {
  test("labels only the safe set ready and keeps recommended in expert APIs", async () => {
    const safe = await candidate({
      semanticKey: "semantic.safe",
      group: { id: "group.safe", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.accent", value: "#112233" }],
    });
    const review = await candidate({
      ordinal: 2,
      semanticKey: "semantic.review",
      group: { id: "group.review", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "typography.fonts.body", value: "Arial" }],
      confidence: "corroborated",
      adoption: "review",
    });
    const view = projectTemplateImportView(
      await projection(createTemplateDecisionState(), [review, safe])
    );
    expect(view.summary).toMatchObject({
      readyToApply: 1,
      needsReview: 1,
      unanswered: 2,
    });
    expect(
      view.availableActions.find(({ kind }) => kind === "apply-ready")
    ).toMatchObject({ enabled: true, affectedItems: 1 });
    expect(canonicalTemplateImportViewJson(view)).not.toContain(
      "accept-recommend"
    );
    expect(
      deriveRecommendedCandidates(
        createTemplateDecisionState(),
        [safe, review],
        context
      )
    ).toHaveLength(2);
  });

  test("is byte-stable across candidate order and has no locale input", async () => {
    const left = await candidate({
      semanticKey: "semantic.left",
      group: { id: "group.left", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.accent", value: "#112233" }],
    });
    const right = await candidate({
      ordinal: 1,
      semanticKey: "semantic.right",
      group: { id: "group.right", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "typography.fonts.body", value: "Arial" }],
      confidence: "corroborated",
      adoption: "review",
    });
    const state = createTemplateDecisionState();
    const first = projectTemplateImportView(
      await projection(state, [left, right])
    );
    const second = projectTemplateImportView(
      await projection(state, [right, left])
    );
    expect(canonicalTemplateImportViewJson(first)).toBe(
      canonicalTemplateImportViewJson(second)
    );
    expect(canonicalTemplateImportViewJson(first)).not.toMatch(
      /ansi|html|locale/i
    );
  });

  test("disabled actions are rejected by the reducer", async () => {
    const valueCandidate = await candidate({
      writes: [{ target: "page.size", value: "letter" }],
    });
    const decisions = createTemplateDecisionState();
    const projectionInput = await projection(decisions, [valueCandidate]);
    await expect(
      reduceTemplateImportAction(
        decisions,
        { id: "action:build", kind: "build" },
        { projection: projectionInput, decisionContext: context }
      )
    ).rejects.toBeInstanceOf(TemplateAuthoringError);
  });

  test("individual, preview, build, reanalysis, asset, and undo actions share reducer semantics", async () => {
    const valueCandidate = await candidate({
      semanticKey: "semantic.size",
      group: { id: "group.size", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.size", value: "letter" }],
    });
    const initial = createTemplateDecisionState();
    const initialProjection = await projection(initial, [valueCandidate], {
      hasHistory: true,
    });
    const initialView = projectTemplateImportView(initialProjection);
    const item = initialView.sections
      .flatMap(({ items }) => items)
      .find(({ semanticKey }) => semanticKey === valueCandidate.semanticKey);
    const itemActionId = (kind: string): string =>
      item?.actions.find((entry) => entry.kind === kind)?.id ?? "";

    const accepted = await reduceTemplateImportAction(
      initial,
      {
        id: itemActionId("use-word-value"),
        kind: "use-word-value",
        candidateId: valueCandidate.id,
      },
      { projection: initialProjection, decisionContext: context }
    );
    expect(
      accepted.decisions.some(({ kind }) => kind === "accept-candidate")
    ).toBe(true);

    const kept = await reduceTemplateImportAction(
      initial,
      {
        id: itemActionId("keep-current-design"),
        kind: "keep-current-design",
        semanticKey: valueCandidate.semanticKey,
        scope: { kind: "group", groupId: valueCandidate.group.id },
      },
      { projection: initialProjection, decisionContext: context }
    );
    expect(kept.decisions.some(({ kind }) => kind === "use-baseline")).toBe(
      true
    );

    const customized = await reduceTemplateImportAction(
      initial,
      {
        id: itemActionId("customize"),
        kind: "customize",
        target: "page.size",
        value: "letter",
      },
      { projection: initialProjection, decisionContext: context }
    );
    expect(customized.decisions.some(({ kind }) => kind === "override")).toBe(
      true
    );
    await expect(
      reduceTemplateImportAction(
        initial,
        {
          id: itemActionId("customize"),
          kind: "customize",
          target: "branding.accent",
          value: "#112233",
        },
        { projection: initialProjection, decisionContext: context }
      )
    ).rejects.toBeInstanceOf(TemplateAuthoringError);

    const decidedProjection = await projection(kept, [valueCandidate]);
    const previewed = await reduceTemplateImportAction(
      kept,
      { id: "action:preview", kind: "preview" },
      { projection: decidedProjection, decisionContext: context }
    );
    const previewProjection = await projection(previewed, [valueCandidate]);
    const built = await reduceTemplateImportAction(
      previewed,
      { id: "action:build", kind: "build" },
      { projection: previewProjection, decisionContext: context }
    );
    expect(
      projectTemplateImportView(
        await projection(built, [valueCandidate])
      ).stage
    ).toBe("built");
    const reanalyzed = await reduceTemplateImportAction(
      built,
      { id: "action:reanalyze", kind: "reanalyze" },
      {
        projection: await projection(built, [valueCandidate]),
        decisionContext: context,
      }
    );
    expect(reanalyzed.preview).toEqual({});
    expect(reanalyzed.builtFromDigest).toBeUndefined();

    const undone = await reduceTemplateImportAction(
      built,
      { id: "action:undo", kind: "undo", previousState: initial },
      {
        projection: await projection(built, [valueCandidate], {
          hasHistory: true,
        }),
        decisionContext: context,
      }
    );
    expect(undone).toEqual(initial);

    const asset = await candidate({
      ordinal: 10,
      semanticKey: "semantic.logo",
      group: { id: "group.logo", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.organizationName", value: "Logo" }],
      kind: "asset",
      adoption: "review",
    });
    const assetProjection = await projection(initial, [asset]);
    const assetView = projectTemplateImportView(assetProjection);
    const assetActionId =
      assetView.sections
        .flatMap(({ items }) => items)
        .flatMap(({ actions }) => actions)
        .find(({ kind }) => kind === "review-asset")?.id ?? "";
    const withAsset = await reduceTemplateImportAction(
      initial,
      {
        id: assetActionId,
        kind: "review-asset",
        candidateId: asset.id,
        assetSha256: HASH_B,
        role: "asset.logo",
        rightsConfirmed: true,
        accessibility: { decorative: true },
        rendering: { kind: "slot-default" },
      },
      { projection: assetProjection, decisionContext: context }
    );
    expect(withAsset.decisions.some(({ kind }) => kind === "accept-asset")).toBe(
      true
    );
  });

  test("keep-current-for-remaining persists tombstones and retains inventory", async () => {
    const ready = await candidate({
      semanticKey: "semantic.ready",
      group: { id: "group.ready", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "branding.accent", value: "#112233" }],
    });
    const unsupported = await candidate({
      ordinal: 2,
      semanticKey: "semantic.unsupported",
      group: {
        id: "group.unsupported",
        cardinality: "zero-or-one",
        atomic: true,
      },
      writes: [{ target: "branding.organizationName", value: "Shape" }],
      compatibility: "unsupported",
      confidence: "blocked",
      adoption: "blocked",
    });
    let decisions = createTemplateDecisionState();
    let projectionInput = await projection(decisions, [ready, unsupported], {
      inventoryDiagnosticCodes: ["DOCX_SHAPE_UNSUPPORTED"],
    });
    decisions = await reduceTemplateImportAction(
      decisions,
      {
        id: "action:keep-current-for-remaining",
        kind: "keep-current-for-remaining",
      },
      { projection: projectionInput, decisionContext: context }
    );
    projectionInput = await projection(decisions, [ready, unsupported], {
      inventoryDiagnosticCodes: ["DOCX_SHAPE_UNSUPPORTED"],
    });
    let view = projectTemplateImportView(projectionInput);
    expect(view.summary.unanswered).toBe(0);
    expect(view.summary.cannotTransfer).toBe(1);
    expect(
      decisions.decisions.filter(({ kind }) => kind === "use-baseline")
    ).toHaveLength(1);

    decisions = await reduceTemplateImportAction(
      decisions,
      {
        id: "action:acknowledge-inventory",
        kind: "acknowledge-inventory",
      },
      { projection: projectionInput, decisionContext: context }
    );
    view = projectTemplateImportView(
      await projection(decisions, [ready, unsupported], {
        inventoryDiagnosticCodes: ["DOCX_SHAPE_UNSUPPORTED"],
      })
    );
    expect(view.stage).toBe("ready-to-preview");
    view = projectTemplateImportView(
      await projection(decisions, [ready, unsupported], {
        analysisDigest: HASH_B,
        inventoryDiagnosticCodes: ["DOCX_SHAPE_UNSUPPORTED"],
      })
    );
    expect(view.stage).toBe("review-required");
    expect(
      view.availableActions.find(
        ({ kind }) => kind === "acknowledge-inventory"
      )?.enabled
    ).toBe(true);
  });

  test("table-driven stage machine exposes only safe transitions", async () => {
    const valueCandidate = await candidate({
      writes: [{ target: "page.size", value: "letter" }],
    });
    const baseState = createTemplateDecisionState();
    const decided = reduceTemplateDecision(
      baseState,
      {
        kind: "use-baseline",
        semanticKey: valueCandidate.semanticKey,
        scope: { kind: "group", groupId: valueCandidate.group.id },
      },
      context
    );
    const freshSnapshot = await snapshotFor(decided, [valueCandidate]);
    const previewed = reduceTemplateDecision(
      decided,
      { kind: "mark-preview", digest: freshSnapshot.snapshotDigest },
      context
    );
    const built = reduceTemplateDecision(
      previewed,
      { kind: "mark-built", digest: freshSnapshot.snapshotDigest },
      context
    );
    const staleSnapshot = {
      ...freshSnapshot,
      staleness: [
        { decisionId: "accept:x", state: "candidate-changed" as const },
      ],
    };
    const blocker: TemplateDiagnosticV1 = {
      code: "AUTHORING_SOURCE_UNREADABLE",
      params: { technicalRef: "support.ref.1" },
      severity: "error",
      recoveryActions: [],
      technicalRef: "support.ref.1",
    };
    const cases: readonly {
      stage: TemplateImportStageV1;
      decisions: TemplateDecisionStateV1;
      candidates: readonly TemplateCandidateV1[];
      options?: Partial<TemplateImportProjectionInputV1>;
      enabled: readonly TemplateImportActionKindV1[];
    }[] = [
      {
        stage: "analyzing",
        decisions: baseState,
        candidates: [],
        options: { analyzing: true },
        enabled: [],
      },
      {
        stage: "review-required",
        decisions: baseState,
        candidates: [valueCandidate],
        enabled: ["apply-ready", "keep-current-for-remaining", "reanalyze"],
      },
      {
        stage: "ready-to-preview",
        decisions: decided,
        candidates: [valueCandidate],
        enabled: ["preview", "reanalyze"],
      },
      {
        stage: "ready-to-build",
        decisions: previewed,
        candidates: [valueCandidate],
        enabled: ["build", "reanalyze"],
      },
      {
        stage: "built",
        decisions: built,
        candidates: [valueCandidate],
        enabled: ["reanalyze"],
      },
      {
        stage: "source-changed",
        decisions: decided,
        candidates: [valueCandidate],
        options: { snapshot: staleSnapshot },
        enabled: ["reanalyze"],
      },
      {
        stage: "blocked",
        decisions: decided,
        candidates: [valueCandidate],
        options: { diagnostics: [blocker] },
        enabled: ["reanalyze"],
      },
    ];
    for (const item of cases) {
      const view = projectTemplateImportView(
        await projection(item.decisions, item.candidates, item.options)
      );
      expect(view.stage).toBe(item.stage);
      expect(
        view.availableActions
          .filter(({ enabled }) => enabled)
          .map(({ kind }) => kind)
          .sort()
      ).toEqual([...item.enabled].sort());
      if (view.stage === "ready-to-build") {
        expect(view.summary.unanswered).toBe(0);
        expect(view.summary.blockers).toBe(0);
        expect(view.preview).toEqual({
          designReview: "ready",
          compatibilityProof: "ready",
        });
      }
    }
  });
});

describe("browser-neutral ports and immutability", () => {
  test("portable port contracts expose no host file or storage primitives", async () => {
    const source = await Bun.file(
      new URL("./contracts.ts", import.meta.url)
    ).text();
    expect(source).not.toMatch(
      /\b(?:File|Blob|PathLike|IndexedDB|ReadableStream|NodeJS)\b/
    );
    for (const entry of ["core.ts", "adapters.ts", "index.browser.ts"]) {
      const moduleSource = await Bun.file(
        new URL(`./${entry}`, import.meta.url)
      ).text();
      expect(moduleSource).not.toMatch(
        /(?:from\s+["'](?:node:|bun:)|require\(["'](?:node:|bun:))/
      );
    }
  });

  test("repository commit, conflict, history, and undo create immutable generations", async () => {
    const repository = new InMemoryTemplateProjectRepository();
    const state0 = createTemplateDecisionState();
    const first = await repository.commit({
      projectId: "project-1",
      expectedGeneration: null,
      analysisDigest: HASH_A,
      decisions: state0,
    });
    const valueCandidate = await candidate({
      writes: [{ target: "page.size", value: "letter" }],
    });
    const state1 = reduceTemplateDecision(
      state0,
      {
        kind: "accept-candidate",
        candidate: valueCandidate,
        decidedBy: { kind: "user" },
      },
      context
    );
    const second = await repository.commit({
      projectId: "project-1",
      expectedGeneration: first.generation,
      analysisDigest: HASH_A,
      decisions: state1,
    });
    await expect(
      repository.commit({
        projectId: "project-1",
        expectedGeneration: first.generation,
        analysisDigest: HASH_A,
        decisions: state0,
      })
    ).rejects.toBeInstanceOf(TemplateProjectGenerationConflictError);
    expect(await repository.listHistory("project-1")).toHaveLength(2);
    const undone = await repository.undo({
      projectId: "project-1",
      expectedGeneration: second.generation,
      targetGeneration: first.generation,
    });
    expect(undone.generation).not.toBe(first.generation);
    expect(undone.parentGeneration).toBe(second.generation);
    expect(undone.decisions).toEqual(first.decisions);
    expect(await repository.listHistory("project-1")).toHaveLength(3);
  });

  test("asset and preview adapters are deterministic and copy bytes", async () => {
    const bytes = new TextEncoder().encode("asset");
    const sha256 = await Bun.CryptoHasher.hash("sha256", bytes, "hex");
    const assets = new InMemoryTemplateAssetStore();
    const handle = await assets.put({
      sha256,
      mediaType: "image/png",
      bytes,
    });
    bytes[0] = 0;
    await expect(assets.verify(handle)).resolves.toBeUndefined();
    expect(new TextDecoder().decode(await assets.get(handle))).toBe("asset");

    const preview = new InMemoryTemplatePreviewCompiler();
    const request = {
      generation: "generation-1",
      snapshotDigest: HASH_A,
      purpose: "design-review" as const,
    };
    expect(await preview.render(request)).toEqual(await preview.render(request));
  });

  test("resolution never mutates or aliases baseline, candidates, decisions, or snapshot", async () => {
    const baselineInput = structuredClone(baseline);
    const valueCandidate = await candidate({
      writes: [{ target: "page.size", value: "letter" }],
    });
    const state = reduceTemplateDecision(
      createTemplateDecisionState(),
      {
        kind: "accept-candidate",
        candidate: valueCandidate,
        decidedBy: { kind: "user" },
      },
      context
    );
    const before = {
      baseline: canonicalCapabilityJson(baselineInput),
      candidate: canonicalCapabilityJson(valueCandidate),
      state: canonicalCapabilityJson(state),
    };
    const snapshot = await resolveTemplateLayers({
      catalog,
      catalogDigest,
      baseline: { id: "editorial", version: "1", design: baselineInput },
      sourceDigest: HASH_A,
      decisions: state,
      candidates: [valueCandidate],
      mappingVersion: "1",
    });
    expect(() => {
      (snapshot.design.page as { size: string }).size = "a4";
    }).toThrow();
    expect(canonicalCapabilityJson(baselineInput)).toBe(before.baseline);
    expect(canonicalCapabilityJson(valueCandidate)).toBe(before.candidate);
    expect(canonicalCapabilityJson(state)).toBe(before.state);
    expect((baselineInput.page as { size: string }).size).toBe("a4");
  });
});
