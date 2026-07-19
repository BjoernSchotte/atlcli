/**
 * Deterministic packing + payload-hash tests (spec 007 T2.4).
 *
 * No mocking: real archives are built by `packTemplate` and read back by
 * `unpackTemplate`; hashes are real WebCrypto digests. The `payloadSha256`
 * assertion pins a fixed vector recomputed from the documented canonicalization,
 * not merely "some hash changed".
 */
import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@atlcli/core";
import { packTemplate, computePayloadSha256, type TemplatePackContents } from "./pack.js";
import { unpackTemplate } from "./unpack.js";
import { TEMPLATE_PACK_MANIFEST_NAME, type TemplateManifest } from "./manifest.js";

function typstManifest(): TemplateManifest {
  return {
    schemaVersion: 1,
    id: "com.acme.tech-doc",
    name: "Acme Tech Doc",
    version: "1.0.0",
    engine: { kind: "typst", api: "wiki.pdf-template/v1", entry: "template.typ" },
  };
}

function contents(over?: Partial<Record<string, string>>): TemplatePackContents {
  const enc = (s: string) => new TextEncoder().encode(s);
  const files: Record<string, Uint8Array> = {
    "template.typ": enc(over?.["template.typ"] ?? "#let render(meta, body, settings) = body"),
    "assets/logo.svg": enc(over?.["assets/logo.svg"] ?? "<svg></svg>"),
  };
  return { manifest: typstManifest(), files };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("packTemplate round-trip", () => {
  it("pack → sha256Hex → unpack yields identical file bytes and manifest", async () => {
    const c = contents();
    const packed = await packTemplate(c);
    // integrity hash of the delivered archive bytes (the entry-metadata quantity)
    const archiveHash = await sha256Hex(packed);
    expect(archiveHash).toMatch(/^[0-9a-f]{64}$/);

    const { manifest, files } = unpackTemplate(packed);
    expect(manifest.id).toBe("com.acme.tech-doc");
    expect(manifest.engine.entry).toBe("template.typ");
    expect(manifest.provenance?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(files).sort()).toEqual(["assets/logo.svg", "template.typ"]);
    expect(bytesEqual(files["template.typ"], c.files["template.typ"])).toBe(true);
    expect(bytesEqual(files["assets/logo.svg"], c.files["assets/logo.svg"])).toBe(true);
  });

  it("does not include the manifest file in the unpacked payload map", async () => {
    const packed = await packTemplate(contents());
    const { files } = unpackTemplate(packed);
    expect(files[TEMPLATE_PACK_MANIFEST_NAME]).toBeUndefined();
  });

  it("rejects a files map that contains the reserved manifest path", async () => {
    const c = contents();
    (c.files as Record<string, Uint8Array>)[TEMPLATE_PACK_MANIFEST_NAME] = new Uint8Array([1]);
    await expect(packTemplate(c)).rejects.toThrow(/reserved manifest path/);
  });
});

describe("determinism", () => {
  it("packs the same input twice byte-identically", async () => {
    const a = await packTemplate(contents());
    const b = await packTemplate(contents());
    expect(bytesEqual(a, b)).toBe(true);
  });

  it("is independent of manifest key insertion order (stable serialization)", async () => {
    const c1 = contents();
    const c2 = contents();
    // Rebuild manifest of c2 with a different key order.
    c2.manifest = {
      engine: { entry: "template.typ", api: "wiki.pdf-template/v1", kind: "typst" },
      version: "1.0.0",
      name: "Acme Tech Doc",
      id: "com.acme.tech-doc",
      schemaVersion: 1,
    } as TemplateManifest;
    const a = await packTemplate(c1);
    const b = await packTemplate(c2);
    expect(bytesEqual(a, b)).toBe(true);
  });
});

describe("provenance.payloadSha256", () => {
  it("is stable across repacks", async () => {
    const p1 = unpackTemplate(await packTemplate(contents())).manifest.provenance!.payloadSha256;
    const p2 = unpackTemplate(await packTemplate(contents())).manifest.provenance!.payloadSha256;
    expect(p1).toBe(p2);
  });

  it("changes when any non-manifest file's bytes change", async () => {
    const base = unpackTemplate(await packTemplate(contents())).manifest.provenance!.payloadSha256;
    const changed = unpackTemplate(
      await packTemplate(contents({ "assets/logo.svg": "<svg><rect/></svg>" }))
    ).manifest.provenance!.payloadSha256;
    expect(changed).not.toBe(base);
  });

  it("matches a vector recomputed from the documented canonicalization", async () => {
    const files: Record<string, Uint8Array> = {
      "b.txt": new TextEncoder().encode("bbb"),
      "a.txt": new TextEncoder().encode("aaaa"),
    };
    // Documented canonicalization: for each member in ascending path order,
    // three lines — path, byteLength, lowercase-hex sha256 — newline-joined,
    // then sha256 of the UTF-8 bytes.
    const lines: string[] = [];
    for (const path of Object.keys(files).sort()) {
      lines.push(path, String(files[path].byteLength), await sha256Hex(files[path]));
    }
    const expected = await sha256Hex(new TextEncoder().encode(lines.join("\n")));

    expect(await computePayloadSha256(files)).toBe(expected);

    // And the same value ends up embedded in a packed manifest (entry must be a
    // real member, so point it at a.txt for this vector fixture).
    const manifest = { ...typstManifest(), engine: { ...typstManifest().engine, entry: "a.txt" } };
    const packed = await packTemplate({ manifest, files });
    expect(unpackTemplate(packed).manifest.provenance!.payloadSha256).toBe(expected);
  });

  it("excludes the manifest from the payload digest (not self-referential)", async () => {
    // Two packs with identical payload but different manifest metadata must
    // share the same payloadSha256.
    const files = contents().files;
    const m1 = typstManifest();
    const m2 = { ...typstManifest(), name: "A Different Display Name" };
    const p1 = unpackTemplate(await packTemplate({ manifest: m1, files })).manifest.provenance!
      .payloadSha256;
    const p2 = unpackTemplate(await packTemplate({ manifest: m2, files })).manifest.provenance!
      .payloadSha256;
    expect(p1).toBe(p2);
  });
});
