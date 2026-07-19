/**
 * Reader security tests (spec 007 T2.4) — real crafted archives, no mocking.
 *
 * Evil archives are built directly with PizZip (path traversal, symlinks,
 * over-cap members, zip bombs) and fed to `unpackTemplate`; each must be
 * rejected with the matching typed {@link TemplatePackError.kind}.
 */
import { describe, expect, it } from "bun:test";
import PizZipDefault from "pizzip";
import {
  unpackTemplate,
  TemplatePackError,
  MAX_TEMPLATE_PACK_BYTES,
  MAX_TEMPLATE_PACK_FILE_BYTES,
  MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES,
  type TemplatePackErrorKind,
} from "./unpack.js";
import { TEMPLATE_PACK_MANIFEST_NAME } from "./manifest.js";

/** Raw PizZip surface (cast to reach the determinism/permission options). */
interface RawZip {
  file(
    path: string,
    content: Uint8Array | string,
    options?: { date?: Date; unixPermissions?: number }
  ): unknown;
  generate(options: {
    type: "uint8array";
    compression: "DEFLATE";
    platform?: "DOS" | "UNIX";
  }): Uint8Array;
}
const RawPizZip = PizZipDefault as unknown as { new (): RawZip };

const DATE = new Date(1980, 0, 1, 0, 0, 0);

function manifestJson(entry = "template.typ"): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "com.acme.doc",
    name: "Acme",
    version: "1.0.0",
    engine: { kind: "typst", api: "wiki.pdf-template/v1", entry },
  });
}

/** Build a raw archive with a valid manifest plus caller-supplied extra entries. */
function buildRaw(
  extra: (zip: RawZip) => void,
  opts: { platform?: "DOS" | "UNIX"; withEntry?: boolean } = {}
): Uint8Array {
  const zip = new RawPizZip();
  zip.file(TEMPLATE_PACK_MANIFEST_NAME, manifestJson(), { date: DATE });
  if (opts.withEntry !== false) {
    zip.file("template.typ", "#let render(meta, body, settings) = body", { date: DATE });
  }
  extra(zip);
  return zip.generate({ type: "uint8array", compression: "DEFLATE", platform: opts.platform ?? "DOS" });
}

function expectKind(fn: () => void, kind: TemplatePackErrorKind): void {
  try {
    fn();
    throw new Error("expected TemplatePackError, none thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(TemplatePackError);
    expect((err as TemplatePackError).kind).toBe(kind);
  }
}

describe("path traversal rejection", () => {
  it("rejects a `../evil.typ` entry", () => {
    const bytes = buildRaw((z) => z.file("../evil.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });

  it("rejects an absolute path", () => {
    const bytes = buildRaw((z) => z.file("/etc/passwd", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });

  it("rejects a backslash path", () => {
    const bytes = buildRaw((z) => z.file("dir\\evil.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });

  it("rejects a nested `..` segment", () => {
    const bytes = buildRaw((z) => z.file("a/../../evil.typ", "x", { date: DATE }));
    expectKind(() => unpackTemplate(bytes), "path-traversal");
  });
});

describe("symlink rejection", () => {
  it("rejects a symlink entry (S_IFLNK)", () => {
    const bytes = buildRaw(
      (z) => z.file("link.typ", "/etc/passwd", { date: DATE, unixPermissions: 0o120777 }),
      { platform: "UNIX" }
    );
    expectKind(() => unpackTemplate(bytes), "symlink");
  });
});

describe("manifest / entry integrity", () => {
  it("rejects a missing engine.entry member", () => {
    // Manifest points at template.typ but the archive omits it.
    const bytes = buildRaw(() => {}, { withEntry: false });
    expectKind(() => unpackTemplate(bytes), "missing-entry");
  });

  it("rejects a missing manifest", () => {
    const zip = new RawPizZip();
    zip.file("template.typ", "body", { date: DATE });
    const bytes = zip.generate({ type: "uint8array", compression: "DEFLATE", platform: "DOS" });
    expectKind(() => unpackTemplate(bytes), "missing-manifest");
  });

  it("rejects a non-zip buffer", () => {
    expectKind(() => unpackTemplate(new TextEncoder().encode("not a zip")), "not-zip");
  });
});

describe("size caps", () => {
  it("rejects an archive over the 30 MiB outer cap (before unzip)", () => {
    // A buffer larger than the cap is rejected on length alone, before parsing.
    const oversized = new Uint8Array(MAX_TEMPLATE_PACK_BYTES + 1);
    expectKind(() => unpackTemplate(oversized), "too-large-archive");
  });

  it("rejects a member over the per-file cap by declared size", () => {
    const big = new Uint8Array(MAX_TEMPLATE_PACK_FILE_BYTES + 1024); // zeros, compresses tiny
    const bytes = buildRaw((z) => z.file("huge.bin", big, { date: DATE }));
    expect(bytes.byteLength).toBeLessThan(1024 * 1024); // archive stays small
    expectKind(() => unpackTemplate(bytes), "file-too-large");
  });

  it("aborts on declared cumulative uncompressed size before inflating (zip bomb)", () => {
    // Three 30 MiB zero members: each is under the 32 MiB per-file cap, but the
    // cumulative declared 90 MiB exceeds the 64 MiB cap. The archive itself is a
    // few KB compressed — proving the guard accounts DECLARED uncompressed size,
    // not compressed bytes, and trips in the pre-inflation pass.
    const chunk = () => new Uint8Array(30 * 1024 * 1024);
    const bytes = buildRaw((z) => {
      z.file("a.bin", chunk(), { date: DATE });
      z.file("b.bin", chunk(), { date: DATE });
      z.file("c.bin", chunk(), { date: DATE });
    });
    expect(bytes.byteLength).toBeLessThan(1024 * 1024);
    expect(90 * 1024 * 1024).toBeGreaterThan(MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES);
    expectKind(() => unpackTemplate(bytes), "uncompressed-too-large");
  });
});
