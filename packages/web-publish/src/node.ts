import { open, lstat } from "node:fs/promises";

export interface BoundedPublicationJsonReadOptionsV1 {
  maxBytes: number;
}

export * from "./node-cache.js";

export const DEFAULT_PUBLICATION_JSON_MAX_BYTES_V1 = 64 * 1024 * 1024;

export class PublicationFileReadErrorV1 extends Error {
  constructor(
    public readonly kind: "not-regular-file" | "symlink" | "too-large" | "changed-during-read",
    message: string,
  ) {
    super(message);
    this.name = "PublicationFileReadErrorV1";
  }
}

export async function readBoundedPublicationJsonV1(
  path: string,
  options: BoundedPublicationJsonReadOptionsV1 = {
    maxBytes: DEFAULT_PUBLICATION_JSON_MAX_BYTES_V1,
  },
): Promise<unknown> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }
  const before = await lstat(path);
  if (before.isSymbolicLink()) {
    throw new PublicationFileReadErrorV1("symlink", "Publication JSON paths must not be symlinks.");
  }
  if (!before.isFile()) {
    throw new PublicationFileReadErrorV1("not-regular-file", "Publication JSON path is not a regular file.");
  }
  if (before.size > options.maxBytes) {
    throw new PublicationFileReadErrorV1("too-large", "Publication JSON exceeds the configured byte limit.");
  }

  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new PublicationFileReadErrorV1("not-regular-file", "Opened publication JSON is not a regular file.");
    }
    if (opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new PublicationFileReadErrorV1("changed-during-read", "Publication JSON changed before it could be read.");
    }
    if (opened.size > options.maxBytes) {
      throw new PublicationFileReadErrorV1("too-large", "Publication JSON exceeds the configured byte limit.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new PublicationFileReadErrorV1("changed-during-read", "Publication JSON changed while it was read.");
    }
    if (bytes.byteLength > options.maxBytes) {
      throw new PublicationFileReadErrorV1("too-large", "Publication JSON exceeds the configured byte limit.");
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}
