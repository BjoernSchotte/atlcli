/**
 * CLI-side export orchestration helpers.
 *
 * The token asset fetcher + verified disk byte cache moved to
 * `@atlcli/export-node` (spec 009, batteries-included Node consumer) — the
 * CLI re-exports them here so existing imports and their regression tests
 * keep working against the single shared implementation.
 */
import type { ExportMentionLookup, ExportNote } from "@atlcli/confluence";
import type { TemplateMeta } from "@atlcli/docx";
import { BUNDLED_TEMPLATE_EPOCH, bundledDefaultTemplate } from "@atlcli/export-node";

export {
  createAssetByteCache,
  tokenAssetFetcher,
  type AssetByteCache,
  type AssetClient,
} from "@atlcli/export-node";

/**
 * The name reported for the bundled default template. Not a path — nothing on
 * disk corresponds to it — but a `TemplateMeta.name` is what `$scroll.templatename`
 * resolves to, so it has to read like a template identity rather than a blank.
 */
export const BUNDLED_TEMPLATE_NAME = "bundled-default.docx";

/** A template's bytes plus the metadata the engine and the report need. */
export interface LoadedExportTemplate {
  bytes: Uint8Array;
  meta: TemplateMeta;
  /** `info` note when the bundled default stood in; empty when a path was given. */
  notes: ExportNote[];
}

/**
 * Resolve the ts engine's template: the file at `resolvedTemplatePath`, or —
 * when no `--template` was given — the bundled default from
 * `@atlcli/export-node` (spec 010 W3-D).
 *
 * `--template` used to be mandatory for every DOCX export, which is precisely
 * what pushed a first-time `--engine ts` user toward whatever `.docx` happened
 * to be at hand; one such grab (a docxtpl fixture) produced a 62-page document
 * full of unfilled `{{ … }}`. The bundled default emits correct `$scroll.title`
 * / `$scroll.exportdate` / `$scroll.content` placeholders, so the zero-template
 * path is guaranteed to leave nothing unfilled.
 *
 * The fallback ALWAYS emits its note: an output whose template the user never
 * named must not be a mystery. `info`, not `warning` — nothing is wrong with
 * this export, and it must not fail `--strict`.
 */
export async function loadExportTemplate(
  resolvedTemplatePath: string | undefined
): Promise<LoadedExportTemplate> {
  if (!resolvedTemplatePath) {
    return {
      bytes: bundledDefaultTemplate(),
      meta: { name: BUNDLED_TEMPLATE_NAME, modificationDate: BUNDLED_TEMPLATE_EPOCH },
      notes: [
        {
          level: "info",
          code: "template-default-used",
          message:
            "No --template was given; exported with the bundled default template " +
            "(page title, export date, page body). Pass --template to use your own.",
        },
      ],
    };
  }
  const { basename } = await import("node:path");
  const { readFile, stat } = await import("node:fs/promises");
  const [bytes, info] = await Promise.all([
    readFile(resolvedTemplatePath),
    stat(resolvedTemplatePath),
  ]);
  return {
    bytes: new Uint8Array(bytes),
    meta: { name: basename(resolvedTemplatePath), modificationDate: info.mtime },
    notes: [],
  };
}

interface MentionClient {
  getUsersBulk(accountIds: string[]): Promise<Map<string, { displayName: string | null } | null>>;
}

/**
 * Token-auth {@link ExportMentionLookup} backed by the client's bulk user fetch
 * (spec 008 T3.2). Shared by the PDF and both ts DOCX paths so `@mention`s
 * resolve to display names identically to the extension pipeline. Dedup across a
 * tree/space document happens upstream in `resolveExportMentions` (one bulk call
 * per unique id set).
 */
export function tokenMentionLookup(client: MentionClient): ExportMentionLookup {
  return async (accountIds) => {
    const users = await client.getUsersBulk(accountIds);
    const out = new Map<string, string | null>();
    for (const id of accountIds) out.set(id, users.get(id)?.displayName ?? null);
    return out;
  };
}

/** Cheap, conservative gate before loading the resvg wasm and bundled fonts. */
export function mightContainMermaid(storage: string): boolean {
  return /<ac:parameter\b[^>]*\bac:name\s*=\s*["']language["'][^>]*>\s*mermaid\s*<\/ac:parameter\s*>/i.test(
    storage
  );
}

/**
 * Cheap, conservative gate for whether a page might need a rasterizer for an
 * IMAGE (spec 006 G4): any `<ac:image>` / attachment reference. Deliberately
 * over-triggering — it matches any image, not just SVG attachments, because
 * parsing storage deeply enough to know an attachment's extension before
 * fetching it is not worth the complexity. A false positive costs an unused
 * rasterizer build; a false negative would silently degrade an SVG-only page's
 * SVG in the CLI even though the engine supports it, which is the failure mode
 * worth avoiding. The DOCX SVG-attachment path degrades with
 * `image-svg-no-rasterizer` when no rasterizer is available, so the CLI must
 * build one whenever this OR {@link mightContainMermaid} matches.
 */
export function mightReferenceImage(storage: string): boolean {
  return /<ac:image\b/i.test(storage) || /<ri:attachment\b/i.test(storage);
}

/** Start only the page-key-dependent requests named by the local template scan. */
export function prestartPageDependentDeps(input: {
  pagePromise: Promise<{ spaceKey?: string }>;
  templateDeps: ReadonlySet<string>;
  embedImages: boolean;
  getSpaceWithIcon: (spaceKey: string) => Promise<unknown>;
  getSpaceHomepageStorage: (spaceKey: string) => Promise<unknown>;
}): void {
  const prefetch = input.pagePromise.then((details) => {
    const key = details.spaceKey;
    if (!key) return;
    if (
      input.templateDeps.has("space") ||
      (input.embedImages && input.templateDeps.has("spaceLogo"))
    ) {
      input.getSpaceWithIcon(key).catch(() => {});
    }
    if (input.templateDeps.has("spaceHomepage")) {
      input.getSpaceHomepageStorage(key).catch(() => {});
    }
  });
  // The engine still awaits the original page promise and reports that error.
  // This derived optimization branch must never become an unhandled rejection.
  prefetch.catch(() => {});
}
