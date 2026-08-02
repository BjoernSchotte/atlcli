import {
  type PublicationBuildRequestV1,
  type PublicationBuildResultV1,
  type PublicationBuilderV1,
  type PublicationComponentOverrideV1,
  type PublicationDesignTokenValueV1,
  type PublicationExperienceCapabilityV1,
  type PublicationExperienceDescriptorV1,
  type PublicationExperienceSelectionV1,
  type PublicationExperienceSlotV1,
  type PublicationRendererDescriptorV1,
  type PublicationRendererPolicyV1,
  type PublicationRenderableKindV1,
  type PublicationSearchOptionsV1,
  type PublicationSearchProviderDescriptorV1,
} from "./contracts.js";
import {
  parsePublicationBuildRequestV1,
  parsePublicationBuildResultV1,
  parsePublicationExperienceDescriptorV1,
  parsePublicationRendererDescriptorV1,
  parsePublicationSearchProviderDescriptorV1,
} from "./schema.js";

export type PublicationNegotiationIssueCodeV1 =
  | "experience-id-mismatch"
  | "experience-version-mismatch"
  | "missing-capability"
  | "missing-slot"
  | "undeclared-slot-component"
  | "unsupported-component-override"
  | "design-token-schema-mismatch"
  | "invalid-design-token"
  | "duplicate-declaration"
  | "search-provider-mismatch"
  | "unsupported-search-feature"
  | "unknown-renderer"
  | "renderer-island-disabled"
  | "renderer-island-capability-mismatch"
  | "renderer-nondeterministic";

export interface PublicationNegotiationIssueV1 {
  code: PublicationNegotiationIssueCodeV1;
  path: string;
  message: string;
}

export interface PublicationDesignTokenValidationIssueV1 {
  token: string;
  message: string;
}

export interface PublicationDesignTokenValidatorV1 {
  readonly schema: string;
  validate(
    tokens: Readonly<Record<string, PublicationDesignTokenValueV1>>,
  ): readonly PublicationDesignTokenValidationIssueV1[];
}

export interface PublicationExperienceNegotiationV1 {
  compatible: boolean;
  issues: readonly PublicationNegotiationIssueV1[];
  descriptor: PublicationExperienceDescriptorV1;
  designTokens: Readonly<Record<string, PublicationDesignTokenValueV1>>;
  componentOverrides: Readonly<
    Partial<Record<PublicationComponentOverrideV1, string>>
  >;
}

export const PUBLICATION_CAPABILITY_SLOT_REQUIREMENTS_V1: Readonly<
  Partial<Record<PublicationExperienceCapabilityV1, readonly PublicationExperienceSlotV1[]>>
> = Object.freeze({
  "responsive-navigation": ["primary-navigation", "left-navigation"],
  "search-modal": ["search-trigger", "search-modal"],
  "search-page": ["main-content"],
  "table-of-contents": ["page-toc"],
  breadcrumbs: ["breadcrumbs"],
  "previous-next": ["previous-next"],
  "chart-islands": ["renderer-styles"],
  "analytics-slot": ["document-head"],
});

function negotiationIssue(
  code: PublicationNegotiationIssueCodeV1,
  path: string,
  message: string,
): PublicationNegotiationIssueV1 {
  return { code, path, message };
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function negotiatePublicationExperienceV1(
  selection: PublicationExperienceSelectionV1,
  descriptorValue: unknown,
  tokenValidator: PublicationDesignTokenValidatorV1,
): PublicationExperienceNegotiationV1 {
  const descriptor = parsePublicationExperienceDescriptorV1(descriptorValue);
  const issues: PublicationNegotiationIssueV1[] = [];

  if (selection.id !== descriptor.id) {
    issues.push(negotiationIssue(
      "experience-id-mismatch",
      "$.experience.id",
      `Selected experience ${selection.id} does not match installed experience ${descriptor.id}.`,
    ));
  }
  if (
    selection.expectedVersion !== undefined &&
    selection.expectedVersion !== descriptor.version
  ) {
    issues.push(negotiationIssue(
      "experience-version-mismatch",
      "$.experience.expectedVersion",
      `Expected experience version ${selection.expectedVersion}, received ${descriptor.version}.`,
    ));
  }

  const capabilities = new Set(descriptor.capabilities);
  for (const capability of duplicateValues(descriptor.capabilities)) {
    issues.push(negotiationIssue(
      "duplicate-declaration",
      "$.descriptor.capabilities",
      `Experience capability ${capability} is declared more than once.`,
    ));
  }
  for (const capability of selection.requiredCapabilities) {
    if (!capabilities.has(capability)) {
      issues.push(negotiationIssue(
        "missing-capability",
        "$.experience.requiredCapabilities",
        `Experience ${descriptor.id} does not provide required capability ${capability}.`,
      ));
    }
  }

  const slots = new Set(descriptor.slots);
  for (const slot of duplicateValues(descriptor.slots)) {
    issues.push(negotiationIssue(
      "duplicate-declaration",
      "$.descriptor.slots",
      `Experience slot ${slot} is declared more than once.`,
    ));
  }
  for (const [capability, requiredSlots] of Object.entries(
    PUBLICATION_CAPABILITY_SLOT_REQUIREMENTS_V1,
  ) as Array<[
    PublicationExperienceCapabilityV1,
    readonly PublicationExperienceSlotV1[],
  ]>) {
    if (!capabilities.has(capability)) continue;
    for (const slot of requiredSlots) {
      if (!slots.has(slot)) {
        issues.push(negotiationIssue(
          "missing-slot",
          "$.descriptor.slots",
          `Capability ${capability} requires semantic slot ${slot}.`,
        ));
      }
    }
  }
  for (const slot of Object.keys(descriptor.components.slots)) {
    if (!slots.has(slot as PublicationExperienceSlotV1)) {
      issues.push(negotiationIssue(
        "undeclared-slot-component",
        "$.descriptor.components.slots",
        `Slot component ${slot} is not declared by the experience.`,
      ));
    }
  }

  for (const override of Object.keys(selection.componentOverrides)) {
    if (!(override in descriptor.components.overrides)) {
      issues.push(negotiationIssue(
        "unsupported-component-override",
        "$.experience.componentOverrides",
        `Experience ${descriptor.id} does not expose component override ${override}.`,
      ));
    }
  }

  if (tokenValidator.schema !== descriptor.designTokensSchema) {
    issues.push(negotiationIssue(
      "design-token-schema-mismatch",
      "$.descriptor.designTokensSchema",
      `Design-token validator ${tokenValidator.schema} does not match ${descriptor.designTokensSchema}.`,
    ));
  } else {
    for (const tokenIssue of tokenValidator.validate(selection.designTokens)) {
      issues.push(negotiationIssue(
        "invalid-design-token",
        `$.experience.designTokens.${tokenIssue.token}`,
        tokenIssue.message,
      ));
    }
  }

  return {
    compatible: issues.length === 0,
    issues,
    descriptor,
    designTokens: selection.designTokens,
    componentOverrides: selection.componentOverrides,
  };
}

export interface PublicationSearchNegotiationV1 {
  compatible: boolean;
  issues: readonly PublicationNegotiationIssueV1[];
  provider: PublicationSearchProviderDescriptorV1;
}

export function negotiatePublicationSearchV1(
  options: PublicationSearchOptionsV1,
  providerValue: unknown,
  experience: PublicationExperienceDescriptorV1,
): PublicationSearchNegotiationV1 {
  const provider = parsePublicationSearchProviderDescriptorV1(providerValue);
  const issues: PublicationNegotiationIssueV1[] = [];
  if (
    options.provider !== provider.id ||
    provider.execution !== "static-post-build" ||
    provider.runtimeNetwork !== false
  ) {
    issues.push(negotiationIssue(
      "search-provider-mismatch",
      "$.search.provider",
      "V1 search requires the static, runtime-network-free Pagefind provider contract.",
    ));
  }

  const checkSupported = (
    values: readonly string[],
    supported: readonly string[],
    path: string,
  ): void => {
    const supportedSet = new Set(supported);
    for (const value of values) {
      if (!supportedSet.has(value)) {
        issues.push(negotiationIssue(
          "unsupported-search-feature",
          path,
          `Search provider ${provider.id} does not support ${value}.`,
        ));
      }
    }
  };
  checkSupported(options.filters, provider.supportedFilters, "$.search.filters");
  checkSupported(options.metadata, provider.supportedMetadata, "$.search.metadata");
  checkSupported([options.ui], provider.supportedUi, "$.search.ui");
  checkSupported([options.shortcut], provider.supportedShortcuts, "$.search.shortcut");
  if (Array.isArray(options.languages) && !provider.languagePartitions) {
    issues.push(negotiationIssue(
      "unsupported-search-feature",
      "$.search.languages",
      `Search provider ${provider.id} does not support language partitions.`,
    ));
  }

  const experienceCapabilities = new Set(experience.capabilities);
  const requiredCapabilities: PublicationExperienceCapabilityV1[] = [];
  if (options.ui === "modal" || options.ui === "both") requiredCapabilities.push("search-modal");
  if (options.ui === "page" || options.ui === "both") requiredCapabilities.push("search-page");
  if (options.filters.length > 0) requiredCapabilities.push("faceted-search");
  for (const capability of requiredCapabilities) {
    if (!experienceCapabilities.has(capability)) {
      issues.push(negotiationIssue(
        "missing-capability",
        "$.experience.capabilities",
        `Configured search requires experience capability ${capability}.`,
      ));
    }
  }

  return { compatible: issues.length === 0, issues, provider };
}

export class PublicationRendererRegistryErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationRendererRegistryErrorV1";
  }
}

export interface PublicationRendererRegistryV1 {
  descriptors: readonly PublicationRendererDescriptorV1[];
  get(id: string): PublicationRendererDescriptorV1 | undefined;
}

export function createPublicationRendererRegistryV1(
  descriptorValues: readonly unknown[],
): PublicationRendererRegistryV1 {
  const descriptors = descriptorValues.map((value) =>
    parsePublicationRendererDescriptorV1(value)
  );
  const byId = new Map<string, PublicationRendererDescriptorV1>();
  for (const descriptor of descriptors) {
    if (byId.has(descriptor.id)) {
      throw new PublicationRendererRegistryErrorV1(
        `Renderer id ${descriptor.id} is registered more than once.`,
      );
    }
    const duplicateHandles = duplicateValues(descriptor.handles);
    if (duplicateHandles.length > 0) {
      throw new PublicationRendererRegistryErrorV1(
        `Renderer ${descriptor.id} repeats handles: ${duplicateHandles.join(", ")}.`,
      );
    }
    byId.set(descriptor.id, descriptor);
  }
  return Object.freeze({
    descriptors: Object.freeze(descriptors),
    get(id: string): PublicationRendererDescriptorV1 | undefined {
      return byId.get(id);
    },
  });
}

export interface PublicationRendererNegotiationV1 {
  compatible: boolean;
  issues: readonly PublicationNegotiationIssueV1[];
  selected: readonly PublicationRendererDescriptorV1[];
  byKind: Readonly<
    Partial<Record<PublicationRenderableKindV1, PublicationRendererDescriptorV1>>
  >;
}

export function negotiatePublicationRenderersV1(
  policy: PublicationRendererPolicyV1,
  registry: PublicationRendererRegistryV1,
  experience: PublicationExperienceDescriptorV1,
): PublicationRendererNegotiationV1 {
  const issues: PublicationNegotiationIssueV1[] = [];
  const selected: PublicationRendererDescriptorV1[] = [];
  for (const id of duplicateValues(policy.allowedRendererIds)) {
    issues.push(negotiationIssue(
      "duplicate-declaration",
      "$.renderers.allowedRendererIds",
      `Renderer ${id} is allowlisted more than once.`,
    ));
  }
  for (const id of policy.allowedRendererIds) {
    const descriptor = registry.get(id);
    if (!descriptor) {
      issues.push(negotiationIssue(
        "unknown-renderer",
        "$.renderers.allowedRendererIds",
        `Allowlisted renderer ${id} is not installed.`,
      ));
      continue;
    }
    if (!selected.includes(descriptor)) selected.push(descriptor);
  }

  const capabilities = new Set(experience.capabilities);
  for (const descriptor of selected) {
    if (!descriptor.deterministic) {
      issues.push(negotiationIssue(
        "renderer-nondeterministic",
        "$.renderers.allowedRendererIds",
        `Renderer ${descriptor.id} is not deterministic.`,
      ));
    }
    if (descriptor.capability !== "island") continue;
    if (!policy.allowIslands) {
      issues.push(negotiationIssue(
        "renderer-island-disabled",
        "$.renderers.allowIslands",
        `Renderer ${descriptor.id} requires islands, but islands are disabled.`,
      ));
    }
    if (!descriptor.handles.includes("chart") || !capabilities.has("chart-islands")) {
      issues.push(negotiationIssue(
        "renderer-island-capability-mismatch",
        "$.experience.capabilities",
        `V1 island renderer ${descriptor.id} requires chart-islands and must handle chart.`,
      ));
    }
  }

  const byKind: Partial<
    Record<PublicationRenderableKindV1, PublicationRendererDescriptorV1>
  > = Object.create(null) as Partial<
    Record<PublicationRenderableKindV1, PublicationRendererDescriptorV1>
  >;
  for (const descriptor of selected) {
    for (const kind of descriptor.handles) {
      if (byKind[kind] === undefined) byKind[kind] = descriptor;
    }
  }
  return {
    compatible: issues.length === 0,
    issues,
    selected: Object.freeze(selected),
    byKind: Object.freeze(byKind),
  };
}

export class PublicationBuilderContractErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationBuilderContractErrorV1";
  }
}

function assertBuilderPort(builder: PublicationBuilderV1): void {
  if (
    builder === null || typeof builder !== "object" ||
    typeof builder.id !== "string" || builder.id.length === 0 ||
    typeof builder.version !== "string" || builder.version.length === 0 ||
    typeof builder.build !== "function"
  ) {
    throw new PublicationBuilderContractErrorV1(
      "Publication builder must expose non-empty id/version and a build function.",
    );
  }
}

export async function runPublicationBuildV1(
  builder: PublicationBuilderV1,
  requestValue: unknown,
): Promise<PublicationBuildResultV1> {
  assertBuilderPort(builder);
  const request: PublicationBuildRequestV1 = parsePublicationBuildRequestV1(requestValue);
  if (builder.id !== request.project.builder.builder) {
    throw new PublicationBuilderContractErrorV1(
      `Builder ${builder.id} cannot execute ${request.project.builder.builder}.`,
    );
  }

  const result = parsePublicationBuildResultV1(await builder.build(request));
  const manifest = result.manifest;
  const invariants: Array<[boolean, string]> = [
    [manifest.builder.id === builder.id, "manifest builder id"],
    [manifest.builder.version === builder.version, "manifest builder version"],
    [manifest.bundleDigest === request.bundle.bundleDigest, "bundle digest"],
    [manifest.projectDigest === request.projectDigest, "project digest"],
    [manifest.configDigest === request.configDigest, "config digest"],
    [manifest.lockfileDigest === request.lockfileDigest, "lockfile digest"],
    [manifest.base === request.project.builder.base, "base"],
    [manifest.outputProfile === request.project.builder.outputProfile, "output profile"],
  ];
  for (const [valid, label] of invariants) {
    if (!valid) {
      throw new PublicationBuilderContractErrorV1(
        `Publication build result does not preserve the requested ${label}.`,
      );
    }
  }
  return result;
}
