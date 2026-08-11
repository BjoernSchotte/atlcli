import type { ActionCatalogEntryV1 } from "./catalog.js";
import type { ActionSearchResultV1 } from "./search.js";

export interface ActionSelectionStateV1 {
  readonly activeActionId: string | null;
  /** Last known visible index, used to repair selection after filtering. */
  readonly anchorIndex: number;
}

export type ActionSelectionMoveV1 = "first" | "last" | "next" | "previous";

export const EMPTY_ACTION_SELECTION_V1: ActionSelectionStateV1 = Object.freeze({
  activeActionId: null,
  anchorIndex: 0,
});

function freezeSelection(
  activeActionId: string | null,
  anchorIndex: number,
): ActionSelectionStateV1 {
  return Object.freeze({ activeActionId, anchorIndex });
}

function selectedIndex(
  state: ActionSelectionStateV1,
  results: readonly ActionSearchResultV1[],
): number {
  if (state.activeActionId === null) return -1;
  return results.findIndex(
    (result) => result.entry.action.id === state.activeActionId,
  );
}

/**
 * Keeps an existing action selected by ID or deterministically selects the row
 * nearest to its former index. Unavailable rows remain inspectable selections.
 */
export function repairActionSelectionV1(
  state: ActionSelectionStateV1,
  results: readonly ActionSearchResultV1[],
): ActionSelectionStateV1 {
  if (results.length === 0) return EMPTY_ACTION_SELECTION_V1;
  const existingIndex = selectedIndex(state, results);
  const anchorIndex = Number.isFinite(state.anchorIndex)
    ? Math.trunc(state.anchorIndex)
    : 0;
  const repairedIndex =
    existingIndex >= 0
      ? existingIndex
      : Math.max(0, Math.min(results.length - 1, anchorIndex));
  return freezeSelection(results[repairedIndex]!.entry.action.id, repairedIndex);
}

/** Pure, non-wrapping keyboard selection transition. */
export function moveActionSelectionV1(
  state: ActionSelectionStateV1,
  results: readonly ActionSearchResultV1[],
  move: ActionSelectionMoveV1,
): ActionSelectionStateV1 {
  if (results.length === 0) return EMPTY_ACTION_SELECTION_V1;
  const currentIndex = selectedIndex(state, results);
  let nextIndex: number;
  switch (move) {
    case "first":
      nextIndex = 0;
      break;
    case "last":
      nextIndex = results.length - 1;
      break;
    case "next":
      nextIndex = currentIndex < 0 ? 0 : Math.min(results.length - 1, currentIndex + 1);
      break;
    case "previous":
      nextIndex = currentIndex < 0 ? results.length - 1 : Math.max(0, currentIndex - 1);
      break;
  }
  return freezeSelection(results[nextIndex]!.entry.action.id, nextIndex);
}

export function selectActionByIdV1(
  actionId: string,
  results: readonly ActionSearchResultV1[],
): ActionSelectionStateV1 | null {
  const index = results.findIndex((result) => result.entry.action.id === actionId);
  return index < 0 ? null : freezeSelection(actionId, index);
}

/**
 * Execution gate for a selected row. A disabled row may be selected and
 * inspected, but this function never yields it to an executor.
 */
export function getExecutableSelectedActionV1(
  state: ActionSelectionStateV1,
  results: readonly ActionSearchResultV1[],
): ActionCatalogEntryV1 | null {
  const index = selectedIndex(state, results);
  if (index < 0) return null;
  const entry = results[index]!.entry;
  return entry.availability.available ? entry : null;
}
