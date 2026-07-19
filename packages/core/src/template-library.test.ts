/**
 * Pure-function + WebCrypto tests for the template library (spec 007 T2.4).
 *
 * No mocking: `resolveTemplate` is exercised with plain arrays, and the hash
 * paths run the real `crypto.subtle` digest over real byte arrays. The
 * in-test {@link TemplateLibrary} is a real implementation over an in-memory
 * map, not a mock.
 */
import { describe, expect, it } from "bun:test";
import {
  resolveTemplate,
  resolveAndLoadTemplate,
  sha256Hex,
  verifyTemplateBytes,
  TemplateIntegrityError,
  TemplateNotFoundError,
  TemplateResolutionConflictError,
  type TemplateLibrary,
  type TemplateLibraryEntry,
} from "./template-library.js";

function entry(over: Partial<TemplateLibraryEntry>): TemplateLibraryEntry {
  return {
    id: "com.acme.doc",
    displayName: "Acme Doc",
    engine: "typst",
    scope: "global",
    sha256: "0".repeat(64),
    size: 0,
    uploadedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("resolveTemplate", () => {
  it("prefers a space-scoped entry over the global entry of the same id", () => {
    const globalE = entry({ scope: "global", displayName: "global" });
    const spaceE = entry({ scope: "space", spaceKey: "DOCSY", displayName: "space" });
    const got = resolveTemplate([globalE, spaceE], "com.acme.doc", "typst", "DOCSY");
    expect(got?.displayName).toBe("space");
  });

  it("falls back to the global entry when the space has no override", () => {
    const globalE = entry({ scope: "global", displayName: "global" });
    const otherSpace = entry({ scope: "space", spaceKey: "OTHER", displayName: "other" });
    const got = resolveTemplate([globalE, otherSpace], "com.acme.doc", "typst", "DOCSY");
    expect(got?.displayName).toBe("global");
  });

  it("returns undefined for an unknown id", () => {
    const globalE = entry({ scope: "global" });
    expect(resolveTemplate([globalE], "nope", "typst", "DOCSY")).toBeUndefined();
  });

  it("never resolves a wrong-engine entry, even as the only id match", () => {
    // Mixed-engine array: a docx entry sharing the requested id must not win.
    const docxE = entry({ engine: "docx", scope: "global", displayName: "docx-one" });
    expect(resolveTemplate([docxE], "com.acme.doc", "typst")).toBeUndefined();
    // And with a space key: still nothing, no wrong-engine leak.
    expect(resolveTemplate([docxE], "com.acme.doc", "typst", "DOCSY")).toBeUndefined();
  });

  it("throws on two same-scope, same-engine entries sharing an id (global)", () => {
    const a = entry({ scope: "global", displayName: "a" });
    const b = entry({ scope: "global", displayName: "b" });
    expect(() => resolveTemplate([a, b], "com.acme.doc", "typst")).toThrow(
      TemplateResolutionConflictError
    );
  });

  it("throws on two same-space, same-engine entries sharing an id", () => {
    const a = entry({ scope: "space", spaceKey: "DOCSY", displayName: "a" });
    const b = entry({ scope: "space", spaceKey: "DOCSY", displayName: "b" });
    expect(() => resolveTemplate([a, b], "com.acme.doc", "typst", "DOCSY")).toThrow(
      TemplateResolutionConflictError
    );
  });

  it("does not treat two entries for different spaces as a conflict", () => {
    const a = entry({ scope: "space", spaceKey: "DOCSY", displayName: "docsy" });
    const b = entry({ scope: "space", spaceKey: "OTHER", displayName: "other" });
    expect(resolveTemplate([a, b], "com.acme.doc", "typst", "DOCSY")?.displayName).toBe("docsy");
  });
});

describe("verifyTemplateBytes", () => {
  it("accepts bytes whose hash matches the entry", async () => {
    const bytes = new TextEncoder().encode("template payload");
    const e = entry({ sha256: await sha256Hex(bytes), size: bytes.byteLength });
    await expect(verifyTemplateBytes(e, bytes)).resolves.toBeUndefined();
  });

  it("throws the typed mismatch error on a flipped bit", async () => {
    const bytes = new TextEncoder().encode("template payload");
    const e = entry({ sha256: await sha256Hex(bytes), size: bytes.byteLength });
    const tampered = Uint8Array.from(bytes);
    tampered[0] ^= 0x01;
    await expect(verifyTemplateBytes(e, tampered)).rejects.toBeInstanceOf(TemplateIntegrityError);
  });
});

/** Real in-memory library — verifies the resolve/load/verify pipeline end to end. */
class MemoryLibrary implements TemplateLibrary {
  constructor(
    private readonly entries: TemplateLibraryEntry[],
    private readonly store: Map<string, Uint8Array>
  ) {}
  list(engine: TemplateLibraryEntry["engine"]): Promise<TemplateLibraryEntry[]> {
    return Promise.resolve(this.entries.filter((e) => e.engine === engine));
  }
  getBytes(e: TemplateLibraryEntry): Promise<Uint8Array> {
    const b = this.store.get(e.id + ":" + (e.spaceKey ?? "global"));
    if (!b) throw new Error("missing bytes");
    return Promise.resolve(b);
  }
}

describe("resolveAndLoadTemplate", () => {
  it("returns verified bytes on a match", async () => {
    const bytes = new TextEncoder().encode("real archive bytes");
    const e = entry({ scope: "global", sha256: await sha256Hex(bytes), size: bytes.byteLength });
    const lib = new MemoryLibrary([e], new Map([["com.acme.doc:global", bytes]]));
    const { entry: got, bytes: gotBytes } = await resolveAndLoadTemplate(lib, "com.acme.doc", "typst");
    expect(got.id).toBe("com.acme.doc");
    expect(new TextDecoder().decode(gotBytes)).toBe("real archive bytes");
  });

  it("rejects with TemplateNotFoundError for an unknown id", async () => {
    const lib = new MemoryLibrary([], new Map());
    await expect(resolveAndLoadTemplate(lib, "nope", "typst")).rejects.toBeInstanceOf(
      TemplateNotFoundError
    );
  });

  it("rejects on a byte/hash mismatch without exposing the unverified bytes", async () => {
    const good = new TextEncoder().encode("declared bytes");
    // Stored bytes differ from what the entry's sha256/size describe.
    const tampered = new TextEncoder().encode("declared bytez");
    const e = entry({ scope: "global", sha256: await sha256Hex(good), size: good.byteLength });
    const lib = new MemoryLibrary([e], new Map([["com.acme.doc:global", tampered]]));
    let leaked: Uint8Array | undefined;
    try {
      const r = await resolveAndLoadTemplate(lib, "com.acme.doc", "typst");
      leaked = r.bytes;
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateIntegrityError);
    }
    expect(leaked).toBeUndefined();
  });

  it("rejects on a declared-size mismatch before hashing", async () => {
    const bytes = new TextEncoder().encode("twelve bytes"); // 12 bytes
    const e = entry({ scope: "global", sha256: await sha256Hex(bytes), size: 999 });
    const lib = new MemoryLibrary([e], new Map([["com.acme.doc:global", bytes]]));
    await expect(resolveAndLoadTemplate(lib, "com.acme.doc", "typst")).rejects.toBeInstanceOf(
      TemplateIntegrityError
    );
  });
});
