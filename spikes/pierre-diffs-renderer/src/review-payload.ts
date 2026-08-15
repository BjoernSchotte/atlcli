type JsonObject = Record<string, unknown>;

export interface PierreReviewPayload {
  title: string;
  comparison: string;
  patch: string;
  summary: {
    added: number;
    removed: number;
    modified: number;
    moved: number;
    review: number;
    coverage: "complete" | "degraded";
  };
}

function object(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${name} object.`);
  }
  return value as JsonObject;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function toPierreReviewPayload(value: unknown): PierreReviewPayload {
  const review = object(value, "review");
  const changeSet = object(review.changeSet, "changeSet");
  const subject = object(changeSet.subject, "changeSet.subject");
  const baseline = object(changeSet.baseline, "changeSet.baseline");
  const target = object(changeSet.target, "changeSet.target");
  const summary = object(changeSet.summary, "changeSet.summary");
  const completeness = object(changeSet.completeness, "changeSet.completeness");
  const textDiff = object(review.textDiff, "textDiff");
  if (
    review.format !== "review"
    || changeSet.schema !== "atlcli.change-set/1"
    || typeof textDiff.unified !== "string"
  ) {
    throw new Error("atlcli did not return the expected review JSON contract.");
  }

  return {
    title: typeof subject.label === "string" ? subject.label : "Wiki page review",
    comparison: `Version ${String(baseline.revision)} → ${String(target.revision)} · ${String(target.deployment)} · ${String(target.representation)}`,
    patch: textDiff.unified,
    summary: {
      added: count(summary.inserts),
      removed: count(summary.deletes),
      modified: count(summary.modifies),
      moved: count(summary.moves),
      review: count(summary.opaque),
      coverage: completeness.status === "complete" ? "complete" : "degraded",
    },
  };
}
