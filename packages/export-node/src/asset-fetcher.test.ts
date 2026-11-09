import { expect, test } from "bun:test";
import { tokenAssetFetcher, type AssetClient } from "./asset-fetcher.js";

test("tokenAssetFetcher retries the attachment listing after a transient failure", async () => {
  let listings = 0;
  const client = {
    async listAttachments() {
      listings += 1;
      if (listings === 1) throw new Error("429 rate limited");
      return [{ id: "att1", filename: "a.png", version: 1 }];
    },
    async downloadAttachment() {
      return new Uint8Array([1, 2, 3]);
    },
  } as unknown as AssetClient;
  const fetcher = tokenAssetFetcher(client, { getOrLoad: (_key, load) => load() });
  const ref = { url: "a.png", pageId: "1", filename: "a.png" };

  await expect(fetcher.fetch(ref)).rejects.toThrow("429");
  expect([...(await fetcher.fetch(ref))]).toEqual([1, 2, 3]);
  expect(listings).toBe(2);
});
