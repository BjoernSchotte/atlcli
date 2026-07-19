/**
 * Deterministic `.wiki-pdf-template` packer (spec 007 T2.4).
 *
 * `packTemplate` serializes a manifest + payload files into a byte-deterministic
 * zip: packing the same input twice yields byte-identical archives. Determinism
 * comes from three controls on PizZip:
 *   - a fixed DOS-epoch timestamp (1980-01-01 00:00:00) on every entry, built
 *     from local calendar components so it is timezone-independent;
 *   - `platform: "DOS"` so `version made by` / external attributes are fixed;
 *   - an explicit `fileOrder` (manifest first, then payload paths ascending) and
 *     a stable, sorted-key manifest serialization.
 * ASCII entry paths carry no Info-ZIP unicode-path extra field, so no
 * platform-dependent extra fields are emitted.
 *
 * `provenance.payloadSha256` is **not self-referential**: it digests a
 * canonicalized description of the *payload members* (everything except the
 * manifest), so it can be computed in one pass and written into the manifest
 * before the manifest entry is serialized. See {@link computePayloadSha256}.
 *
 * Browser-safe: PizZip runs in the browser (as in `@atlcli/docx`); `sha256Hex`
 * is WebCrypto. No `node:`/`bun:` imports.
 */
import { sha256Hex } from "@atlcli/core";
import PizZipDefault from "pizzip";
import {
  TEMPLATE_PACK_MANIFEST_NAME,
  type TemplateManifest,
} from "./manifest.js";

/**
 * PizZip's shipped ambient typing (declared in `@atlcli/docx`) omits the
 * determinism options we rely on. Rather than re-declare the module (which
 * would collide in the shared program), we cast the imported constructor to the
 * exact surface `packTemplate` needs.
 */
interface DeterministicZip {
  file(path: string, content: Uint8Array, options: { date: Date }): unknown;
  generate(options: {
    type: "uint8array";
    compression: "DEFLATE";
    platform: "DOS";
    fileOrder: string[];
  }): Uint8Array;
}
const DeterministicPizZip = PizZipDefault as unknown as { new (): DeterministicZip };

/** The DOS epoch (1980-01-01 00:00:00), built from local components so its
 *  DOS date/time encoding is identical on every machine and timezone. */
const DOS_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

/** Default `createdWith` when the caller does not supply provenance. */
const DEFAULT_CREATED_WITH = "@atlcli/template-pack";

/** Contents to pack: the manifest plus payload members keyed by archive path. */
export interface TemplatePackContents {
  /**
   * The manifest to embed. `provenance.payloadSha256` is (re)computed and
   * overwritten by {@link packTemplate}; `provenance.createdWith` is preserved
   * if present, else defaulted.
   */
  manifest: TemplateManifest;
  /** Payload members by archive path. MUST NOT include the manifest file. */
  files: Record<string, Uint8Array>;
}

/**
 * Recursively stable JSON: object keys sorted, 2-space indented. Guarantees the
 * manifest serializes to identical bytes for logically-equal manifests
 * regardless of key insertion order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compute `provenance.payloadSha256` from the payload members.
 *
 * Canonicalization (documented, stable): for every payload member in ascending
 * path order, emit three lines — its `path`, its byte length (decimal), and its
 * lowercase-hex SHA-256 — then newline-join all lines and SHA-256 the UTF-8
 * bytes of that string. The manifest itself is deliberately excluded (it is the
 * carrier of this value), so the result is well-defined before the manifest is
 * written.
 */
export async function computePayloadSha256(files: Record<string, Uint8Array>): Promise<string> {
  const paths = Object.keys(files).sort();
  const lines: string[] = [];
  for (const path of paths) {
    const bytes = files[path];
    lines.push(path, String(bytes.byteLength), await sha256Hex(bytes));
  }
  return sha256Hex(new TextEncoder().encode(lines.join("\n")));
}

/**
 * Pack a manifest + payload files into a deterministic `.wiki-pdf-template`
 * archive.
 *
 * @throws {Error} if `files` includes the reserved manifest path.
 */
export async function packTemplate(contents: TemplatePackContents): Promise<Uint8Array> {
  const { manifest, files } = contents;
  if (Object.prototype.hasOwnProperty.call(files, TEMPLATE_PACK_MANIFEST_NAME)) {
    throw new Error(
      `files must not contain the reserved manifest path "${TEMPLATE_PACK_MANIFEST_NAME}"`
    );
  }

  const payloadSha256 = await computePayloadSha256(files);
  const finalManifest: TemplateManifest = {
    ...manifest,
    provenance: {
      payloadSha256,
      createdWith: manifest.provenance?.createdWith ?? DEFAULT_CREATED_WITH,
    },
  };
  const manifestBytes = new TextEncoder().encode(stableStringify(finalManifest));

  const payloadPaths = Object.keys(files).sort();
  const fileOrder = [TEMPLATE_PACK_MANIFEST_NAME, ...payloadPaths];

  const zip = new DeterministicPizZip();
  zip.file(TEMPLATE_PACK_MANIFEST_NAME, manifestBytes, { date: DOS_EPOCH });
  for (const path of payloadPaths) {
    zip.file(path, files[path], { date: DOS_EPOCH });
  }
  return zip.generate({
    type: "uint8array",
    compression: "DEFLATE",
    platform: "DOS",
    fileOrder,
  });
}
