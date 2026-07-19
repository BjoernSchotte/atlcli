/**
 * include / excerpt-include / excerpt renderers (spec 004, E5).
 *
 * `include` pulls in a whole page; `excerpt-include` pulls in a named excerpt;
 * `excerpt` is the definition-side macro (pure passthrough). All three share the
 * `ctx.visited`/`ctx.depth` recursion guard with the E4 multiexcerpt renderer so
 * a cross-renderer cycle (`include` → `multiexcerpt-include` → back) is caught.
 */
import type { ExportBlock, ExportNote, MacroParamRef } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  ConfluenceContentPort,
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";
import { extractMacroBody } from "./extract.js";
import type { StorageToBlocksDep } from "./deps.js";

const EXCERPT_DEFINITION_MACROS = ["excerpt"];
const MAX_DEPTH = 5;

/** The `ri:page` reference from an `include`/`excerpt-include` unnamed param. */
function pageRefOf(m: MacroInstance): Extract<MacroParamRef, { kind: "page" }> | undefined {
  const unnamed = m.params.find((p) => p.name === "");
  const ref = unnamed?.refs?.find((r) => r.kind === "page");
  return ref?.kind === "page" ? ref : undefined;
}

async function fetchByRef(
  confluence: ConfluenceContentPort,
  ref: Extract<MacroParamRef, { kind: "page" }>,
  fallbackSpace: string | undefined
): Promise<{ id: string; version: number; storage: string } | undefined> {
  // Prefer exact id lookup, else title (+ space) lookup.
  if (ref.contentId && confluence.getPageStorageById) {
    return confluence.getPageStorageById(ref.contentId);
  }
  if (ref.contentTitle) {
    return confluence.getPageStorage(ref.contentTitle, ref.spaceKey ?? fallbackSpace);
  }
  return undefined;
}

function refKey(ref: Extract<MacroParamRef, { kind: "page" }>, excerptName: string): string {
  const id = ref.contentId ?? `${ref.spaceKey ?? ""}:${ref.contentTitle ?? ""}`;
  return `${id}#${excerptName}`;
}

function guarded(ctx: MacroExportContext, key: string, macroName: string): ExportNote | undefined {
  if (ctx.visited.has(key) || ctx.depth > MAX_DEPTH) {
    return {
      level: "info",
      code: "macro-degraded",
      message: `Include cycle or depth limit reached for "${key}"; not expanded.`,
      macroName,
    };
  }
  return undefined;
}

function noRefNote(macroName: string): MacroRenderResult {
  return {
    kind: "skip",
    notes: [
      {
        level: "info",
        code: "macro-degraded",
        message: `${macroName} macro has no resolvable page reference; a placeholder was emitted.`,
        macroName,
      },
    ],
  };
}

function portFail(err: { message: string }, macroName: string): MacroRenderResult {
  return {
    kind: "skip",
    notes: [
      {
        level: "warning",
        code: "macro-degraded",
        message: `${macroName} skipped: ${err.message}`,
        macroName,
      },
    ],
  };
}

export function includeRenderer(deps: { storageToBlocks: StorageToBlocksDep }): MacroRenderer {
  return {
    id: "include",
    macros: ["include"],
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      if (!ctx.confluence) return { kind: "skip" };
      const ref = pageRefOf(m);
      if (!ref) return noRefNote(m.name);
      const key = refKey(ref, "");
      const guard = guarded(ctx, key, m.name);
      if (guard) return { kind: "skip", notes: [guard] };
      ctx.visited.add(key);
      try {
        const page = await fetchByRef(ctx.confluence, ref, ctx.page.spaceKey);
        if (!page) return { kind: "skip", notes: [notFound(m.name)] };
        const walked = deps.storageToBlocks(page.storage, {
          pageContext: { id: page.id, version: page.version, spaceKey: ctx.page.spaceKey },
        });
        return {
          kind: "blocks",
          blocks: walked.blocks,
          notes: [rendered(m.name, "included page content")],
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (isPortError(err)) return portFail(err, m.name);
        return { kind: "skip" };
      }
    },
  };
}

export function excerptIncludeRenderer(deps: {
  storageToBlocks: StorageToBlocksDep;
}): MacroRenderer {
  return {
    id: "excerpt-include",
    macros: ["excerpt-include"],
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      if (!ctx.confluence) return { kind: "skip" };
      const ref = pageRefOf(m);
      // excerpt-include may also carry a name param selecting a named excerpt.
      const excerptName = macroParamText(m.params, "name") ?? "";
      if (!ref) return noRefNote(m.name);
      const key = refKey(ref, excerptName);
      const guard = guarded(ctx, key, m.name);
      if (guard) return { kind: "skip", notes: [guard] };
      ctx.visited.add(key);
      try {
        const page = await fetchByRef(ctx.confluence, ref, ctx.page.spaceKey);
        if (!page) return { kind: "skip", notes: [notFound(m.name)] };
        const walked = deps.storageToBlocks(page.storage, {
          pageContext: { id: page.id, version: page.version, spaceKey: ctx.page.spaceKey },
        });
        const body = extractMacroBody(walked.blocks, EXCERPT_DEFINITION_MACROS, excerptName);
        if (!body || body.length === 0) {
          return {
            kind: "skip",
            notes: [
              {
                level: "warning",
                code: "macro-degraded",
                message: `excerpt-include: no matching excerpt found on the target page.`,
                macroName: m.name,
              },
            ],
          };
        }
        return { kind: "blocks", blocks: body, notes: [rendered(m.name, "included excerpt")] };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (isPortError(err)) return portFail(err, m.name);
        return { kind: "skip" };
      }
    },
  };
}

export function excerptRenderer(): MacroRenderer {
  return {
    id: "excerpt",
    macros: ["excerpt"],
    requiresLivePort: false,
    async render(m: MacroInstance): Promise<MacroRenderResult> {
      // Definition-side macro on the page itself; no fetch needed.
      if ((macroParamText(m.params, "hidden") ?? "").toLowerCase() === "true") {
        // Suppressed — matches Confluence's own display behavior.
        return {
          kind: "blocks",
          blocks: [],
          notes: [
            {
              level: "info",
              code: "macro-rendered-via",
              message: "excerpt macro is hidden; body suppressed.",
              macroName: m.name,
            },
          ],
          bodyConsumed: true,
        };
      }
      if (!m.body || m.body.length === 0) return { kind: "skip" };
      return {
        kind: "blocks",
        blocks: m.body,
        notes: [rendered(m.name, "excerpt body")],
        bodyConsumed: true,
      };
    },
  };
}

function rendered(macroName: string, what: string): ExportNote {
  return {
    level: "info",
    code: "macro-rendered-via",
    message: `${macroName} macro rendered (${what}).`,
    macroName,
  };
}
function notFound(macroName: string): ExportNote {
  return {
    level: "warning",
    code: "macro-degraded",
    message: `${macroName}: target page not found.`,
    macroName,
  };
}
