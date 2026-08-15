import { describe, expect, it } from "bun:test";
import { parseBatchManifest, validateBatchState } from "./batch-manifest.js";

const VALID = `schema: atlcli.docx-batch-manifest/1
batchId: wave-1
destination:
  spaceKey: DOCSY
  staging: private
defaults:
  titleConflict: rename
  splitHeading: 2
documents:
  - sourcePath: guides/admin.docx
    relativeParentPath: guides
    labels: [imported]
  - sourcePath: intro.docx
    title: Introduction
`;

describe("parseBatchManifest", () => {
  it("parses a valid manifest with a stable digest", async () => {
    const a = await parseBatchManifest(VALID);
    expect(a.errors).toEqual([]);
    expect(a.manifest!.batchId).toBe("wave-1");
    expect(a.manifest!.destination.staging).toBe("private");
    expect(a.manifest!.defaults).toEqual({ titleConflict: "rename", splitHeading: 2 });
    expect(a.manifest!.documents[0].relativeParentPath).toBe("guides");
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    const b = await parseBatchManifest(VALID);
    expect(b.digest).toBe(a.digest);
  });

  it("collects all violations: traversal, duplicates, bad values", async () => {
    const bad = await parseBatchManifest(`schema: atlcli.docx-batch-manifest/1
batchId: "BAD ID"
destination:
  spaceKey: DOCSY
  staging: public
defaults:
  titleConflict: maybe
  splitHeading: 9
documents:
  - sourcePath: ../escape.docx
  - sourcePath: a.docx
    relativeParentPath: "x/../y"
  - sourcePath: a.docx
`);
    const text = bad.errors.join("\n");
    expect(text).toContain('"batchId"');
    expect(text).toContain("staging");
    expect(text).toContain("titleConflict");
    expect(text).toContain("splitHeading");
    expect(text).toContain('without ".."');
    expect(text).toContain("invalid segments");
    expect(text).toContain("duplicates");
  });

  it("rejects aliases and empty documents", async () => {
    expect((await parseBatchManifest("a: &x 1\nb: *x\n")).errors.join()).toContain("anchors/aliases");
    const empty = await parseBatchManifest(
      VALID.replace(/documents:[\s\S]*$/, "documents: []\n"),
    );
    expect(empty.errors.join()).toContain("non-empty array");
  });
});

describe("validateBatchState", () => {
  const state = {
    schema: "atlcli.docx-batch-state/1",
    batchId: "wave-1",
    manifestDigest: "d".repeat(64),
    folderPages: {},
    items: [],
  };

  it("accepts matching identity and rejects drift", () => {
    expect(validateBatchState(state, "wave-1", "d".repeat(64)).state).toBeDefined();
    expect(validateBatchState(state, "other", "d".repeat(64)).reason).toContain("belongs to batch");
    expect(validateBatchState(state, "wave-1", "e".repeat(64)).reason).toContain("manifest changed");
    expect(validateBatchState(null, "wave-1", "d".repeat(64)).reason).toContain("not an object");
  });
});
