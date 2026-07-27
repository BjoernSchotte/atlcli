import { describe, expect, it } from "bun:test";
import { collectArtifactHandleV1 } from "../../utils/export-jobs/artifact-delivery.js";

async function* chunksOf(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield part;
}

describe("artifact delivery handle (issue #118 Phase 0.5)", () => {
  it("assembles the exact bytes as one Blob-backed handle", async () => {
    const handle = await collectArtifactHandleV1(
      chunksOf(Uint8Array.of(37, 80), Uint8Array.of(68, 70)),
      { mediaType: "application/pdf", expectedByteLength: 4 },
    );
    expect(handle.size).toBe(4);
    expect(handle.mimeType).toBe("application/pdf");
    const blob = await handle.asBlob();
    expect(blob.size).toBe(4);
    expect(blob.type).toBe("application/pdf");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([37, 80, 68, 70]);
    expect([...(await handle.asUint8Array())]).toEqual([37, 80, 68, 70]);
  });

  it("rejects a stream that exceeds the committed length before draining it", async () => {
    let pulled = 0;
    async function* oversized(): AsyncIterable<Uint8Array> {
      for (;;) {
        pulled += 1;
        yield new Uint8Array(3);
      }
    }
    await expect(
      collectArtifactHandleV1(oversized(), {
        mediaType: "application/pdf",
        expectedByteLength: 5,
      }),
    ).rejects.toThrow("Retained artifact exceeds its committed length.");
    expect(pulled).toBe(2);
  });

  it("rejects a truncated stream", async () => {
    await expect(
      collectArtifactHandleV1(chunksOf(Uint8Array.of(1, 2)), {
        mediaType: "application/pdf",
        expectedByteLength: 3,
      }),
    ).rejects.toThrow("Retained artifact is truncated.");
  });

  it("honors an abort signal between chunks", async () => {
    const controller = new AbortController();
    async function* aborting(): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(1);
      controller.abort(new Error("stop"));
      yield Uint8Array.of(2);
    }
    await expect(
      collectArtifactHandleV1(aborting(), {
        mediaType: "application/pdf",
        expectedByteLength: 2,
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop");
  });
});
