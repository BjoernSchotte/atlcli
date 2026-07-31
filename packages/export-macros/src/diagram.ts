/**
 * Diagram macro renderers (spec 004, T1.9/E3): draw.io / Gliffy preview images.
 *
 * These macros store a rendered preview attachment (`<name>.png`, sometimes
 * `<name>.svg`) on the page. The renderer maps the macro to an existing `image`
 * block pointing at that attachment — but only after confirming the attachment
 * exists, because once the resolver accepts a `{ kind: "blocks" }` result the
 * replacement is final: a later image-fetch failure inside the engines degrades
 * to a blank-image note, it does not re-enter the fallback chain.
 */
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  AttachmentMeta,
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";

const DIAGRAM_MACROS = ["drawio", "inc-drawio", "drawio-sketch", "gliffy"];

function diagramName(m: MacroInstance): string | undefined {
  return macroParamText(m.params, "diagramName") ?? macroParamText(m.params, "name");
}

function imageBlock(pageId: string, filename: string, alt: string): ExportBlock {
  return {
    type: "image",
    source: { kind: "attachment", filename, pageId },
    alt,
  };
}

/**
 * Compare the preview attachment's modification time to the page version's own
 * timestamp; a preview older than the page may be stale (previews regenerate
 * only on save).
 */
function stalenessNote(
  meta: AttachmentMeta,
  pageModified: string | undefined,
  macroName: string
): ExportNote | undefined {
  if (!meta.modified || !pageModified) return undefined;
  const previewAt = Date.parse(meta.modified);
  const pageAt = Date.parse(pageModified);
  if (Number.isFinite(previewAt) && Number.isFinite(pageAt) && previewAt < pageAt) {
    return {
      level: "info",
      code: "macro-rendered-via",
      message: `Diagram preview "${meta.filename}" may be outdated (older than the page's last edit).`,
      macroName,
    };
  }
  return undefined;
}

export function diagramMacroRenderer(): MacroRenderer {
  return {
    id: "diagram",
    macros: DIAGRAM_MACROS,
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      const name = diagramName(m);
      if (!name) return { kind: "skip" };
      // Without attachment lookup we cannot confirm the preview exists; skip
      // rather than emit a PNG block that might strand the export in the engine's
      // "already committed to this block" failure mode.
      if (!ctx.attachments) return { kind: "skip" };

      const pageId = ctx.page.id;
      try {
        const svgName = `${name}.svg`;
        const pngName = `${name}.png`;

        // Web and PDF both retain the source-author's static SVG preview.
        // DOCX has no arbitrary-SVG-attachment seam yet (TODO(T1.15), blocked
        // on 006-word-quality G4), so only DOCX stays on PNG when both exist.
        if (ctx.flags?.targetEngine === "pdf" || ctx.flags?.targetEngine === "web") {
          const svgMeta = await ctx.attachments.lookup(pageId, svgName);
          if (svgMeta) {
            const notes: ExportNote[] = [
              {
                level: "info",
                code: "macro-rendered-via",
                message: `Diagram "${name}" rendered from preview attachment "${svgName}".`,
                macroName: m.name,
              },
            ];
            const stale = stalenessNote(svgMeta, pageModifiedFrom(ctx), m.name);
            if (stale) notes.push(stale);
            return { kind: "blocks", blocks: [imageBlock(pageId, svgName, name)], notes };
          }
        }

        const pngMeta = await ctx.attachments.lookup(pageId, pngName);
        if (pngMeta) {
          const notes: ExportNote[] = [
            {
              level: "info",
              code: "macro-rendered-via",
              message: `Diagram "${name}" rendered from preview attachment "${pngName}".`,
              macroName: m.name,
            },
          ];
          const stale = stalenessNote(pngMeta, pageModifiedFrom(ctx), m.name);
          if (stale) notes.push(stale);
          return { kind: "blocks", blocks: [imageBlock(pageId, pngName, name)], notes };
        }

        // No preview attachment → fall through to export_view / placeholder.
        return { kind: "skip" };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (isPortError(err)) {
          return {
            kind: "skip",
            notes: [
              {
                level: "warning",
                code: "macro-degraded",
                message: `Diagram "${name}" preview lookup failed: ${err.message}`,
                macroName: m.name,
              },
            ],
          };
        }
        return { kind: "skip" };
      }
    },
  };
}

/** The page's own last-modified timestamp, when the host supplied it. */
function pageModifiedFrom(ctx: MacroExportContext): string | undefined {
  // `page.version` is a number; the host wiring exposes the page timestamp via
  // the attachment metadata comparison. Absent here → no staleness note.
  return (ctx.page as { modified?: string }).modified;
}
