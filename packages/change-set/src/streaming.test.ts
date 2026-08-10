import { describe, expect, test } from "bun:test";
import {
  canonicalJsonBytesV1,
  canonicalJsonChunksV1,
  canonicalJsonV1,
  digestCanonicalJsonWithSinkV1,
  digestSnapshotV1,
  digestSnapshotWithSinkV1,
  sha256HexV1,
  type CanonicalChunkDigestSinkV1,
  type SpillNodeRecordV1,
  type SpillStoreV1,
} from "./index.js";

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class PortableTestDigestSink implements CanonicalChunkDigestSinkV1 {
  readonly chunks: Uint8Array[] = [];
  finishCalls = 0;
  abortCalls = 0;
  abortReason: unknown;

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk.slice());
  }

  async finish(): Promise<string> {
    this.finishCalls += 1;
    return sha256HexV1(concatenate(this.chunks));
  }

  abort(reason?: unknown): void {
    this.abortCalls += 1;
    this.abortReason = reason;
  }
}

describe("canonical JSON streaming", () => {
  test("is byte-identical to canonicalJsonV1 across small UTF-8 chunks", () => {
    const value = {
      z: [true, null, "🙂 umlaut ä", { beta: -0, alpha: "line\nquote\"" }],
      a: { deep: { two: 2, one: 1 } },
    };
    const chunks = [...canonicalJsonChunksV1(value, { chunkBytes: 7 })];

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 7)).toBe(true);
    expect(concatenate(chunks)).toEqual(canonicalJsonBytesV1(value));
    expect(new TextDecoder().decode(concatenate(chunks))).toBe(canonicalJsonV1(value));
  });

  test("matches canonical validation and budget failures", () => {
    expect(() => [...canonicalJsonChunksV1({ nested: { bad: undefined } })])
      .toThrow("$.nested.bad: expected JSON-only data");
    expect(() => [...canonicalJsonChunksV1([1, 2, 3], {
      chunkBytes: 2,
      budget: {
        maxDepth: 10,
        maxNodes: 100,
        maxStringBytes: 100,
        maxOutputBytes: 3,
      },
    })]).toThrow("output-byte budget exceeded");
    expect(() => [...canonicalJsonChunksV1({}, { chunkBytes: 0 })])
      .toThrow("chunkBytes must be between");
    expect(() => [...canonicalJsonChunksV1({}, { chunkBytes: 1024 * 1024 + 1 })])
      .toThrow("chunkBytes must be between");
  });

  test("produces the one-shot digest without retaining canonical output", async () => {
    const value = { outer: { b: 2, a: 1 }, list: [3, 2, 1] };
    const sink = new PortableTestDigestSink();

    const digest = await digestCanonicalJsonWithSinkV1(value, sink, {
      chunkBytes: 5,
    });

    expect(digest).toBe(await sha256HexV1(canonicalJsonBytesV1(value)));
    expect(sink.finishCalls).toBe(1);
    expect(sink.abortCalls).toBe(0);
    expect(sink.chunks.length).toBeGreaterThan(1);
  });

  test("aborts the sink on late validation and invalid digest failures", async () => {
    const validationSink = new PortableTestDigestSink();
    await expect(digestCanonicalJsonWithSinkV1(
      { a: "already written", z: undefined },
      validationSink,
      { chunkBytes: 4 },
    )).rejects.toThrow("JSON-only data");
    expect(validationSink.chunks.length).toBeGreaterThan(0);
    expect(validationSink.finishCalls).toBe(0);
    expect(validationSink.abortCalls).toBe(1);
    expect(validationSink.abortReason).toBeInstanceOf(Error);

    const digestError = new Error("invalid digest was rejected");
    const invalidSink: CanonicalChunkDigestSinkV1 = {
      write: () => undefined,
      finish: () => "not-sha256",
      abort: (reason) => {
        expect(reason).toBeInstanceOf(Error);
        throw digestError;
      },
    };
    await expect(digestCanonicalJsonWithSinkV1({}, invalidSink))
      .rejects.toThrow("incremental SHA-256 sink returned an invalid digest");
  });

  test("binds streamed snapshot digests to the exact source envelope", async () => {
    const sourceTree = { type: "doc", content: [{ type: "paragraph" }] };
    const sink = new PortableTestDigestSink();

    expect(await digestSnapshotWithSinkV1("atlas_doc_format", sourceTree, sink))
      .toBe(await digestSnapshotV1("atlas_doc_format", sourceTree));
  });
});

describe("SpillStoreV1 port", () => {
  test("carries bounded flat records without prescribing host persistence", async () => {
    const records: SpillNodeRecordV1[] = [];
    const store: SpillStoreV1 = {
      beginSnapshot: async () => undefined,
      appendRecords: async (batch) => {
        records.push(...batch);
      },
      finalizeSnapshot: async () => undefined,
      readChildWindow: async () => ({ records }),
      findCandidate: async () => ({ status: "none" }),
      readSubtreeValue: async () => ({ type: "paragraph" }),
      close: async () => undefined,
      erase: async () => undefined,
    };
    const record: SpillNodeRecordV1 = {
      side: "baseline",
      layer: "semantic",
      ordinal: 1,
      parentOrdinal: 0,
      childIndex: 0,
      path: ["content", 0],
      kind: "paragraph",
      shallow: { type: "paragraph" },
      subtreeDigest: "a".repeat(64),
    };

    await store.appendRecords([record]);
    expect((await store.readChildWindow({
      side: "baseline",
      layer: "semantic",
      parentOrdinal: 0,
      offset: 0,
      limit: 10,
    })).records).toEqual([record]);
  });
});
