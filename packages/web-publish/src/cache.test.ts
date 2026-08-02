import { describe, expect, test } from "bun:test";
import {
  digestPublicationPageCacheKeyV1,
  type PublicationPageCacheKeyInputV1,
} from "./cache.js";

const baseInput: PublicationPageCacheKeyInputV1 = {
  sourceId: "page-42",
  sourceVersion: "7",
  sourceRepresentation: "atlas_doc_format",
  sourcePolicyDigest: "source-policy-v1",
  decoderSchemaVersion: "decoder-v4",
  exportBlockSchemaVersion: "export-blocks-v2",
  macroCatalogVersion: "macro-catalog-v3",
  webTargetVersion: "web-target-v1",
  macroPolicyDigest: "macro-policy-v2",
  macroDependencyDigest: "no-live-dependencies",
  assetMetadataDigest: "attachments-v1",
  routeLinkPolicyDigest: "routes-links-v2",
  navigationDependencyDigest: "navigation-v1",
};

describe("publication page cache keys", () => {
  test("include all normalized-page inputs, not only the source version", async () => {
    const baseline = await digestPublicationPageCacheKeyV1(baseInput);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/u);
    expect(await digestPublicationPageCacheKeyV1({ ...baseInput })).toBe(baseline);

    for (const key of Object.keys(baseInput) as Array<keyof PublicationPageCacheKeyInputV1>) {
      const changed = await digestPublicationPageCacheKeyV1({
        ...baseInput,
        [key]: key === "sourceRepresentation" ? "storage" : `${baseInput[key]}-changed`,
      });
      expect(changed).not.toBe(baseline);
    }
  });

  test("rejects incomplete key inputs instead of silently weakening reuse", async () => {
    await expect(digestPublicationPageCacheKeyV1({
      ...baseInput,
      assetMetadataDigest: "",
    })).rejects.toThrow("assetMetadataDigest");
  });
});
