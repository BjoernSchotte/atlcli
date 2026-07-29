import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import { buildDocx, para, pngFixtureBytes } from "./fixtures.js";
import {
  applyDocxZipCompressionPolicy,
  streamDocxOpc,
} from "./opc-stream.js";

interface CentralEntry {
  name: string;
  compression: number;
  flags: number;
}

function centralEntries(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: CentralEntry[] = [];
  for (let offset = 0; offset + 46 <= bytes.byteLength;) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({
      name,
      compression: view.getUint16(offset + 10, true),
      flags: view.getUint16(offset + 8, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function collect(
  source: AsyncIterable<Uint8Array>,
): Promise<{ bytes: Uint8Array; chunks: Uint8Array[] }> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    const owned = chunk.slice();
    chunks.push(owned);
    byteLength += owned.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, chunks };
}

function method(entries: CentralEntry[], name: string): number | undefined {
  return entries.find((entry) => entry.name === name)?.compression;
}

describe("DOCX OPC compression policy", () => {
  it("reapplies STORE for PNG/JPEG/GIF after a prepared archive is reopened", () => {
    const initial = new PizZip(buildDocx({ body: para("compression policy") }));
    initial.file("word/media/template.png", pngFixtureBytes(10, 10));
    initial.file("word/media/photo.jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
    initial.file("word/media/animation.gif", new TextEncoder().encode("GIF89a payload"));
    initial.file(
      "word/media/vector.svg",
      new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><text>compress me</text></svg>`),
    );

    const prepared = initial.generate({
      type: "uint8array",
      compression: "DEFLATE",
    }) as unknown as Uint8Array;
    const reopened = new PizZip(prepared);
    applyDocxZipCompressionPolicy(reopened);
    const finalBytes = reopened.generate({
      type: "uint8array",
      compression: "DEFLATE",
    }) as unknown as Uint8Array;
    const entries = centralEntries(finalBytes);

    expect(method(entries, "word/media/template.png")).toBe(0);
    expect(method(entries, "word/media/photo.jpeg")).toBe(0);
    expect(method(entries, "word/media/animation.gif")).toBe(0);
    expect(method(entries, "word/media/vector.svg")).toBe(8);
    expect(method(entries, "word/document.xml")).toBe(8);
  });
});

describe("streamDocxOpc", () => {
  it("emits deterministic bounded chunks with data descriptors and STORE raster media", async () => {
    const makeZip = (): PizZip => {
      const zip = new PizZip(buildDocx({ body: para("streamed body ".repeat(2_000)) }));
      const raster = new Uint8Array(256 * 1024);
      for (let index = 0; index < raster.byteLength; index += 1) {
        raster[index] = (index * 131 + 17) & 0xff;
      }
      zip.file("word/media/large.png", raster, { binary: true });
      for (const entry of Object.values(zip.files)) {
        entry.date = new Date("2026-07-29T10:00:00.000Z");
      }
      return zip;
    };

    const first = await collect(streamDocxOpc(makeZip()));
    const second = await collect(streamDocxOpc(makeZip()));
    const entries = centralEntries(first.bytes);

    expect(first.chunks.length).toBeGreaterThan(3);
    expect(Math.max(...first.chunks.map((chunk) => chunk.byteLength))).toBeLessThan(70 * 1024);
    expect(first.bytes).toEqual(second.bytes);
    expect(method(entries, "word/media/large.png")).toBe(0);
    expect(method(entries, "word/document.xml")).toBe(8);
    expect(entries.every((entry) => (entry.flags & 0x0008) !== 0)).toBe(true);
    expect(new PizZip(first.bytes).file("word/document.xml")?.asText()).toContain("streamed body");
    expect(new PizZip(first.bytes).file("word/media/large.png")?.asUint8Array().byteLength)
      .toBe(256 * 1024);
  });

  it("streams one replacement part from separate UTF-8 fragments", async () => {
    const sentinel = `<w:p><w:r><w:t>ATLCLI_BODY_SENTINEL</w:t></w:r></w:p>`;
    const zip = new PizZip(buildDocx({ body: sentinel }));
    const original = zip.file("word/document.xml")?.asText() ?? "";
    const [prefix, suffix] = original.split(sentinel);
    const body = para("chapter 😀 ".repeat(30_000));

    const { bytes, chunks } = await collect(streamDocxOpc(zip, {
      replacement: {
        path: "word/document.xml",
        fragments: [prefix!, body, suffix!],
      },
    }));

    const document = new PizZip(bytes).file("word/document.xml")?.asText() ?? "";
    expect(document).toBe(prefix! + body + suffix!);
    expect(document).not.toContain("ATLCLI_BODY_SENTINEL");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.byteLength < bytes.byteLength)).toBe(true);
  });

  it("streams a deferred media part in bounded chunks and enforces its length", async () => {
    const zip = new PizZip(buildDocx({ body: para("deferred media") }));
    zip.file("word/media/deferred.png", EMPTY_MEDIA, { binary: true });
    const media = new Uint8Array(180 * 1024);
    for (let index = 0; index < media.byteLength; index += 1) {
      media[index] = (index * 29 + 7) & 0xff;
    }
    const partSources = new Map([
      ["word/media/deferred.png", {
        byteLength: media.byteLength,
        chunks: (async function* (): AsyncIterable<Uint8Array> {
          yield media;
        })(),
      }],
    ]);

    const { bytes, chunks } = await collect(streamDocxOpc(zip, { partSources }));
    const reopened = new PizZip(bytes);
    expect(reopened.file("word/media/deferred.png")?.asUint8Array()).toEqual(media);
    expect(method(centralEntries(bytes), "word/media/deferred.png")).toBe(0);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThan(70 * 1024);

    const shortSource = new Map([
      ["word/media/deferred.png", {
        byteLength: media.byteLength + 1,
        chunks: (async function* (): AsyncIterable<Uint8Array> {
          yield media;
        })(),
      }],
    ]);
    await expect(collect(streamDocxOpc(zip, { partSources: shortSource })))
      .rejects.toThrow("DOCX deferred part length changed");
  });

  it("stops between chunks when cancellation is requested", async () => {
    const zip = new PizZip(buildDocx({ body: para("cancel ".repeat(100_000)) }));
    const controller = new AbortController();
    const iterator = streamDocxOpc(zip, { signal: controller.signal })[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});

const EMPTY_MEDIA = new Uint8Array();
