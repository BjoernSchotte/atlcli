import { describe, expect, test } from "bun:test";
import {
  ACTION_GROUP_IDS,
  ACTION_IDS,
  ActionContractValidationError,
  assertValidActionIntentV1,
  assertValidSurfaceTargetV1,
  collectActionTextKeysV1,
  evaluateActionRequirementsV1,
  isStructuredCloneSafeV1,
  isSupportedBuiltInIntentKindV1,
  isValidSiteOriginV1,
  parseActionInputValuesV1,
  parseActionExecutionRequestV1,
  parseActionModuleV1,
  parseActionResultV1,
  parseActionSurfaceContextV1,
  projectActionReceiptV1,
  resolveActionAvailabilityV1,
  validateActionInputValuesV1,
  validateActionIntentV1,
  validateActionLocaleKeyParityV1,
  validateActionModuleV1,
  type ActionDefinitionV1,
  type ActionInputSchemaV1,
  type ActionModuleV1,
  type ActionSurfaceContextV1,
} from "./index.js";
import { syntheticContributionModuleV1 } from "./testing/synthetic-module.js";

const builtInModule: ActionModuleV1 = {
  schemaVersion: 1,
  id: "atlcli.builtin-actions",
  actions: [
    {
      schemaVersion: 1,
      id: ACTION_IDS.exportPdfCurrentPage,
      moduleId: "atlcli.builtin-actions",
      title: {
        key: "atlcli.action.export-pdf.title",
        fallback: "Export current page as PDF",
      },
      subtitle: {
        key: "atlcli.action.export-pdf.subtitle",
        fallback: "Create a durable PDF export",
      },
      keywords: ["pdf", "download"],
      group: ACTION_GROUP_IDS.export,
      icon: "document-pdf",
      intent: { kind: "export.current-page", format: "pdf" },
      secondaryActions: [
        {
          schemaVersion: 1,
          id: "atlcli.action.export-pdf.open-activity",
          title: {
            key: "atlcli.action.open-activity.title",
            fallback: "Open Activity",
          },
          intent: {
            kind: "surface.open",
            target: { kind: "sidebar", screen: "activity" },
          },
          requirements: [
            { kind: "capability", capability: "atlcli.capability.activity" },
          ],
          effect: "read",
        },
      ],
      requirements: [
        { kind: "product", product: "confluence" },
        { kind: "entity", entityKind: "atlcli.entity.confluence-page" },
        { kind: "capability", capability: "atlcli.capability.export-pdf" },
      ],
      effect: "download",
      order: 10,
    },
    {
      schemaVersion: 1,
      id: ACTION_IDS.quickAsk,
      moduleId: "atlcli.builtin-actions",
      title: {
        key: "atlcli.action.quick-ask.title",
        fallback: "Ask AI about this page",
      },
      group: ACTION_GROUP_IDS.ai,
      icon: "sparkles",
      intent: { kind: "ai.quick-ask" },
      requirements: [
        { kind: "capability", capability: "atlcli.capability.quick-ai" },
      ],
      effect: "read",
      input: {
        schemaVersion: 1,
        fields: [
          {
            type: "text",
            id: "question",
            label: {
              key: "atlcli.action.quick-ask.question.label",
              fallback: "Question",
            },
            placeholder: {
              key: "atlcli.action.quick-ask.question.placeholder",
              fallback: "What do you want to know?",
            },
            required: true,
            multiline: true,
            minLength: 2,
            maxLength: 2_000,
          },
          {
            type: "boolean",
            id: "disclosure",
            label: {
              key: "atlcli.action.quick-ask.disclosure.label",
              fallback: "Send the current context to the AI provider",
            },
            required: true,
          },
        ],
        submitLabel: {
          key: "atlcli.action.quick-ask.submit",
          fallback: "Ask",
        },
      },
      order: 20,
    },
  ],
};

const confluenceContext: ActionSurfaceContextV1 = {
  siteOrigin: "https://example.atlassian.net",
  product: "confluence",
  entity: {
    kind: "atlcli.entity.confluence-page",
    id: "page-1",
    title: "Not persisted by a receipt",
    url: "https://example.atlassian.net/wiki/spaces/EX/pages/1",
  },
  locale: "en",
  capabilities: ["atlcli.capability.export-pdf", "atlcli.capability.activity"],
};

function mutableClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectIssue(value: unknown, code: string): void {
  expect(validateActionModuleV1(value).some((candidate) => candidate.code === code)).toBe(true);
}

describe("action contract constants", () => {
  test("reserve the eight public root action ids", () => {
    expect(Object.values(ACTION_IDS)).toEqual([
      "atlcli.export.pdf.current-page",
      "atlcli.export.docx.current-page",
      "atlcli.export.docx.configure",
      "atlcli.sidebar.open",
      "atlcli.sidebar.publishing",
      "atlcli.sidebar.research",
      "atlcli.sidebar.activity",
      "atlcli.ai.quick-ask",
    ]);
    expect(new Set(Object.values(ACTION_IDS)).size).toBe(8);
  });

  test("keep the built-in intent allowlist explicit", () => {
    expect(isSupportedBuiltInIntentKindV1("surface.open")).toBe(true);
    expect(isSupportedBuiltInIntentKindV1("contribution.example.synthetic-inspect")).toBe(false);
  });
});

describe("module parsing and immutability", () => {
  test("parses, JSON-round-trips, clones, and deeply freezes valid definitions", () => {
    const input = mutableClone(builtInModule) as unknown as {
      actions: Array<{ title: { fallback: string } }>;
    };
    const parsed = parseActionModuleV1(input);
    expect(parsed).toEqual(builtInModule);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.actions)).toBe(true);
    expect(Object.isFrozen(parsed.actions[0]?.intent)).toBe(true);

    input.actions[0]!.title.fallback = "mutated input";
    expect(parsed.actions[0]?.title.fallback).toBe("Export current page as PDF");
    expect(() => {
      (parsed.actions[0]!.title as { fallback: string }).fallback = "mutated output";
    }).toThrow();
  });

  test("returns a typed error with every boundary issue", () => {
    const invalid = mutableClone(builtInModule) as unknown as {
      schemaVersion: number;
      id: string;
      actions: Array<Record<string, unknown>>;
    };
    invalid.schemaVersion = 2;
    invalid.id = "not_namespaced";
    invalid.actions[0]!.unexpected = true;
    expect(() => parseActionModuleV1(invalid)).toThrow(ActionContractValidationError);
    try {
      parseActionModuleV1(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractValidationError);
      const codes = (error as ActionContractValidationError).issues.map((entry) => entry.code);
      expect(codes).toContain("unsupported-schema-version");
      expect(codes).toContain("invalid-namespaced-id");
      expect(codes).toContain("unknown-field");
    }
  });

  test("rejects duplicate action and affordance ids", () => {
    const duplicateActions = mutableClone(builtInModule) as unknown as {
      actions: Array<unknown>;
    };
    duplicateActions.actions.push(mutableClone(duplicateActions.actions[0]!));
    expectIssue(duplicateActions, "duplicate-action-id");

    const duplicateAffordances = mutableClone(builtInModule) as unknown as {
      actions: Array<{ secondaryActions: Array<unknown> }>;
    };
    duplicateAffordances.actions[0]!.secondaryActions!.push(
      mutableClone(duplicateAffordances.actions[0]!.secondaryActions![0]!),
    );
    expectIssue(duplicateAffordances, "duplicate-affordance-id");
  });

  test("rejects duplicate keywords, fields, and select options", () => {
    const duplicateKeyword = mutableClone(builtInModule) as unknown as {
      actions: Array<{ keywords?: string[] }>;
    };
    duplicateKeyword.actions[0]!.keywords = ["PDF", "pdf"];
    expectIssue(duplicateKeyword, "duplicate-keyword");

    const duplicateField = mutableClone(builtInModule) as unknown as {
      actions: Array<{ input?: { fields: Array<Record<string, unknown>> } }>;
    };
    duplicateField.actions[1]!.input!.fields.push(
      mutableClone(duplicateField.actions[1]!.input!.fields[0]!),
    );
    expectIssue(duplicateField, "duplicate-field-id");

    const duplicateOption = mutableClone(builtInModule) as unknown as {
      actions: Array<{ input?: { fields: Array<Record<string, unknown>> } }>;
    };
    duplicateOption.actions[1]!.input!.fields[0] = {
      type: "select",
      id: "mode",
      label: { key: "atlcli.action.mode.label", fallback: "Mode" },
      options: [
        { id: "short", label: { key: "atlcli.action.mode.short", fallback: "Short" } },
        { id: "short", label: { key: "atlcli.action.mode.short", fallback: "Short" } },
      ],
    };
    expectIssue(duplicateOption, "duplicate-option-id");
  });

  test("rejects module drift, invalid groups, effects, icons, and requirements", () => {
    for (const [field, value, code] of [
      ["moduleId", "other.module", "module-id-mismatch"],
      ["group", "export", "invalid-namespaced-id"],
      ["effect", "execute", "unknown-effect"],
      ["icon", "remote-url", "unknown-icon"],
    ] as const) {
      const invalid = mutableClone(builtInModule) as unknown as {
        actions: Array<Record<string, unknown>>;
      };
      invalid.actions[0]![field] = value;
      expectIssue(invalid, code);
    }

    const invalidRequirement = mutableClone(builtInModule) as unknown as {
      actions: Array<{ requirements: Array<Record<string, unknown>> }>;
    };
    invalidRequirement.actions[0]!.requirements[0] = { kind: "remote-policy" };
    expectIssue(invalidRequirement, "unknown-requirement");
  });

  test("rejects unsupported versions and unknown intents by default", () => {
    const invalidVersion = mutableClone(builtInModule) as unknown as {
      actions: Array<{ schemaVersion: number }>;
    };
    invalidVersion.actions[0]!.schemaVersion = 2;
    expectIssue(invalidVersion, "unsupported-schema-version");

    const unknownIntent = mutableClone(syntheticContributionModuleV1);
    expectIssue(unknownIntent, "unknown-intent");
    expect(validateActionIntentV1({ kind: "contribution.example.synthetic-inspect" })).toEqual([
      expect.objectContaining({ code: "unknown-intent" }),
    ]);
  });

  test("accepts a synthetic contribution only under an exact host policy", () => {
    const parsed = parseActionModuleV1(syntheticContributionModuleV1, {
      allowedContributionIntentKinds: ["contribution.example.synthetic-inspect"],
    });
    expect(parsed.actions[0]?.id).toBe("example.synthetic.inspect-context");
    expect(() =>
      parseActionModuleV1(syntheticContributionModuleV1, {
        allowedContributionIntentKinds: ["contribution.example.synthetic-other"],
      }),
    ).toThrow(ActionContractValidationError);
    expect(() =>
      parseActionModuleV1(syntheticContributionModuleV1, {
        allowedContributionIntentKinds: ["surface.open"],
      }),
    ).toThrow(ActionContractValidationError);
  });

  test("rejects functions, undefined, symbols, bigint, non-finite numbers, dates, and cycles", () => {
    for (const payload of [
      () => undefined,
      undefined,
      Symbol("unsafe"),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
    ]) {
      const hostile = mutableClone(syntheticContributionModuleV1) as unknown as {
        actions: Array<{ intent: { payload?: unknown } }>;
      };
      hostile.actions[0]!.intent.payload = payload;
      expect(validateActionModuleV1(hostile).length).toBeGreaterThan(0);
    }
    const cyclic = mutableClone(syntheticContributionModuleV1) as unknown as {
      actions: Array<{ intent: { payload?: unknown } }>;
    };
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    cyclic.actions[0]!.intent.payload = cycle;
    expectIssue(cyclic, "cyclic-value");

    const accessor = mutableClone(syntheticContributionModuleV1) as unknown as {
      actions: Array<{ intent: { payload?: unknown } }>;
    };
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, "secret", {
      enumerable: true,
      get: () => {
        throw new Error("the validator must not invoke accessors");
      },
    });
    accessor.actions[0]!.intent.payload = accessorPayload;
    expectIssue(accessor, "accessor-property");
  });

  test("rejects malformed text and stale input contracts", () => {
    const missingFallback = mutableClone(builtInModule) as unknown as {
      actions: Array<{ title: Record<string, unknown> }>;
    };
    delete missingFallback.actions[0]!.title.fallback;
    expectIssue(missingFallback, "expected-string");

    const unknownInput = mutableClone(builtInModule) as unknown as {
      actions: Array<{ input?: { fields: Array<Record<string, unknown>> } }>;
    };
    unknownInput.actions[1]!.input!.fields[0]!.type = "file";
    expectIssue(unknownInput, "unknown-input-type");
  });
});

describe("capability and requirement evaluation", () => {
  test("returns every unmet requirement with stable reason codes", () => {
    const action = builtInModule.actions[0]!;
    const availability = evaluateActionRequirementsV1(action.requirements, {
      siteOrigin: "https://example.atlassian.net",
      product: "jira",
      locale: "de",
      capabilities: [],
    });
    expect(availability.available).toBe(false);
    if (availability.available) throw new Error("expected unavailable");
    expect(availability.reasons.map((reason) => reason.code)).toEqual([
      "wrong-product",
      "missing-entity",
      "missing-capability",
    ]);
    expect(availability.reasons.every((reason) => reason.message.fallback.length > 0)).toBe(true);
  });

  test("resolves the same action immediately when context satisfies it", () => {
    const action = builtInModule.actions[0]!;
    const resolved = resolveActionAvailabilityV1(action, confluenceContext);
    expect(resolved.action).toBe(action);
    expect(resolved.availability).toEqual({ available: true, reasons: [] });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  test("distinguishes a missing entity from the wrong entity kind", () => {
    const requirement = [{ kind: "entity", entityKind: "atlcli.entity.confluence-page" }] as const;
    expect(
      evaluateActionRequirementsV1(requirement, { ...confluenceContext, entity: undefined }),
    ).toEqual({
      available: false,
      reasons: [expect.objectContaining({ code: "missing-entity" })],
    });
    expect(
      evaluateActionRequirementsV1(requirement, {
        ...confluenceContext,
        entity: { ...confluenceContext.entity!, kind: "atlcli.entity.jira-issue" },
      }),
    ).toEqual({
      available: false,
      reasons: [expect.objectContaining({ code: "wrong-entity-kind" })],
    });
  });
});

describe("context and execution-request boundaries", () => {
  test("parses a same-origin context into an immutable structured-clone-safe value", () => {
    const parsed = parseActionSurfaceContextV1(confluenceContext);
    expect(parsed).toEqual(confluenceContext);
    expect(parsed).not.toBe(confluenceContext);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
    expect(isStructuredCloneSafeV1(parsed)).toBe(true);
  });

  test("rejects cross-origin entities, duplicate capabilities, and raw extra fields", () => {
    expect(() =>
      parseActionSurfaceContextV1({
        ...confluenceContext,
        entity: {
          ...confluenceContext.entity,
          url: "https://other.atlassian.net/wiki/spaces/EX/pages/1",
        },
        capabilities: [
          "atlcli.capability.export-pdf",
          "atlcli.capability.export-pdf",
        ],
        apiKey: "must not cross the boundary",
      }),
    ).toThrow(ActionContractValidationError);
    try {
      parseActionSurfaceContextV1({
        ...confluenceContext,
        entity: {
          ...confluenceContext.entity,
          url: "https://other.atlassian.net/wiki/spaces/EX/pages/1",
        },
        capabilities: [
          "atlcli.capability.export-pdf",
          "atlcli.capability.export-pdf",
        ],
        apiKey: "must not cross the boundary",
      });
    } catch (error) {
      const codes = (error as ActionContractValidationError).issues.map((entry) => entry.code);
      expect(codes).toContain("cross-origin-entity-url");
      expect(codes).toContain("duplicate-capability");
      expect(codes).toContain("unknown-field");
    }
  });

  test("validates the complete execution request and fails closed on extra authority", () => {
    const request = parseActionExecutionRequestV1({
      schemaVersion: 1,
      requestId: "request:123",
      actionId: ACTION_IDS.quickAsk,
      intent: { kind: "ai.quick-ask" },
      context: confluenceContext,
      input: { question: "Why?" },
    });
    expect(request.actionId).toBe(ACTION_IDS.quickAsk);
    expect(Object.isFrozen(request.context)).toBe(true);
    expect(isStructuredCloneSafeV1(request)).toBe(true);

    expect(() =>
      parseActionExecutionRequestV1({
        ...request,
        apiKey: "forbidden",
        tabId: 123,
      }),
    ).toThrow(ActionContractValidationError);
  });

  test("requires the same explicit policy for a contributed execution intent", () => {
    const contributed = {
      schemaVersion: 1,
      requestId: "request:synthetic",
      actionId: "example.synthetic.inspect-context",
      intent: {
        kind: "contribution.example.synthetic-inspect",
        payload: { projection: "product" },
      },
      context: confluenceContext,
    };
    expect(() => parseActionExecutionRequestV1(contributed)).toThrow(
      ActionContractValidationError,
    );
    expect(
      parseActionExecutionRequestV1(contributed, {
        allowedContributionIntentKinds: ["contribution.example.synthetic-inspect"],
      }).intent.kind,
    ).toBe("contribution.example.synthetic-inspect");
  });
});

describe("input, localization, and result boundaries", () => {
  const quickAskInput = builtInModule.actions[1]!.input as ActionInputSchemaV1;

  test("validates and freezes input values without accepting undeclared fields", () => {
    expect(validateActionInputValuesV1(quickAskInput, {
      question: "Why?", disclosure: "true",
    })).toEqual([]);
    expect(validateActionInputValuesV1(quickAskInput, { question: "x", disclosure: "false" })).toEqual([
      expect.objectContaining({ code: "input-length" }),
      expect.objectContaining({ code: "required-input" }),
    ]);
    expect(validateActionInputValuesV1(quickAskInput, {
      question: "Why?", disclosure: "true", apiKey: "secret",
    })).toEqual([
      expect.objectContaining({ code: "unknown-input-field" }),
    ]);
    const parsed = parseActionInputValuesV1(quickAskInput, {
      question: "Why?", disclosure: "true",
    });
    expect(parsed).toEqual({ question: "Why?", disclosure: "true" });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("collects exact contract text keys and enforces locale parity", () => {
    const parsed = parseActionModuleV1(builtInModule);
    const keys = collectActionTextKeysV1([parsed]);
    expect(keys).toContain("atlcli.action.quick-ask.question.placeholder");
    const en = Object.fromEntries(keys.map((key) => [key, `en:${key}`]));
    const de = Object.fromEntries(keys.map((key) => [key, `de:${key}`]));
    expect(validateActionLocaleKeyParityV1([parsed], { en, de })).toEqual([]);
    delete de[keys[0]!];
    en["atlcli.action.stale"] = "stale";
    const codes = validateActionLocaleKeyParityV1([parsed], { en, de }).map((entry) => entry.code);
    expect(codes).toContain("missing-text-key");
    expect(codes).toContain("stale-text-key");
  });

  test("validates result affordances and closed surface targets", () => {
    const result = parseActionResultV1({
      status: "completed",
      messageKey: "atlcli.action.result.completed",
      presentation: { kind: "markdown", text: "Bounded answer", truncated: false },
      actions: builtInModule.actions[0]!.secondaryActions,
    });
    expect(result.status).toBe("completed");
    expect(Object.isFrozen(result)).toBe(true);
    expect(() =>
      parseActionResultV1({
        status: "completed",
        messageKey: "atlcli.action.result.completed",
        actions: [{ schemaVersion: 1, id: "bad", title: {}, intent: {}, effect: "read" }],
      }),
    ).toThrow(ActionContractValidationError);

    expect(assertValidSurfaceTargetV1({ kind: "sidebar", screen: "research" })).toEqual({
      kind: "sidebar",
      screen: "research",
    });
    expect(assertValidSurfaceTargetV1({
      kind: "sidebar",
      screen: "research",
      continuationId: "research-session:quick-1",
    })).toMatchObject({ continuationId: "research-session:quick-1" });
    expect(() => assertValidSurfaceTargetV1({
      kind: "sidebar",
      screen: "export",
      continuationId: "research-session:wrong-screen",
    })).toThrow(ActionContractValidationError);
    expect(() => parseActionResultV1({
      status: "completed",
      messageKey: "atlcli.action.result.completed",
      presentation: { kind: "markdown", text: "x".repeat(12_001), truncated: true },
    })).toThrow(ActionContractValidationError);
    expect(parseActionResultV1({
      status: "open-surface",
      target: { kind: "sidebar", screen: "export" },
      actions: [{
        schemaVersion: 1,
        id: ACTION_IDS.openPublishing,
        title: { key: "atlcli.action.open-publishing.title", fallback: "Open Publishing" },
        intent: { kind: "surface.open", target: { kind: "sidebar", screen: "export" } },
        effect: "external-navigation",
      }],
    })).toMatchObject({ status: "open-surface", actions: [{ id: ACTION_IDS.openPublishing }] });
    expect(() => assertValidSurfaceTargetV1({ kind: "sidebar", screen: "arbitrary" })).toThrow(
      ActionContractValidationError,
    );
    expect(() => assertValidSurfaceTargetV1({ kind: "url", href: "https://remote.invalid" })).toThrow(
      ActionContractValidationError,
    );
  });

  test("requires result receipts to be already redacted public contracts", () => {
    const receipt = projectActionReceiptV1({
      id: "job:queued",
      actionId: ACTION_IDS.exportPdfCurrentPage,
      status: "queued",
      host: "extension",
      createdAt: "2026-08-11T18:00:00.000Z",
      prompt: "dropped by projection",
    });
    expect(parseActionResultV1({ status: "queued", receipt })).toEqual({
      status: "queued",
      receipt,
    });
    expect(() =>
      parseActionResultV1({
        status: "queued",
        receipt: { ...receipt, prompt: "must not survive" },
      }),
    ).toThrow(ActionContractValidationError);
  });

  test("allows a contributed intent only when the host policy names it exactly", () => {
    expect(
      assertValidActionIntentV1(
        { kind: "contribution.example.synthetic-inspect", payload: { projection: "product" } },
        { allowedContributionIntentKinds: ["contribution.example.synthetic-inspect"] },
      ),
    ).toEqual({ kind: "contribution.example.synthetic-inspect", payload: { projection: "product" } });
    expect(() => assertValidActionIntentV1({ kind: "contribution.example.synthetic-inspect" })).toThrow(
      ActionContractValidationError,
    );
  });
});

describe("redacted receipt projection", () => {
  test("keeps only public fields and remains structured-clone safe", () => {
    const receipt = projectActionReceiptV1({
      id: "job:123",
      actionId: ACTION_IDS.exportPdfCurrentPage,
      status: "queued",
      host: "extension",
      createdAt: "2026-08-11T18:00:00.000Z",
      jobKind: "pdf",
      siteOrigin: "https://secret-tenant.atlassian.net",
      entityTitle: "Secret page",
      prompt: "Secret prompt",
      apiKey: "Secret key",
      rawError: new Error("Secret error"),
    });
    expect(receipt).toEqual({
      schemaVersion: 1,
      id: "job:123",
      actionId: ACTION_IDS.exportPdfCurrentPage,
      status: "queued",
      host: "extension",
      createdAt: "2026-08-11T18:00:00.000Z",
      jobKind: "pdf",
    });
    expect(JSON.stringify(receipt)).not.toContain("Secret");
    expect(JSON.stringify(receipt)).not.toContain("tenant");
    expect(isStructuredCloneSafeV1(receipt)).toBe(true);
    expect(structuredClone(receipt)).toEqual(receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  test("rejects invalid public identifiers, statuses, and timestamps", () => {
    expect(() =>
      projectActionReceiptV1({
        id: "bad id",
        actionId: "bad",
        status: "unknown",
        host: "remote",
        createdAt: "today",
      }),
    ).toThrow(ActionContractValidationError);
  });
});

describe("browser-safe utility boundaries", () => {
  test("accepts only exact HTTPS origins", () => {
    expect(isValidSiteOriginV1("https://example.atlassian.net")).toBe(true);
    expect(isValidSiteOriginV1("https://example.atlassian.net/path")).toBe(false);
    expect(isValidSiteOriginV1("http://example.atlassian.net")).toBe(false);
    expect(isValidSiteOriginV1("not a url")).toBe(false);
  });

  test("exports contract shapes without depending on host runtimes", () => {
    const action: ActionDefinitionV1 = builtInModule.actions[0]!;
    expect(action.intent.kind).toBe("export.current-page");
    expect(isStructuredCloneSafeV1(builtInModule)).toBe(true);
  });
});
