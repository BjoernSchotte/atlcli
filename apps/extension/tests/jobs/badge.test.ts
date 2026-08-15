import { describe, expect, it } from "bun:test";
import type { ExtensionExportActivityRowV1 } from "../../utils/export-jobs/activity.js";
import {
  emptyExtensionExportBadgeState,
  exportBadgePulseFrames,
  parseExtensionExportBadgeState,
  planExtensionExportBadge,
} from "../../utils/export-jobs/badge.js";

function row(
  key: string,
  state: ExtensionExportActivityRowV1["state"],
  options: { acknowledged?: boolean; finishedAt?: number } = {},
): ExtensionExportActivityRowV1 {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(
    state,
  );
  return {
    key: `common:${key}`,
    source: "common",
    id: key,
    format: key.includes("docx") ? "docx" : "pdf",
    state,
    displayName: key,
    sourceLabel: "DOCS",
    siteOrigin: "https://site.atlassian.net",
    scopeKind: "space",
    createdAt: 1,
    ...(terminal
      ? { finishedAt: options.finishedAt ?? 10 }
      : {}),
    ...(options.acknowledged ? { acknowledgedAt: 11 } : {}),
    attempt: state === "queued" ? 0 : 1,
    recoveryCount: 0,
    stats: null,
    bytes: 0,
    unread: terminal && !options.acknowledged,
    actions: {
      cancel: ["queued", "running", "waiting", "cancelling"].includes(state),
      retry: ["failed", "interrupted", "cancelled"].includes(state),
      rerun: state === "succeeded",
      resume: false,
      download: false,
      acknowledge: terminal && !options.acknowledged,
      dismiss: terminal,
      detail: terminal,
    },
  };
}

describe("extension export badge plan", () => {
  it("projects mixed formats, caps active jobs, and keeps failure precedence after activity", () => {
    const active = Array.from({ length: 10 }, (_, index) =>
      row(index % 2 === 0 ? `docx-${index}` : `pdf-${index}`, "waiting"),
    );
    const plan = planExtensionExportBadge(
      [
        ...active,
        row("failed", "failed"),
        row("success", "succeeded"),
      ],
      {
        ...emptyExtensionExportBadgeState(),
        initialized: true,
      },
      true,
    );
    expect(plan.projection).toMatchObject({
      kind: "active",
      text: "9+",
      activeCount: 10,
      unreadFailureCount: 1,
      unreadSuccessCount: 1,
    });
    expect(plan.pulse).toBe("failure");
  });

  it("shows failure, then success, then empty as terminal jobs are acknowledged", () => {
    const initialized = {
      ...emptyExtensionExportBadgeState(),
      initialized: true,
    };
    expect(
      planExtensionExportBadge(
        [row("failed", "failed"), row("success", "succeeded")],
        initialized,
        false,
      ).projection,
    ).toMatchObject({ kind: "failure", text: "!" });
    expect(
      planExtensionExportBadge(
        [
          row("failed", "failed", { acknowledged: true }),
          row("success", "succeeded"),
        ],
        initialized,
        false,
      ).projection,
    ).toMatchObject({ kind: "success", text: "✓" });
    expect(
      planExtensionExportBadge(
        [
          row("failed", "failed", { acknowledged: true }),
          row("success", "succeeded", { acknowledged: true }),
        ],
        initialized,
        false,
      ).projection,
    ).toMatchObject({ kind: "empty", text: "" });
  });

  it("initializes silently and never pulses the same transition twice", () => {
    const completed = row("success", "succeeded");
    const first = planExtensionExportBadge(
      [completed],
      emptyExtensionExportBadgeState(),
      true,
    );
    expect(first.pulse).toBeNull();
    expect(first.nextState.pulseSequence).toBe(0);

    const newCompletion = row("new-success", "succeeded", { finishedAt: 20 });
    const second = planExtensionExportBadge(
      [completed, newCompletion],
      first.nextState,
      true,
    );
    expect(second.pulse).toBe("success");
    expect(second.nextState.pulseSequence).toBe(1);
    expect(exportBadgePulseFrames("success", second.projection)).toHaveLength(4);

    const repeated = planExtensionExportBadge(
      [completed, newCompletion],
      second.nextState,
      true,
    );
    expect(repeated.pulse).toBeNull();
    expect(repeated.nextState.pulseSequence).toBe(1);
  });

  it("keeps static truth but suppresses pulse when the preference is disabled", () => {
    const plan = planExtensionExportBadge(
      [row("failed", "failed")],
      {
        ...emptyExtensionExportBadgeState(),
        initialized: true,
      },
      false,
    );
    expect(plan.projection).toMatchObject({ kind: "failure", text: "!" });
    expect(plan.pulse).toBeNull();
    expect(plan.nextState.pulseSequence).toBe(0);
  });

  it("fails closed to an empty bounded state for malformed storage", () => {
    expect(parseExtensionExportBadgeState({
      schema: "atlcli.extension-export-badge/1",
      initialized: true,
      seenTransitions: ["ok", 42],
      pulseSequence: 1,
    })).toEqual(emptyExtensionExportBadgeState());
  });
});
