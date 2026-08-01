interface PagefindResultDataV1 {
  url: string;
  excerpt?: string;
  meta: { title?: string };
}

interface PagefindResultV1 {
  data(): Promise<PagefindResultDataV1>;
}

interface PagefindSearchResponseV1 {
  results: readonly PagefindResultV1[];
}

interface PagefindInstanceV1 {
  init(): Promise<void>;
  search(query: string, options?: { filters?: Record<string, string> }): Promise<PagefindSearchResponseV1>;
}

interface PagefindModuleV1 extends PagefindInstanceV1 {
  createInstance?(options: { noWorker?: boolean }): PagefindInstanceV1;
}

interface SearchMessagesV1 {
  searching: string;
  noResults: string;
  unavailable: string;
  resultCount: string;
}

function messagesFor(root: HTMLElement): SearchMessagesV1 {
  try {
    const parsed = JSON.parse(root.dataset.atlcliSearchMessages ?? "{}") as Partial<SearchMessagesV1>;
    return {
      searching: typeof parsed.searching === "string" ? parsed.searching : "Searching…",
      noResults: typeof parsed.noResults === "string" ? parsed.noResults : "No results found.",
      unavailable: typeof parsed.unavailable === "string" ? parsed.unavailable : "Search is temporarily unavailable.",
      resultCount: typeof parsed.resultCount === "string" ? parsed.resultCount : "{count} results",
    };
  } catch {
    return { searching: "Searching…", noResults: "No results found.", unavailable: "Search is temporarily unavailable.", resultCount: "{count} results" };
  }
}

function renderedCount(template: string, count: number): string {
  return template.replace("{count}", String(count));
}

function safeResultHref(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function loadPagefind(root: HTMLElement): Promise<PagefindInstanceV1> {
  const url = root.dataset.pagefindUrl;
  if (url === undefined || url.length === 0) throw new Error("Pagefind URL is missing");
  const module = await import(/* @vite-ignore */ url) as PagefindModuleV1;
  const mainThread = root.dataset.pagefindRuntime === "main-thread";
  const instance = module.createInstance === undefined ? module : module.createInstance(mainThread ? { noWorker: true } : {});
  await instance.init();
  return instance;
}

/** Attach one accessible, static Pagefind UI to an already-rendered semantic root. */
export function initPagefindSearchV1(root: HTMLElement): void {
  const trigger = root.querySelector("[data-atlcli-search-trigger]");
  const dialog = root.querySelector("[data-atlcli-search-dialog]");
  const input = root.querySelector("[data-atlcli-search-input]");
  const filters = [...root.querySelectorAll<HTMLSelectElement>("[data-atlcli-search-filter]")];
  const status = root.querySelector("[data-atlcli-search-status]");
  const results = root.querySelector("[data-atlcli-search-results]");
  if (!(input instanceof HTMLInputElement) || !(status instanceof HTMLElement) || !(results instanceof HTMLOListElement)) return;
  if (trigger !== null && !(trigger instanceof HTMLButtonElement)) return;
  if (dialog !== null && !(dialog instanceof HTMLDialogElement)) return;

  const messages = messagesFor(root);
  let pagefind: PagefindInstanceV1 | undefined;
  let request = 0;
  const open = (): void => {
    if (dialog === null) return;
    dialog.showModal();
    input.focus();
  };
  trigger?.addEventListener("click", open);
  document.addEventListener("keydown", (event) => {
    const shortcut = root.dataset.shortcut;
    const modK = shortcut === "mod+k" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
    const slash = shortcut === "/" && event.key === "/" && document.activeElement === document.body;
    if (modK || slash) {
      event.preventDefault();
      open();
    }
  });
  const search = async (): Promise<void> => {
    const current = ++request;
    const query = input.value.trim();
    results.replaceChildren();
    if (query.length === 0) {
      status.textContent = "";
      return;
    }
    status.textContent = messages.searching;
    try {
      pagefind ??= await loadPagefind(root);
      const selected = Object.fromEntries(filters
        .filter((filter) => filter.value.length > 0 && filter.dataset.atlcliSearchFilter !== undefined)
        .map((filter) => [filter.dataset.atlcliSearchFilter!, filter.value]));
      const found = await pagefind.search(query, Object.keys(selected).length === 0 ? undefined : { filters: selected });
      const entries = await Promise.all(found.results.slice(0, 20).map(async (result) => result.data()));
      if (current !== request) return;
      for (const entry of entries) {
        const href = safeResultHref(entry.url);
        if (href === undefined) continue;
        const item = document.createElement("li");
        const link = document.createElement("a");
        const excerpt = document.createElement("p");
        link.href = href;
        link.textContent = entry.meta.title ?? entry.url;
        excerpt.textContent = entry.excerpt ?? "";
        item.append(link, excerpt);
        results.append(item);
      }
      status.textContent = entries.length === 0 ? messages.noResults : renderedCount(messages.resultCount, entries.length);
    } catch {
      if (current === request) status.textContent = messages.unavailable;
    }
  };
  input.addEventListener("input", () => { void search(); });
  filters.forEach((filter) => filter.addEventListener("change", () => { void search(); }));
}
