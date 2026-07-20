/**
 * Batteries-included DOCX env for Node hosts (spec 009 / BASELINE-DESIGN §A5).
 *
 * Composes `@atlcli/docx`'s Node adapters with a zero-setup default template
 * so a host goes from page details to a `.docx` file with no template asset
 * of its own.
 */
import {
  fileOutputSink,
  fileTemplateSource,
  type ExportEnv,
  type TemplateSource,
} from "@atlcli/docx";
import { buildDocx, headingStyle, para, stylesXml } from "@atlcli/docx/fixtures";

/**
 * A minimal, working DOCX template built programmatically (PizZip OOXML parts
 * — no binary asset shipped, no font/branding licensing questions): a title
 * heading, an export-date line, and the `$scroll.content` body anchor, plus
 * the Scroll heading styles the serializer maps `ExportBlock` headings onto.
 * Deterministic: same bytes on every call.
 */
export function bundledDefaultTemplate(): Uint8Array {
  const headingStyles = [1, 2, 3, 4, 5, 6]
    .map((level) => headingStyle(`SH${level}`, `Scroll Heading ${level}`))
    .join("");
  return buildDocx({
    body:
      para("$scroll.title") +
      para("Exported $scroll.exportdate") +
      para("$scroll.content"),
    styles: stylesXml(headingStyles),
  });
}

/** A {@link TemplateSource} serving {@link bundledDefaultTemplate}. */
export function defaultTemplateSource(): TemplateSource {
  return {
    async getBytes(): Promise<Uint8Array> {
      return bundledDefaultTemplate();
    },
  };
}

/**
 * Template resolution with a built-in default: a path resolves through
 * `fileTemplateSource`, no path resolves to {@link bundledDefaultTemplate}.
 */
export function nodeTemplateSource(templatePath?: string): TemplateSource {
  return templatePath ? fileTemplateSource(templatePath) : defaultTemplateSource();
}

export interface NodeDocxEnvOptions {
  /** Path to a `.docx` template; omitted → the bundled default template. */
  templatePath?: string;
  /** Where the finished document is written (atomic replace). */
  outPath: string;
  /** Optional extra seams (asset fetcher, rasterizer) merged verbatim. */
  extras?: Partial<Pick<ExportEnv, "assets" | "rasterizer">>;
}

/**
 * A complete {@link ExportEnv} for a Node host: template from disk or the
 * bundled default, output as an atomic file write. Pass the result straight
 * to `runExport` from `@atlcli/docx`.
 */
export function nodeDocxEnv(options: NodeDocxEnvOptions): ExportEnv {
  return {
    templates: nodeTemplateSource(options.templatePath),
    output: fileOutputSink(options.outPath),
    ...(options.extras ?? {}),
  };
}
