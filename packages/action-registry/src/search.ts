import type { ActionCatalogEntryV1, ActionCatalogV1 } from "./catalog.js";

export type ActionSearchMatchKindV1 =
  | "default"
  | "title-exact"
  | "title-prefix"
  | "title-token-prefix"
  | "alias-exact"
  | "alias-prefix"
  | "alias-token-prefix"
  | "keyword-exact"
  | "keyword-prefix"
  | "keyword-token-prefix"
  | "subtitle-exact"
  | "subtitle-prefix"
  | "subtitle-token-prefix"
  | "group-exact"
  | "group-prefix"
  | "subsequence";

export interface ActionSearchResultV1 {
  readonly entry: ActionCatalogEntryV1;
  readonly score: number;
  readonly matchKind: ActionSearchMatchKindV1;
}

export interface ActionSearchOptionsV1 {
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
  readonly locale?: string;
  readonly limit?: number;
}

interface MatchCandidate {
  score: number;
  matchKind: ActionSearchMatchKindV1;
}

const COMBINING_MARK_RE = /\p{M}+/gu;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const MAX_QUERY_LENGTH = 512;

function safeLocaleLowerCase(value: string, locale: string): string {
  try {
    return value.toLocaleLowerCase(locale);
  } catch {
    return value.toLocaleLowerCase("en-US");
  }
}

/** Unicode-compatible, locale-aware, diacritic-insensitive search form. */
export function normalizeActionSearchTextV1(
  value: string,
  locale = "en-US",
): string {
  const lowered = safeLocaleLowerCase(value, locale);
  return lowered
    .normalize("NFKD")
    .replace(COMBINING_MARK_RE, "")
    .replace(NON_WORD_RE, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function tokens(value: string): readonly string[] {
  return value === "" ? [] : value.split(" ");
}

function tokenPrefixMatches(query: string, candidate: string): boolean {
  const queryTokens = tokens(query);
  const candidateTokens = tokens(candidate);
  return (
    queryTokens.length > 0 &&
    queryTokens.every((queryToken) =>
      candidateTokens.some((candidateToken) => candidateToken.startsWith(queryToken)),
    )
  );
}

function subsequenceQuality(query: string, candidate: string): number | undefined {
  const needle = query.replace(/\s/gu, "");
  const haystack = candidate.replace(/\s/gu, "");
  if (needle === "" || haystack === "") return undefined;
  let needleIndex = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[needleIndex]) continue;
    if (firstIndex < 0) firstIndex = index;
    lastIndex = index;
    needleIndex += 1;
  }
  if (needleIndex !== needle.length) return undefined;
  const span = lastIndex - firstIndex + 1;
  const gaps = span - needle.length;
  return Math.max(0, 120 - firstIndex - gaps * 3) + needle.length * 2;
}

function textCandidate(
  query: string,
  candidate: string,
  kinds: {
    exact: ActionSearchMatchKindV1;
    prefix: ActionSearchMatchKindV1;
    tokenPrefix: ActionSearchMatchKindV1;
  },
  bases: { exact: number; prefix: number; tokenPrefix: number; subsequence: number },
): MatchCandidate | undefined {
  if (candidate === "") return undefined;
  const lengthBonus = Math.max(0, 100 - Math.max(0, candidate.length - query.length));
  if (candidate === query) return { score: bases.exact + lengthBonus, matchKind: kinds.exact };
  if (candidate.startsWith(query)) {
    return { score: bases.prefix + lengthBonus, matchKind: kinds.prefix };
  }
  if (tokenPrefixMatches(query, candidate)) {
    return { score: bases.tokenPrefix + lengthBonus, matchKind: kinds.tokenPrefix };
  }
  const subsequence = subsequenceQuality(query, candidate);
  return subsequence === undefined
    ? undefined
    : { score: bases.subsequence + subsequence, matchKind: "subsequence" };
}

function bestCandidate(
  current: MatchCandidate | undefined,
  candidate: MatchCandidate | undefined,
): MatchCandidate | undefined {
  if (!candidate) return current;
  if (!current || candidate.score > current.score) return candidate;
  return current;
}

function scoreEntry(
  entry: ActionCatalogEntryV1,
  normalizedQuery: string,
  locale: string,
  aliases: readonly string[],
): MatchCandidate | undefined {
  let best: MatchCandidate | undefined;
  const title = normalizeActionSearchTextV1(entry.action.title.fallback, locale);
  best = bestCandidate(
    best,
    textCandidate(
      normalizedQuery,
      title,
      {
        exact: "title-exact",
        prefix: "title-prefix",
        tokenPrefix: "title-token-prefix",
      },
      { exact: 1_000, prefix: 900, tokenPrefix: 820, subsequence: 420 },
    ),
  );

  if (entry.action.subtitle) {
    best = bestCandidate(
      best,
      textCandidate(
        normalizedQuery,
        normalizeActionSearchTextV1(entry.action.subtitle.fallback, locale),
        {
          exact: "subtitle-exact",
          prefix: "subtitle-prefix",
          tokenPrefix: "subtitle-token-prefix",
        },
        { exact: 760, prefix: 700, tokenPrefix: 650, subsequence: 310 },
      ),
    );
  }

  for (const alias of aliases) {
    best = bestCandidate(
      best,
      textCandidate(
        normalizedQuery,
        normalizeActionSearchTextV1(alias, locale),
        {
          exact: "alias-exact",
          prefix: "alias-prefix",
          tokenPrefix: "alias-token-prefix",
        },
        { exact: 850, prefix: 790, tokenPrefix: 730, subsequence: 360 },
      ),
    );
  }

  for (const keyword of entry.action.keywords ?? []) {
    best = bestCandidate(
      best,
      textCandidate(
        normalizedQuery,
        normalizeActionSearchTextV1(keyword, locale),
        {
          exact: "keyword-exact",
          prefix: "keyword-prefix",
          tokenPrefix: "keyword-token-prefix",
        },
        { exact: 820, prefix: 760, tokenPrefix: 700, subsequence: 340 },
      ),
    );
  }

  const groupLabel = entry.action.group.split(".").at(-1) ?? entry.action.group;
  best = bestCandidate(
    best,
    textCandidate(
      normalizedQuery,
      normalizeActionSearchTextV1(groupLabel, locale),
      { exact: "group-exact", prefix: "group-prefix", tokenPrefix: "group-prefix" },
      { exact: 620, prefix: 560, tokenPrefix: 520, subsequence: 250 },
    ),
  );

  if (best && entry.availability.available) {
    best = { ...best, score: best.score + 40 };
  }
  return best;
}

function isRelevantDefaultEntry(entry: ActionCatalogEntryV1): boolean {
  return (
    entry.availability.available ||
    entry.availability.reasons.every((reason) => reason.code === "missing-capability")
  );
}

function clampLimit(limit: number | undefined, maximum: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return maximum;
  return Math.max(0, Math.min(maximum, Math.floor(limit)));
}

/** Pure local filtering and deterministic ranking. No persistence or IO. */
export function searchActionCatalog(
  catalog: ActionCatalogV1,
  query: string,
  options: ActionSearchOptionsV1 = {},
): readonly ActionSearchResultV1[] {
  const locale = options.locale ?? catalog.context.locale;
  const normalizedQuery = normalizeActionSearchTextV1(
    query.slice(0, MAX_QUERY_LENGTH),
    locale,
  );
  const limit = clampLimit(options.limit, catalog.actions.length);
  if (limit === 0) return Object.freeze([]);

  if (normalizedQuery === "") {
    return Object.freeze(
      catalog.actions
        .filter(isRelevantDefaultEntry)
        .slice(0, limit)
        .map((entry) => Object.freeze({ entry, score: 0, matchKind: "default" as const })),
    );
  }

  const results: ActionSearchResultV1[] = [];
  for (const entry of catalog.actions) {
    const candidate = scoreEntry(
      entry,
      normalizedQuery,
      locale,
      options.aliases?.[entry.action.id] ?? [],
    );
    if (!candidate) continue;
    results.push({ entry, ...candidate });
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.catalogIndex - b.entry.catalogIndex ||
      (a.entry.action.id < b.entry.action.id
        ? -1
        : a.entry.action.id > b.entry.action.id
          ? 1
          : 0),
  );
  return Object.freeze(
    results.slice(0, limit).map((result) => Object.freeze(result)),
  );
}
