import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "./manifest.js";

export const BROWSER_MODEL_SELECTION_SCHEMA_V1 =
  "atlcli.browser-model-selection/v1" as const;

export const ANTHROPIC_BROWSER_MODEL_SELECTION_V1 = {
  schema: BROWSER_MODEL_SELECTION_SCHEMA_V1,
  providerId: "anthropic",
  modelId: "claude-sonnet-4-6",
} as const;

export const LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1 = {
  schema: BROWSER_MODEL_SELECTION_SCHEMA_V1,
  providerId: "local-gemma",
  modelId: LOCAL_GEMMA_G0_MANIFEST_V1.modelId,
  modelRevision: LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
  dtype: LOCAL_GEMMA_G0_MANIFEST_V1.dtype,
} as const;

export type BrowserModelSelectionV1 =
  | typeof ANTHROPIC_BROWSER_MODEL_SELECTION_V1
  | typeof LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1;

export interface BrowserModelDescriptorV1 {
  selection: BrowserModelSelectionV1;
  label: string;
  execution: "remote" | "local";
  readiness: "credential" | "installed-model";
  capabilities: {
    chatQuick: boolean;
    chatAuto: boolean;
    chatDeep: boolean;
    deepResearch: boolean;
  };
}

export const BROWSER_MODEL_DESCRIPTORS_V1 = [
  {
    selection: ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
    label: "Anthropic",
    execution: "remote",
    readiness: "credential",
    capabilities: {
      chatQuick: true,
      chatAuto: true,
      chatDeep: true,
      deepResearch: true,
    },
  },
  {
    selection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
    label: "Gemma 4 E4B (local)",
    execution: "local",
    readiness: "installed-model",
    capabilities: {
      chatQuick: true,
      chatAuto: true,
      chatDeep: true,
      deepResearch: false,
    },
  },
] as const satisfies readonly BrowserModelDescriptorV1[];

export function browserModelSelectionKey(selection: BrowserModelSelectionV1): string {
  return `${selection.providerId}:${selection.modelId}`;
}

export function browserModelDescriptorByKey(
  key: string,
): BrowserModelDescriptorV1 | undefined {
  return BROWSER_MODEL_DESCRIPTORS_V1.find(
    (descriptor) => browserModelSelectionKey(descriptor.selection) === key,
  );
}

/**
 * Accept only selections shipped by this extension build. This prevents a
 * future or malformed storage record from turning into an executable endpoint.
 */
export function normalizeBrowserModelSelectionV1(value: unknown): BrowserModelSelectionV1 {
  if (typeof value !== "object" || value === null) {
    return ANTHROPIC_BROWSER_MODEL_SELECTION_V1;
  }
  return (
    BROWSER_MODEL_DESCRIPTORS_V1.find((descriptor) => {
      const expected = descriptor.selection;
      const candidate = value as Record<string, unknown>;
      if (
        candidate.schema !== expected.schema ||
        candidate.providerId !== expected.providerId ||
        candidate.modelId !== expected.modelId
      ) {
        return false;
      }
      if (expected.providerId === "local-gemma") {
        return (
          candidate.modelRevision === expected.modelRevision &&
          candidate.dtype === expected.dtype
        );
      }
      return true;
    })?.selection ?? ANTHROPIC_BROWSER_MODEL_SELECTION_V1
  );
}
