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
 * Deterministic: same bytes on every call, in every process. The bundled
 * default is a fixed asset, so its zip entry timestamps are pinned to a fixed
 * epoch (a reproducible build) rather than the wall clock — otherwise two
 * independent builds could differ by a few bytes across a 2-second boundary.
 *
 * Exported because a host that falls back to {@link bundledDefaultTemplate}
 * still has to declare a `TemplateMeta.modificationDate` to the engine, and the
 * bundled template's only meaningful date is this pin. Copying the literal into
 * each host would be exactly the drift this constant prevents.
 */
export const BUNDLED_TEMPLATE_EPOCH = new Date("2020-01-01T00:00:00.000Z");

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
    date: BUNDLED_TEMPLATE_EPOCH,
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
