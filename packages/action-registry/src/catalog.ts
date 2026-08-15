import {
  ACTION_GROUP_IDS,
  type ActionAvailabilityV1,
  type ActionDefinitionV1,
  type ActionModuleV1,
  type ActionSurfaceContextV1,
} from "./contracts.js";
import {
  evaluateActionRequirementsV1,
  parseActionModuleV1,
  parseActionSurfaceContextV1,
  type ActionValidationPolicyV1,
} from "./validation.js";

export const DEFAULT_ACTION_GROUP_ORDER_V1 = [
  ACTION_GROUP_IDS.suggested,
  ACTION_GROUP_IDS.export,
  ACTION_GROUP_IDS.ai,
  ACTION_GROUP_IDS.navigation,
] as const;

export type ActionCatalogDiagnosticCodeV1 =
  | "duplicate-module-id"
  | "duplicate-action-id";

export interface ActionCatalogDiagnosticV1 {
  readonly code: ActionCatalogDiagnosticCodeV1;
  readonly id: string;
  readonly moduleIds: readonly string[];
  readonly sourceIndexes: readonly number[];
}

export interface ActionCatalogEntryV1 {
  readonly action: ActionDefinitionV1;
  readonly availability: ActionAvailabilityV1;
  readonly moduleIndex: number;
  readonly actionIndex: number;
  readonly declarationIndex: number;
  readonly catalogIndex: number;
  readonly groupRank: number;
}

export interface ActionCatalogV1 {
  readonly context: ActionSurfaceContextV1;
  readonly modules: readonly ActionModuleV1[];
  readonly actions: readonly ActionCatalogEntryV1[];
  readonly actionsById: Readonly<Record<string, ActionCatalogEntryV1>>;
  readonly diagnostics: readonly ActionCatalogDiagnosticV1[];
  readonly hasErrors: boolean;
}

export interface CreateActionCatalogOptionsV1 {
  readonly groupOrder?: readonly string[];
  readonly validationPolicy?: ActionValidationPolicyV1;
}

interface DeclaredAction {
  action: ActionDefinitionV1;
  moduleIndex: number;
  actionIndex: number;
  declarationIndex: number;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function occurrenceMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, number[]> {
  const occurrences = new Map<string, number[]>();
  values.forEach((value, index) => {
    const key = keyOf(value);
    const indexes = occurrences.get(key);
    if (indexes) indexes.push(index);
    else occurrences.set(key, [index]);
  });
  return occurrences;
}

function stableGroupRanks(groupOrder: readonly string[]): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const group of groupOrder) {
    if (!ranks.has(group)) ranks.set(group, ranks.size);
  }
  return ranks;
}

function compareStableText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEntries(a: ActionCatalogEntryV1, b: ActionCatalogEntryV1): number {
  return (
    a.groupRank - b.groupRank ||
    compareStableText(a.action.group, b.action.group) ||
    (a.action.order ?? 0) - (b.action.order ?? 0) ||
    a.declarationIndex - b.declarationIndex ||
    compareStableText(a.action.id, b.action.id)
  );
}

/**
 * Validates modules/context, diagnoses cross-module collisions, resolves
 * availability, and returns one deterministic immutable catalog.
 */
export function createActionCatalog(
  modules: readonly ActionModuleV1[],
  context: ActionSurfaceContextV1,
  options: CreateActionCatalogOptionsV1 = {},
): ActionCatalogV1 {
  const parsedContext = parseActionSurfaceContextV1(context);
  const parsedModules = modules.map((module) =>
    parseActionModuleV1(module, options.validationPolicy),
  );
  const diagnostics: ActionCatalogDiagnosticV1[] = [];
  const moduleOccurrences = occurrenceMap(parsedModules, (module) => module.id);
  const duplicateModuleIndexes = new Set<number>();
  for (const [id, indexes] of moduleOccurrences) {
    if (indexes.length < 2) continue;
    indexes.forEach((index) => duplicateModuleIndexes.add(index));
    diagnostics.push({
      code: "duplicate-module-id",
      id,
      moduleIds: indexes.map((index) => parsedModules[index]!.id),
      sourceIndexes: indexes,
    });
  }

  const declared: DeclaredAction[] = [];
  let declarationIndex = 0;
  parsedModules.forEach((module, moduleIndex) => {
    module.actions.forEach((action, actionIndex) => {
      if (!duplicateModuleIndexes.has(moduleIndex)) {
        declared.push({ action, moduleIndex, actionIndex, declarationIndex });
      }
      declarationIndex += 1;
    });
  });

  const actionOccurrences = occurrenceMap(declared, (entry) => entry.action.id);
  const duplicateActionIndexes = new Set<number>();
  for (const [id, indexes] of actionOccurrences) {
    if (indexes.length < 2) continue;
    indexes.forEach((index) => duplicateActionIndexes.add(index));
    diagnostics.push({
      code: "duplicate-action-id",
      id,
      moduleIds: indexes.map((index) => {
        const entry = declared[index]!;
        return parsedModules[entry.moduleIndex]!.id;
      }),
      sourceIndexes: indexes.map((index) => declared[index]!.declarationIndex),
    });
  }

  diagnostics.sort(
    (a, b) =>
      compareStableText(a.code, b.code) ||
      compareStableText(a.id, b.id) ||
      (a.sourceIndexes[0] ?? 0) - (b.sourceIndexes[0] ?? 0),
  );

  const groupRanks = stableGroupRanks(options.groupOrder ?? DEFAULT_ACTION_GROUP_ORDER_V1);
  const unknownGroupRank = groupRanks.size;
  const entries = declared
    .filter((_entry, index) => !duplicateActionIndexes.has(index))
    .map<ActionCatalogEntryV1>((entry) => ({
      ...entry,
      catalogIndex: -1,
      groupRank: groupRanks.get(entry.action.group) ?? unknownGroupRank,
      availability: evaluateActionRequirementsV1(
        entry.action.requirements,
        parsedContext,
      ),
    }))
    .sort(compareEntries)
    .map<ActionCatalogEntryV1>((entry, catalogIndex) => ({
      ...entry,
      catalogIndex,
    }));

  const actionsById: Record<string, ActionCatalogEntryV1> = Object.create(null) as Record<
    string,
    ActionCatalogEntryV1
  >;
  for (const entry of entries) actionsById[entry.action.id] = entry;

  return deepFreeze({
    context: parsedContext,
    modules: parsedModules,
    actions: entries,
    actionsById,
    diagnostics,
    hasErrors: diagnostics.length > 0,
  });
}
