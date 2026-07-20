/**
 * Cross-plan archive-policy conformance corpus (spec 011, Security hardening).
 *
 * 011 does NOT own the `.wiki-pdf-template` archive validator — folder 007 owns
 * `@atlcli/template-pack` (`unpackTemplate`, the size/traversal/symlink caps).
 * This module is 011's half of the split: an adversarial corpus of hand-built
 * malicious `.wiki-pdf-template` archives that the gate (`archive-corpus.test.ts`)
 * feeds through the REAL `unpackTemplate`, asserting each is rejected with the
 * matching typed error kind. A case that unpacks successfully — or that trips a
 * DIFFERENT guard than intended — fails the gate, so a future loosening of
 * 007's validator can never silently accept a traversal / symlink / zip-bomb.
 *
 * Archives are built with PizZip (the same lib `unpackTemplate` reads), no
 * mocks — real central-directory entries with real declared sizes.
 */
import PizZip from "pizzip";
import {
  MAX_TEMPLATE_PACK_ENTRIES,
  MAX_TEMPLATE_PACK_FILE_BYTES,
  TEMPLATE_PACK_MANIFEST_NAME,
  type TemplatePackErrorKind,
} from "@atlcli/template-pack";

const DATE = new Date(1980, 0, 1, 0, 0, 0);

/** Raw PizZip surface (cast to reach the determinism/permission options). */
interface RawZip {
  file(
    path: string,
    content: Uint8Array | string,
    options?: { date?: Date; unixPermissions?: number },
  ): unknown;
  generate(options: {
    type: "uint8array";
    compression: "DEFLATE";
    platform?: "DOS" | "UNIX";
  }): Uint8Array;
}
const RawPizZip = PizZip as unknown as { new (): RawZip };

function manifestJson(entry = "template.typ"): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "com.atlcli.adversarial",
    name: "Adversarial",
    version: "1.0.0",
    engine: { kind: "typst", api: "wiki.pdf-template/v1", entry },
  });
}

/** A minimal VALID archive (the positive control — must unpack cleanly). */
function buildValid(): Uint8Array {
  const zip = new RawPizZip();
  zip.file(TEMPLATE_PACK_MANIFEST_NAME, manifestJson(), { date: DATE });
  zip.file("template.typ", "#let render(meta, body, settings) = body", { date: DATE });
  return zip.generate({ type: "uint8array", compression: "DEFLATE", platform: "DOS" });
}

/** A valid manifest + entry, plus caller-supplied malicious extra entries. */
function buildWith(
  extra: (zip: RawZip) => void,
  platform: "DOS" | "UNIX" = "DOS",
): Uint8Array {
  const zip = new RawPizZip();
  zip.file(TEMPLATE_PACK_MANIFEST_NAME, manifestJson(), { date: DATE });
  zip.file("template.typ", "#let render(meta, body, settings) = body", { date: DATE });
  extra(zip);
  return zip.generate({ type: "uint8array", compression: "DEFLATE", platform });
}

export interface ArchiveCorpusCase {
  id: string;
  description: string;
  bytes: Uint8Array;
  /** The typed `TemplatePackError.kind` this archive MUST be rejected with. */
  expectRejectKind: TemplatePackErrorKind;
}

/**
 * The adversarial archive corpus. Each case is a `.wiki-pdf-template` that MUST
 * be rejected by `unpackTemplate` with the stated kind: path traversal (four
 * shapes), a symlink entry, a per-member over-cap, a cumulative declared-size
 * "zip bomb", and an entry-count flood.
 */
export const ARCHIVE_CORPUS: readonly ArchiveCorpusCase[] = [
  {
    id: "traversal-dotdot",
    description: "a `../evil.typ` parent-escape entry",
    bytes: buildWith((z) => z.file("../evil.typ", "x", { date: DATE })),
    expectRejectKind: "path-traversal",
  },
  {
    id: "traversal-absolute",
    description: "an absolute `/etc/passwd` path",
    bytes: buildWith((z) => z.file("/etc/passwd", "x", { date: DATE })),
    expectRejectKind: "path-traversal",
  },
  {
    id: "traversal-backslash",
    description: "a backslash `dir\\evil.typ` path",
    bytes: buildWith((z) => z.file("dir\\evil.typ", "x", { date: DATE })),
    expectRejectKind: "path-traversal",
  },
  {
    id: "traversal-nested",
    description: "a nested `a/../../evil.typ` escape",
    bytes: buildWith((z) => z.file("a/../../evil.typ", "x", { date: DATE })),
    expectRejectKind: "path-traversal",
  },
  {
    id: "symlink",
    description: "a symlink entry (S_IFLNK) pointing outside the pack",
    bytes: buildWith(
      (z) => z.file("link.typ", "/etc/passwd", { date: DATE, unixPermissions: 0o120777 }),
      "UNIX",
    ),
    expectRejectKind: "symlink",
  },
  {
    id: "file-too-large",
    description: "a member whose declared uncompressed size exceeds the per-file cap",
    // Zeros compress tiny, so the archive stays small while the declared size is huge.
    bytes: buildWith((z) => z.file("huge.bin", new Uint8Array(MAX_TEMPLATE_PACK_FILE_BYTES + 1024), { date: DATE })),
    expectRejectKind: "file-too-large",
  },
  {
    id: "zip-bomb-cumulative",
    description: "three 30 MiB zero members: cumulative declared 90 MiB > 64 MiB cap (pre-inflation abort)",
    bytes: buildWith((z) => {
      const chunk = () => new Uint8Array(30 * 1024 * 1024);
      z.file("a.bin", chunk(), { date: DATE });
      z.file("b.bin", chunk(), { date: DATE });
      z.file("c.bin", chunk(), { date: DATE });
    }),
    expectRejectKind: "uncompressed-too-large",
  },
  {
    id: "entry-count-flood",
    description: `more than ${MAX_TEMPLATE_PACK_ENTRIES} entries`,
    bytes: buildWith((z) => {
      for (let i = 0; i <= MAX_TEMPLATE_PACK_ENTRIES; i++) z.file(`pad/${i}.txt`, "x", { date: DATE });
    }),
    expectRejectKind: "too-many-entries",
  },
];

/** A minimal VALID `.wiki-pdf-template` — the positive control for the gate. */
export const VALID_ARCHIVE_BYTES: Uint8Array = buildValid();
