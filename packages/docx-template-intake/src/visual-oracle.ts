import type { DocxVisualAnalysisV1 } from "./visual-analysis.js";

export interface VisualOracleEntryV1 {
  key: string;
  assetSha256: string;
  relationshipRef: string;
  targetFingerprint: string;
  alternateBranch: string;
  crop: string;
  horizontalReference: string;
  verticalReference: string;
  section: number;
  master: string;
  adoption: "do-not-include";
}

/** Project only independently reviewable visual facts into the frozen oracle. */
export function projectVisualOracle(
  analysis: DocxVisualAnalysisV1
): readonly VisualOracleEntryV1[] {
  const adoptionByAsset = new Map(
    analysis.assetReview.map(({ asset, defaultDecision }) => [
      asset.sha256,
      defaultDecision,
    ])
  );
  return analysis.scenes.flatMap((scene) => {
    if (scene.compatibility !== "native") return [];
    return scene.representations.flatMap((representation, ordinal) => {
      if (
        !representation.selected ||
        !representation.assetSha256 ||
        representation.sourceUse.kind !== "relationship" ||
        !representation.sourceUse.relationshipRef ||
        !representation.sourceUse.targetFingerprint
      ) {
        return [];
      }
      return [
        {
          key: `${scene.id}.representation.${ordinal}`,
          assetSha256: representation.assetSha256,
          relationshipRef: representation.sourceUse.relationshipRef,
          targetFingerprint: representation.sourceUse.targetFingerprint,
          alternateBranch:
            representation.sourceUse.alternateContent?.branch ?? "",
          crop: JSON.stringify(scene.transform?.crop ?? null),
          horizontalReference:
            scene.placement?.kind === "anchor"
              ? scene.placement.horizontal.relativeFrom
              : "",
          verticalReference:
            scene.placement?.kind === "anchor"
              ? scene.placement.vertical.relativeFrom
              : "",
          section: scene.scope.section,
          master: scene.scope.master ?? "",
          adoption:
            adoptionByAsset.get(representation.assetSha256) ??
            "do-not-include",
        },
      ];
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
}

/** Field-addressed diff: one oracle mutation yields one responsible failure. */
export function compareVisualOracle(
  expected: readonly VisualOracleEntryV1[],
  actual: readonly VisualOracleEntryV1[]
): readonly string[] {
  const fields = [
    "assetSha256",
    "relationshipRef",
    "targetFingerprint",
    "alternateBranch",
    "crop",
    "horizontalReference",
    "verticalReference",
    "section",
    "master",
    "adoption",
  ] as const;
  const expectedByKey = new Map(expected.map((entry) => [entry.key, entry]));
  const actualByKey = new Map(actual.map((entry) => [entry.key, entry]));
  const differences: string[] = [];
  for (const key of [...new Set([...expectedByKey.keys(), ...actualByKey.keys()])].sort()) {
    const left = expectedByKey.get(key);
    const right = actualByKey.get(key);
    if (!left || !right) {
      differences.push(`${key}.presence`);
      continue;
    }
    for (const field of fields) {
      if (left[field] !== right[field]) {
        differences.push(`${key}.${field}`);
      }
    }
  }
  return differences;
}
