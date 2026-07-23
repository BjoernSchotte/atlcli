import {
  projectExportBadge,
  type ExportBadgeProjectionV1,
} from "@atlcli/export-jobs";
import type { ExtensionExportActivityRowV1 } from "./activity.js";

export const EXTENSION_EXPORT_BADGE_STATE_KEY =
  "export-activity-badge-state-v1";
export const EXTENSION_EXPORT_BADGE_PULSE_ENABLED_KEY =
  "export-activity-badge-pulse-enabled-v1";
export const EXTENSION_EXPORT_BADGE_PULSE_FRAME_MS = 160;

export interface ExtensionExportBadgeStateV1 {
  schema: "atlcli.extension-export-badge/1";
  initialized: boolean;
  seenTransitions: string[];
  /** Monotonic diagnostic counter; one increment is one bounded pulse sequence. */
  pulseSequence: number;
}

export interface ExtensionExportBadgePlanV1 {
  projection: ExportBadgeProjectionV1;
  nextState: ExtensionExportBadgeStateV1;
  pulse: "failure" | "success" | null;
}

const MAX_SEEN_TRANSITIONS = 500;

export function emptyExtensionExportBadgeState(): ExtensionExportBadgeStateV1 {
  return {
    schema: "atlcli.extension-export-badge/1",
    initialized: false,
    seenTransitions: [],
    pulseSequence: 0,
  };
}

export function parseExtensionExportBadgeState(
  value: unknown,
): ExtensionExportBadgeStateV1 {
  if (!value || typeof value !== "object") {
    return emptyExtensionExportBadgeState();
  }
  const candidate = value as Partial<ExtensionExportBadgeStateV1>;
  if (
    candidate.schema !== "atlcli.extension-export-badge/1" ||
    typeof candidate.initialized !== "boolean" ||
    !Array.isArray(candidate.seenTransitions) ||
    !candidate.seenTransitions.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 4_096,
    ) ||
    !Number.isSafeInteger(candidate.pulseSequence) ||
    (candidate.pulseSequence ?? -1) < 0
  ) {
    return emptyExtensionExportBadgeState();
  }
  return {
    schema: candidate.schema,
    initialized: candidate.initialized,
    seenTransitions: candidate.seenTransitions.slice(-MAX_SEEN_TRANSITIONS),
    pulseSequence: candidate.pulseSequence!,
  };
}

function transitionKey(row: ExtensionExportActivityRowV1): string | undefined {
  if (
    row.finishedAt === undefined ||
    (row.state !== "succeeded" &&
      row.state !== "failed" &&
      row.state !== "interrupted")
  ) {
    return undefined;
  }
  return `${row.key}:${row.state}:${row.finishedAt}`;
}

/** Pure durable badge and one-pulse-per-terminal-transition decision. */
export function planExtensionExportBadge(
  rows: readonly ExtensionExportActivityRowV1[],
  state: ExtensionExportBadgeStateV1,
  pulseEnabled: boolean,
): ExtensionExportBadgePlanV1 {
  const projection = projectExportBadge(rows);
  const seen = new Set(state.seenTransitions);
  const currentTerminalKeys: string[] = [];
  const newUnreadStates: Array<"failure" | "success"> = [];
  for (const row of rows) {
    const key = transitionKey(row);
    if (!key) continue;
    currentTerminalKeys.push(key);
    if (!state.initialized || seen.has(key) || !row.unread) continue;
    newUnreadStates.push(
      row.state === "succeeded" ? "success" : "failure",
    );
  }
  const pulse =
    !pulseEnabled || newUnreadStates.length === 0
      ? null
      : newUnreadStates.includes("failure")
        ? "failure"
        : "success";
  return {
    projection,
    nextState: {
      schema: "atlcli.extension-export-badge/1",
      initialized: true,
      seenTransitions: currentTerminalKeys.slice(-MAX_SEEN_TRANSITIONS),
      pulseSequence: state.pulseSequence + (pulse ? 1 : 0),
    },
    pulse,
  };
}

export function exportBadgeColor(
  kind: ExportBadgeProjectionV1["kind"] | "failure" | "success",
): string {
  switch (kind) {
    case "failure":
      return "#C9372C";
    case "success":
      return "#1F845A";
    case "active":
      return "#0C66E4";
    case "empty":
      return "#44546F";
  }
}

/**
 * A finite pulse: two flashes, then the exact durable static color.
 * No interval survives this returned list.
 */
export function exportBadgePulseFrames(
  pulse: NonNullable<ExtensionExportBadgePlanV1["pulse"]>,
  projection: ExportBadgeProjectionV1,
): string[] {
  const pulseColor = exportBadgeColor(pulse);
  const staticColor = exportBadgeColor(projection.kind);
  return [pulseColor, staticColor, pulseColor, staticColor];
}
