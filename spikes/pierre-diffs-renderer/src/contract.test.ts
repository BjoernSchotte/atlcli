import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { toPierreReviewPayload } from "./review-payload.js";

const ATLCLI_JSDIFF_PATCH = `Index: Version 1
===================================================================
--- Version 1\t
+++ Version 1\t
@@ -1,2 +1,2 @@
-Status: geplant
+Status: bestätigt
 Unverändert
`;

describe("Pierre renderer boundary", () => {
  test("parses the jsdiff patch shape emitted by atlcli", () => {
    const patches = parsePatchFiles(ATLCLI_JSDIFF_PATCH, "synthetic");

    expect(patches).toHaveLength(1);
    expect(patches[0]?.files).toHaveLength(1);
    expect(patches[0]?.files[0]?.hunks).toHaveLength(1);
    expect(patches[0]?.files[0]?.deletionLines).toContain("Status: geplant\n");
    expect(patches[0]?.files[0]?.additionLines).toContain("Status: bestätigt\n");
  });
});

describe("review payload adapter", () => {
  test("maps the actual atlcli.change-set/1 field names", () => {
    const payload = toPierreReviewPayload({
      format: "review",
      changeSet: {
        schema: "atlcli.change-set/1",
        subject: { label: "Synthetic page" },
        baseline: { revision: "1" },
        target: { revision: "3", deployment: "cloud", representation: "atlas_doc_format" },
        summary: { inserts: 4, deletes: 1, modifies: 2, moves: 3, opaque: 1 },
        completeness: { status: "complete" },
      },
      textDiff: { unified: ATLCLI_JSDIFF_PATCH },
    });

    expect(payload.title).toBe("Synthetic page");
    expect(payload.comparison).toBe("Version 1 → 3 · cloud · atlas_doc_format");
    expect(payload.summary).toEqual({
      added: 4,
      removed: 1,
      modified: 2,
      moved: 3,
      review: 1,
      coverage: "complete",
    });
  });
});
