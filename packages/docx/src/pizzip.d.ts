/**
 * Ambient declaration for `pizzip` (spec 004 DOCX export).
 *
 * PizZip ships no bundled `.d.ts`. docxtemplater depends on it and the DOCX
 * export path uses it directly for zip surgery (media parts, `$scroll.*`
 * preprocessing). Only the surface the export code touches is declared here.
 */
declare module "pizzip" {
  interface PizZipObject {
    /** Decode this entry as UTF-8 text. */
    asText(): string;
    /** Decode this entry as raw bytes. */
    asUint8Array(): Uint8Array;
    /** Decode this entry as an ArrayBuffer. */
    asArrayBuffer(): ArrayBuffer;
    name: string;
    dir: boolean;
    /** ZIP header timestamp; writable like JSZip's/PizZip's runtime object. */
    date: Date;
    /** Optional per-entry comment and DOS attributes preserved by streaming output. */
    comment?: string;
    dosPermissions?: number;
    options: {
      /** Per-entry choice overrides the global generate() compression. */
      compression?: "STORE" | "DEFLATE";
    };
  }

  interface PizZipFileOptions {
    binary?: boolean;
    compression?: "STORE" | "DEFLATE";
    compressionOptions?: { level?: number };
    date?: Date;
  }

  interface PizZipGenerateOptions {
    type?: "uint8array" | "arraybuffer" | "nodebuffer" | "base64" | "string" | "blob";
    compression?: "STORE" | "DEFLATE";
    compressionOptions?: { level?: number };
  }

  class PizZip {
    constructor(data?: string | ArrayBuffer | Uint8Array | number[]);
    /** Map of path → entry for every file in the archive. */
    files: Record<string, PizZipObject>;
    /** Read an entry (returns `null` when absent). */
    file(path: string): PizZipObject | null;
    /** Write/overwrite an entry. */
    file(
      path: string,
      content: string | ArrayBuffer | Uint8Array,
      options?: PizZipFileOptions,
    ): this;
    /** Serialize the archive. */
    generate(options?: PizZipGenerateOptions): Uint8Array & string & ArrayBuffer;
  }

  namespace PizZip {
    type ZipObject = PizZipObject;
  }

  export = PizZip;
}
