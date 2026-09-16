/** Private Bun ↔ Rust pipe framing. No tenant data belongs in framing errors. */
export const NFS_BRIDGE_VERSION = 2;
export const NFS_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeNfsFrame(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined || json.length > NFS_MAX_FRAME_BYTES) {
    throw new Error("Invalid NFS bridge frame size");
  }
  const size = Buffer.byteLength(json);
  if (size > NFS_MAX_FRAME_BYTES) throw new Error("Invalid NFS bridge frame size");
  const frame = Buffer.allocUnsafe(size + 4);
  frame.writeUInt32BE(size);
  frame.write(json, 4, size, "utf8");
  return frame;
}

/** Pull-based decoding bounds allocation and lets callers apply backpressure. */
export async function* readNfsFrames(source: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const header = Buffer.alloc(4);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let headerBytes = 0;
  let body: Buffer | undefined;
  let bodyBytes = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!body) {
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        header.set(chunk.subarray(offset, offset + count), headerBytes);
        offset += count;
        headerBytes += count;
        if (headerBytes < 4) continue;
        const size = header.readUInt32BE();
        if (size === 0 || size > NFS_MAX_FRAME_BYTES) {
          throw new Error("Invalid NFS bridge frame size");
        }
        body = Buffer.allocUnsafe(size);
        bodyBytes = 0;
      }
      const count = Math.min(body.length - bodyBytes, chunk.length - offset);
      body.set(chunk.subarray(offset, offset + count), bodyBytes);
      bodyBytes += count;
      offset += count;
      if (bodyBytes === body.length) {
        let value: unknown;
        try {
          value = JSON.parse(decoder.decode(body));
        } catch {
          throw new Error("Invalid NFS bridge JSON or UTF-8");
        }
        body = undefined;
        headerBytes = 0;
        bodyBytes = 0;
        yield value;
      }
    }
  }
  if (headerBytes !== 0 || body) throw new Error("Truncated NFS bridge frame");
}
