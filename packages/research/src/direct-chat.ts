import {
  type ChatThinkingModeV1,
  type ResearchProduct,
  type ResearchRequestV1,
  type ResearchScopeEntityKindV1,
  type ResearchScopeSeedV1,
} from "./contracts.js";

const DIRECT_EXACT_CONTEXT_CHARS_V1 = 50_000;

/** Shared resource corridor for one conversational turn in every host shape. */
export function applyChatQualityResourcePolicyV1(
  input: ResearchRequestV1,
  mode: ChatThinkingModeV1,
): ResearchRequestV1 {
  const deep = mode === "deep";
  const quick = mode === "quick";
  return {
    ...input,
    limits: {
      ...input.limits,
      maxSearchPagesPerProduct: Math.min(input.limits.maxSearchPagesPerProduct, 2),
      maxItemsPerProduct: Math.min(input.limits.maxItemsPerProduct, 20),
      maxDetailItemsPerProduct: Math.min(
        input.limits.maxDetailItemsPerProduct,
        deep ? 8 : 6,
      ),
      maxBodyCharsPerItem: Math.min(
        input.limits.maxBodyCharsPerItem,
        deep ? 6_000 : 8_000,
      ),
      maxPtcCalls: deep ? 72 : mode === "auto" ? 64 : 32,
      maxHttpCalls: deep ? 40 : Math.min(input.limits.maxHttpCalls, 20),
      maxTotalResponseBytes: deep ? 24_000_000 : mode === "auto" ? 12_000_000 : 8_000_000,
      maxInterpreterMs: deep ? 180_000 : input.limits.maxInterpreterMs,
      maxModelOutputTokens: Math.min(input.limits.maxModelOutputTokens, quick ? 4_096 : 8_000),
      maxTotalModelInputTokens: deep ? 450_000 : input.limits.maxTotalModelInputTokens,
    },
  };
}

function isWholeScopeSeed(
  seed: ResearchScopeSeedV1,
  product: ResearchProduct,
): boolean {
  return seed.binding.product === product && (
    (product === "jira" && seed.binding.entityKind === "project") ||
    (product === "confluence" && seed.binding.entityKind === "space")
  );
}

function exactCurrentContextProducts(
  seeds: readonly ResearchScopeSeedV1[],
): Set<ResearchProduct> {
  return new Set(seeds.flatMap((seed) =>
    (seed.binding.source === "current_context" ||
      seed.binding.source === "exact_link") &&
    (seed.binding.entityKind === "issue" || seed.binding.entityKind === "page")
      ? [seed.binding.product]
      : [],
  ));
}

function asksForWholeScope(question: string, product: ResearchProduct): boolean {
  if (product === "jira") {
    return /\b(?:jira(?:[- ]?(?:projekt|project))?|projekt(?:key)?|project(?: key)?|tickets?|issues?|vorg[aä]nge?|arbeitselemente?)\b/iu.test(question);
  }
  return /\b(?:confluence[- ]?(?:space|bereich)|wiki[- ]?(?:space|bereich)|spaces?|bereiche?|im (?:aktuellen|diesem) (?:space|bereich)|in (?:the )?(?:current|this) space)\b/iu.test(question);
}

/**
 * Project a conversational request onto the smallest host-authorized scope.
 *
 * A bound current page/issue is the primary chat context, not one candidate
 * among an implicit whole-space/project search. Explicit UI/CLI scopes remain
 * available, and a question can still ask for the surrounding whole scope.
 * The containing scope remains authorized for source validation, while the
 * broker skips broad discovery for products marked as exact context.
 */
export function prepareDirectChatRequestV1(
  input: ResearchRequestV1,
): ResearchRequestV1 {
  const seeds = input.scopeSeeds ?? [];
  const exactProducts = exactCurrentContextProducts(seeds);
  if (exactProducts.size === 0) return input;

  const exactContextProducts = [...exactProducts].filter((product) => {
    if (asksForWholeScope(input.question, product)) return false;
    return !seeds.some((seed) =>
      seed.binding.source !== "current_context" && isWholeScopeSeed(seed, product),
    );
  }).sort();
  const { exactContextProducts: _previousExactContextProducts, ...base } = input;
  const projected = {
    ...base,
    ...(exactContextProducts.length > 0 ? { exactContextProducts } : {}),
    limits: {
      ...input.limits,
      // A single exact page is cheaper and more accurate when an ordinary
      // page-sized body is read once. Only genuinely long pages should fall
      // back to the navigable outline plus targeted section reads.
      maxBodyCharsPerItem: DIRECT_EXACT_CONTEXT_CHARS_V1,
    },
  } satisfies ResearchRequestV1;
  return projected;
}

export function directChatProductsV1(
  request: ResearchRequestV1,
): ResearchProduct[] {
  const products = new Set<ResearchProduct>();
  if (request.scope.jiraProjectKeys.length > 0) products.add("jira");
  if (request.scope.confluenceSpaceKeys.length > 0) products.add("confluence");
  for (const seed of request.scopeSeeds ?? []) {
    const entityKind: ResearchScopeEntityKindV1 = seed.binding.entityKind;
    if (entityKind === "issue" || entityKind === "page") {
      products.add(seed.binding.product);
    }
  }
  return [...products].sort();
}

export function directChatHasExactCurrentPageV1(
  request: ResearchRequestV1,
): boolean {
  return (request.scopeSeeds ?? []).some((seed) =>
    (seed.binding.source === "current_context" ||
      seed.binding.source === "exact_link") &&
    seed.binding.product === "confluence" &&
    seed.binding.entityKind === "page",
  );
}
