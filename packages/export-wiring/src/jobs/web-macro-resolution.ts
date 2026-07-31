import type { ExportBlock, ExportNote, ExportPageNode } from "@atlcli/confluence";
import { resolveMacroBlocks, type MacroResolutionOptions } from "@atlcli/export-macros";

/** The web publication policy visible at the macro-resolution boundary. */
export interface WebMacroResolutionPolicyV1 {
  mode: "static-only" | "allow-frozen-live";
  /** A prior live result is reusable only inside this explicit freshness window. */
  liveFreshnessSeconds?: number;
}

/**
 * One page's resolved, renderer-neutral macro projection. `blocks` never
 * carries source HTML: `resolveMacroBlocks()` only returns trusted ExportBlock
 * values produced by the decoder or registered macro renderers.
 */
export interface ResolvedWebMacroPageV1 {
  sourceId: string;
  sourceVersion?: number;
  blocks: readonly ExportBlock[];
  notes: readonly ExportNote[];
  resolvedAtEpochMs: number;
  usedLive: boolean;
}

export interface ResolveWebPageMacrosOptionsV1 {
  macros: MacroResolutionOptions;
  policy: WebMacroResolutionPolicyV1;
  /** A trusted, already-frozen result from the active publication bundle. */
  previousBySourceId?: ReadonlyMap<string, ResolvedWebMacroPageV1>;
  /** Injected for deterministic tests and reproducible refresh planning. */
  now?: () => number;
}

function assertPolicy(policy: WebMacroResolutionPolicyV1): void {
  if (policy.mode === "static-only" && policy.liveFreshnessSeconds !== undefined) {
    throw new TypeError("static-only web macro policy cannot declare live freshness");
  }
  if (
    policy.liveFreshnessSeconds !== undefined &&
    (!Number.isSafeInteger(policy.liveFreshnessSeconds) || policy.liveFreshnessSeconds < 0)
  ) {
    throw new TypeError("web macro live freshness must be a non-negative safe integer");
  }
}

function isFresh(
  previous: ResolvedWebMacroPageV1 | undefined,
  page: ExportPageNode,
  policy: WebMacroResolutionPolicyV1,
  now: number,
): previous is ResolvedWebMacroPageV1 {
  if (
    previous === undefined ||
    !previous.usedLive ||
    policy.mode !== "allow-frozen-live" ||
    policy.liveFreshnessSeconds === undefined ||
    previous.sourceVersion !== page.meta.version
  ) {
    return false;
  }
  return now >= previous.resolvedAtEpochMs &&
    now - previous.resolvedAtEpochMs <= policy.liveFreshnessSeconds * 1_000;
}

/**
 * Resolve every page independently. This deliberately gives the TOC renderer
 * only the current page's block tree, and builds a new context from every
 * macro's own source page. A child page therefore cannot consume root-page
 * context or another page's local headings.
 */
export async function resolveWebPageMacrosV1(
  pages: readonly ExportPageNode[],
  options: ResolveWebPageMacrosOptionsV1,
): Promise<readonly ResolvedWebMacroPageV1[]> {
  assertPolicy(options.policy);
  const now = options.now ?? Date.now;
  const seen = new Set<string>();
  const result: ResolvedWebMacroPageV1[] = [];

  for (const page of pages) {
    if (seen.has(page.pageId)) {
      throw new TypeError(`Web macro resolution received duplicate page '${page.pageId}'`);
    }
    seen.add(page.pageId);

    const resolvedAtEpochMs = now();
    const previous = options.previousBySourceId?.get(page.pageId);
    if (isFresh(previous, page, options.policy, resolvedAtEpochMs)) {
      result.push(previous);
      continue;
    }

    const sourcePage = {
      id: page.pageId,
      ...(page.meta.version === undefined ? {} : { version: page.meta.version }),
      ...(page.meta.spaceKey === undefined ? {} : { spaceKey: page.meta.spaceKey }),
    };
    const resolved = await resolveMacroBlocks(
      { blocks: page.blocks, notes: page.notes },
      options.macros.registry,
      options.macros.contextFor(sourcePage),
      {
        live: options.policy.mode === "allow-frozen-live" && options.macros.live !== false,
        contextFor: (macroSourcePage) => options.macros.contextFor(macroSourcePage ?? sourcePage),
        targetEngine: "web",
      },
    );
    result.push({
      sourceId: page.pageId,
      ...(page.meta.version === undefined ? {} : { sourceVersion: page.meta.version }),
      blocks: resolved.blocks,
      notes: resolved.notes,
      resolvedAtEpochMs,
      usedLive: options.policy.mode === "allow-frozen-live" && options.macros.live !== false,
    });
  }
  return result;
}
