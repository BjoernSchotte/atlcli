/** Theme-neutral strings for the static Pagefind search components. */
export interface PagefindSearchMessagesV1 {
  trigger: string;
  close: string;
  dialogLabel: string;
  pageLabel: string;
  queryLabel: string;
  queryPlaceholder: string;
  filterLabel: string;
  allFilters: string;
  searching: string;
  noResults: string;
  unavailable: string;
  resultCount: (count: number) => string;
}

/** An allowlisted Pagefind facet exposed by a theme-neutral search component. */
export interface PagefindSearchFilterV1 {
  name: string;
  label: string;
  values: readonly string[];
}

export const DEFAULT_PAGEFIND_SEARCH_MESSAGES_V1: PagefindSearchMessagesV1 = Object.freeze({
  trigger: "Search",
  close: "Close search",
  dialogLabel: "Search documentation",
  pageLabel: "Search documentation",
  queryLabel: "Search",
  queryPlaceholder: "Search documentation",
  filterLabel: "Filter by label",
  allFilters: "All labels",
  searching: "Searching…",
  noResults: "No results found.",
  unavailable: "Search is temporarily unavailable.",
  resultCount: (count: number) => `${count} result${count === 1 ? "" : "s"}`,
});

export type PagefindSearchRuntimeV1 = "auto" | "main-thread";

export function normalizePagefindSearchFiltersV1(
  labels: readonly string[],
  filters: readonly PagefindSearchFilterV1[] | undefined,
): readonly PagefindSearchFilterV1[] {
  const candidate = filters ?? (labels.length === 0 ? [] : [{ name: "label", label: "Filter by label", values: labels }]);
  const seen = new Set<string>();
  return candidate.map((filter) => {
    if (!/^[a-z][a-z0-9-]*$/u.test(filter.name) || seen.has(filter.name)) {
      throw new TypeError("Pagefind search filter names must be unique lowercase identifiers");
    }
    seen.add(filter.name);
    if (filter.label.trim().length === 0 || filter.values.some((value) => value.trim().length === 0)) {
      throw new TypeError("Pagefind search filters require non-empty labels and values");
    }
    return Object.freeze({ name: filter.name, label: filter.label, values: Object.freeze([...filter.values]) });
  });
}
