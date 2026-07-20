/**
 * Session-auth macro ports for the extension host (spec 010 T5.4,
 * Architecture point 6).
 *
 * ## Adapters, not a second HTTP stack
 *
 * Every port here is a thin adapter over the SAME session-capable clients the
 * rest of the panel already uses — `ConfluenceClient` from
 * `@atlcli/confluence/browser` (the class `TemplateSection.tsx` constructs via
 * `profileFromTabUrl`) and `JiraClient` from `@atlcli/jira`. That is not merely
 * DRY. `ConfluenceClient` already implements, for `auth.type === "session"`:
 *
 *  - `redirect: "manual"` + `assertNotAuthRedirect` (`client.ts:198-217`) —
 *    an unauthenticated Atlassian API call answers with a 3xx to
 *    `id.atlassian.com`; manual redirect stops the browser from following that
 *    bounce WITH COOKIES to a foreign origin, and the opaque redirect is
 *    classified as "not logged in";
 *  - `assertSessionJsonOk` — a 200 whose body is an HTML login page (or a JSON
 *    error envelope) becomes an error instead of a silently-empty page;
 *  - 429 `Retry-After` exponential backoff and 5xx retry (`client.ts:299-318`),
 *    abortable mid-backoff.
 *
 * A hand-rolled session `fetch()` adapter would have to reinvent all three and
 * would, in practice, only map 403/404 → skip. Adapting the clients means
 * session macro fetches inherit login-expiry and rate-limit handling for free.
 *
 * ## Response taxonomy (beyond what the clients already do)
 *
 * | Situation | Port behaviour | Chain outcome |
 * |---|---|---|
 * | 403 | `PortError("permission")` | `skip` + permission note, chain continues |
 * | 404 | `PortError("not-found")` | `skip` + not-found note, chain continues |
 * | 401 / auth redirect / login page | latch {@link SessionMacroState} + `PortError("permission")` | **live resolution stops**: every later port call short-circuits without a request, and one distinct `auth-error` note is surfaced |
 * | 429 after the client's own retries | `PortError("rate-limited")` | `degraded` note, chain continues (the resolver's breaker then skips the service) |
 * | 5xx after the client's own retries | `PortError("network")` | `degraded` note, chain continues |
 * | abort | `AbortError` rethrown | whole export aborts (resolver contract) |
 *
 * The "session expired" case is deliberately NOT an `AbortError`: aborting the
 * resolver would kill the entire export. It is also deliberately not a plain
 * per-macro skip: that degrades silently to a placeholder cascade, page after
 * page, with nothing telling the user to sign in again. The latch gives the
 * honest middle: stop making doomed live calls immediately, keep the export,
 * and say once, loudly, what happened.
 *
 * ## Wiring status (read before consuming)
 *
 * This module owns the port CONSTRUCTION only. A wave-2 agent wires
 * {@link buildSessionMacroResolutionOptions} into `PdfExportEnv.macros`
 * (`utils/pdf/run-export.ts`) and `ExportEnv.macros` (the DOCX path via
 * `utils/docx/export-deps.ts`), and wires
 * {@link createExternalAssetPolicy}/{@link createExternalAssetFetcher} into
 * both asset resolvers. Nothing here reaches into those files.
 */
import {
  ConfluenceClient,
  escapeCqlValue,
  extractMacroBody,
  htmlToExportBlocks,
  parsePageProperties,
  storageToBlocks,
  type ExportNote,
} from "@atlcli/confluence/browser";
import {
  defaultRegistry,
  portError,
  type AttachmentLookupPort,
  type AttachmentMeta,
  type ConfluenceContentPort,
  type ExportViewPort,
  type ExternalAssetFetcher,
  type ExternalAssetPolicy,
  type JiraIssuePort,
  type JiraIssueRef,
  type MacroExportContext,
  type MacroRendererRegistry,
  type MacroResolutionOptions,
  type PortErrorKind,
} from "@atlcli/export-macros";
import { jiraStatusColor } from "@atlcli/export-macros/internal";
import { profileFromTabUrl } from "../profile.js";
import {
  createExternalAssetFetcher,
  createExternalAssetPolicy,
  EXTERNAL_ASSET_MAX_BYTES,
} from "./external-asset-policy.js";

// ---------------------------------------------------------------------------
// Session-expiry latch
// ---------------------------------------------------------------------------

/** The one message the panel and the export report use for an expired session. */
export const SESSION_EXPIRED_MESSAGE =
  "Your Atlassian session expired — sign in again in this browser and re-run the export. " +
  "Live macro rendering was stopped; unresolved macros were emitted as placeholders.";

/**
 * Shared across every port of one export pass. Once {@link markExpired} fires,
 * further port calls reject immediately WITHOUT a network request — that is
 * what "abort the live-macro resolution pass" means in practice, as opposed to
 * aborting the export (`AbortError`) or degrading silently per macro.
 */
export interface SessionMacroState {
  readonly expired: boolean;
  /** Latch the pass. Idempotent — the note is emitted exactly once. */
  markExpired(service?: string): void;
  /**
   * Report notes accumulated by this pass. Empty unless the session expired.
   * The wiring appends these to the export report's source notes.
   */
  notes(): ExportNote[];
  /** Clear the latch (new export pass / test isolation). */
  reset(): void;
}

export function createSessionMacroState(onExpired?: (service?: string) => void): SessionMacroState {
  let expired = false;
  const collected: ExportNote[] = [];
  return {
    get expired(): boolean {
      return expired;
    },
    markExpired(service?: string): void {
      if (expired) return;
      expired = true;
      collected.push({
        level: "warning",
        code: "auth-error",
        message: SESSION_EXPIRED_MESSAGE,
      });
      onExpired?.(service);
    },
    notes(): ExportNote[] {
      return [...collected];
    },
    reset(): void {
      expired = false;
      collected.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Parse the leading `(NNN)` status out of a client's generic error message. */
function statusOf(message: string): number | undefined {
  const m = message.match(/\((\d{3})\)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * True for the shapes both clients use to signal "the ambient session is gone":
 * `assertNotAuthRedirect`'s `(302): authentication redirect …`,
 * `assertSessionJsonOk`'s `(login): non-JSON 200 response (login page …)`,
 * and a plain 401. Jira's client has no `assertNotAuthRedirect` of its own
 * (verified: `packages/jira/src/client.ts` carries no such guard), so for the
 * Jira port this string/status classification is the ONLY session-expiry
 * detection there is — which is exactly why it lives in the adapter and covers
 * the follow-the-redirect-to-a-login-page shapes too.
 */
function isSessionExpiry(message: string, status: number | undefined): boolean {
  if (status === 401) return true;
  if (status !== undefined && status >= 300 && status < 400) return true;
  return (
    /authentication redirect/i.test(message) ||
    /session not logged in/i.test(message) ||
    /login page/i.test(message) ||
    /\(login\)/i.test(message)
  );
}

/** True for the clients' "gave up after N retries" rate-limit error. */
function isExhaustedRateLimit(message: string): boolean {
  return /rate limited by (confluence|jira) api after \d+ retries/i.test(message);
}

/** Conservative retry hint when the client swallowed the `Retry-After` header. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

/** Human-facing product name per port, for report notes. */
function productOf(service: string): string {
  return service === "jira" ? "Jira" : "Confluence";
}

/**
 * Map a client error onto the tagged {@link PortError} vocabulary the resolver
 * branches on, latching {@link SessionMacroState} for auth failures. Always
 * throws.
 *
 * The `message` is written for the export REPORT, not for a log: the renderers
 * embed it verbatim in their `macro-degraded` notes
 * (`packages/export-macros/src/export-view.ts:54`), and the clients' own
 * strings are unhelpful there — `logBody: "meta-only"` deliberately redacts the
 * response body, so a raw client message reads
 * `Confluence API error (403): [response body omitted: logBody policy]`. The
 * original error is preserved as `cause`.
 */
export function classifySessionPortError(
  error: unknown,
  service: string,
  state: SessionMacroState
): never {
  // An abort must reach the resolver untouched: it aborts the whole export.
  if (error instanceof Error && error.name === "AbortError") throw error;
  const raw = error instanceof Error ? error.message : String(error);
  const status = statusOf(raw);
  const product = productOf(service);

  if (isSessionExpiry(raw, status)) {
    state.markExpired(service);
    throw portError("permission", SESSION_EXPIRED_MESSAGE, { service, cause: error });
  }
  if (isExhaustedRateLimit(raw) || status === 429) {
    throw portError(
      "rate-limited",
      `${product} rate-limited the export (429) after the client's own retries; this macro was skipped.`,
      { service, retryAfterMs: RATE_LIMIT_COOLDOWN_MS, cause: error }
    );
  }
  if (status === 403) {
    throw portError(
      "permission",
      `${product} denied access (403): no permission to view this macro's content.`,
      { service, cause: error }
    );
  }
  if (status === 404) {
    throw portError(
      "not-found",
      `${product} returned not found (404) for this macro's content.`,
      { service, cause: error }
    );
  }
  if (status !== undefined && status >= 500) {
    throw portError(
      "network",
      `${product} returned a server error (${status}) after the client's own retries; this macro was skipped.`,
      { service, cause: error }
    );
  }
  const kind: PortErrorKind = status !== undefined && status >= 400 ? "invalid-response" : "network";
  throw portError(kind, `${product} request failed: ${raw}`, { service, cause: error });
}

/** Guard run before every port call: latched session + cooperative abort. */
function preflight(service: string, state: SessionMacroState, signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Macro resolution aborted.", "AbortError");
  if (state.expired) {
    // No request: the pass is over for live ports. The resolver turns this into
    // a placeholder for THIS macro; the distinct note lives on the state.
    throw portError("permission", SESSION_EXPIRED_MESSAGE, { service });
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The slice of `JiraClient` the Jira port drives, expressed structurally.
 *
 * Structural (not `import type { JiraClient } from "@atlcli/jira"`) for one
 * reason only: `apps/extension/package.json` does not yet declare
 * `@atlcli/jira`, so the specifier does not resolve from this workspace. The
 * signatures below are copied verbatim from `packages/jira/src/client.ts`
 * (`getIssue`, `search`), so a real `JiraClient` instance satisfies this
 * interface with no cast — see the handoff note: adding the dependency makes
 * `const c: JiraClientLike = new JiraClient(profile)` compile as-is, and this
 * interface can then be replaced by the import in a one-line diff.
 */
export interface JiraClientLike {
  getIssue(
    keyOrId: string,
    options?: { fields?: string[]; expand?: string }
  ): Promise<JiraIssueLike>;
  search(
    jql: string,
    options?: { maxResults?: number; fields?: string[]; expand?: string; nextPageToken?: string }
  ): Promise<{ issues: JiraIssueLike[] }>;
}

/** The fields the Jira renderer reads off an issue (subset of `JiraIssue`). */
export interface JiraIssueLike {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { colorName?: string } } | null;
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    priority?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    created?: string;
    updated?: string;
    duedate?: string | null;
    labels?: string[];
  };
}

/** Best-effort extra columns for a JQL table (mirrors the CLI wiring). */
function extraFields(issue: JiraIssueLike): Record<string, string> {
  const f = issue.fields;
  const out: Record<string, string> = {};
  if (f.assignee) out.assignee = f.assignee.displayName ?? "";
  if (f.reporter) out.reporter = f.reporter.displayName ?? "";
  if (f.priority) out.priority = f.priority.name ?? "";
  if (f.created) out.created = f.created;
  if (f.updated) out.updated = f.updated;
  if (f.duedate) out.duedate = f.duedate;
  if (f.labels) out.labels = f.labels.join(", ");
  if (f.issuetype) out.type = f.issuetype.name ?? "";
  return out;
}

export interface SessionPortDeps {
  state: SessionMacroState;
  signal?: AbortSignal;
}

/**
 * {@link JiraIssuePort} over `JiraClient` (`<profile.baseUrl>/rest/api/3` — the
 * Cloud v3 path the client picks itself for `*.atlassian.net`, covered by the
 * manifest's existing `*://*.atlassian.net/*` host permission, same origin as
 * Confluence).
 *
 * The Jira client takes no `AbortSignal` (verified: its `request()` has no
 * `signal` option, unlike `ConfluenceClient`'s), so the signal is honoured
 * cooperatively — checked before the call and again after it settles — rather
 * than by tearing down the in-flight request. That is the honest boundary: a
 * cancel stops the NEXT issue fetch immediately and stops the current one from
 * being used.
 */
export function sessionJiraIssuePort(
  client: JiraClientLike,
  browseBaseUrl: string,
  deps: SessionPortDeps
): JiraIssuePort {
  const base = browseBaseUrl.replace(/\/+$/, "");
  const toRef = (issue: JiraIssueLike): JiraIssueRef => ({
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    statusColor: jiraStatusColor(issue.fields.status?.statusCategory?.colorName),
    url: `${base}/browse/${issue.key}`,
    fields: extraFields(issue),
  });
  const after = (): void => {
    if (deps.signal?.aborted) throw new DOMException("Macro resolution aborted.", "AbortError");
  };
  return {
    async getIssue(key) {
      preflight("jira", deps.state, deps.signal);
      try {
        const issue = await client.getIssue(key);
        after();
        return toRef(issue);
      } catch (err) {
        classifySessionPortError(err, "jira", deps.state);
      }
    },
    async searchJql(jql, opts) {
      preflight("jira", deps.state, deps.signal);
      try {
        const res = await client.search(jql, { maxResults: opts.maximumIssues });
        after();
        return res.issues.slice(0, opts.maximumIssues).map(toRef);
      } catch (err) {
        classifySessionPortError(err, "jira", deps.state);
      }
    },
  };
}

export interface SessionExportViewDeps extends SessionPortDeps {
  /**
   * Page version lookup for the single-macro fallback. Populated by
   * {@link buildSessionMacroResolutionOptions}'s `contextFor` from each macro's
   * OWN source page — never the export root's.
   */
  versionOf?: (pageId: string) => number | undefined;
}

/**
 * {@link ExportViewPort} over `ConfluenceClient` (BASELINE-DESIGN E1/E2).
 *
 * Batch first: `getExportViewMacros(pageId)` fetches the whole page's
 * `export_view` body ONCE and returns a `data-macro-id` → HTML map, so N macros
 * on a page cost one request instead of N (this is the rate-limit protection —
 * a per-macro fetch is what makes a large tree export trip 429s). The
 * per-macro v1 endpoints (`/content/{id}/history/{v}/macro/id/{macroId}` +
 * `/contentbody/convert/export_view`) are the fallback for a macro the batch
 * body does not carry, and need the page version — hence {@link versionOf}.
 *
 * The batch promise is memoised per page id for the lifetime of the port, so
 * every macro on a page shares one request even across the resolver's
 * concurrency pool.
 */
export function sessionExportViewPort(
  client: ConfluenceClient,
  deps: SessionExportViewDeps
): ExportViewPort {
  const batches = new Map<string, Promise<Map<string, string>>>();
  return {
    async renderMacroHtml(pageId, macroId) {
      preflight("exportView", deps.state, deps.signal);
      try {
        let batch = batches.get(pageId);
        if (!batch) {
          batch = client.getExportViewMacros(pageId, {
            ...(deps.signal ? { signal: deps.signal } : {}),
          });
          batches.set(pageId, batch);
        }
        const rendered = (await batch).get(macroId);
        if (rendered !== undefined) return rendered;

        const version = deps.versionOf?.(pageId);
        if (version === undefined) return undefined;
        return await client.getMacroBodyByMacroId(pageId, version, macroId, {
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
      } catch (err) {
        // A failed batch must not poison every later macro on the page with a
        // settled rejection — drop it so a retry (or a different macro) can
        // take the single-macro path.
        batches.delete(pageId);
        classifySessionPortError(err, "exportView", deps.state);
      }
    },
  };
}

/** {@link ConfluenceContentPort} over `ConfluenceClient` (include/children/excerpt). */
export function sessionConfluenceContentPort(
  client: ConfluenceClient,
  deps: SessionPortDeps
): ConfluenceContentPort {
  const fetchStorage = async (id: string) => {
    const page = await client.getPage(id);
    return { id: page.id, version: page.version ?? 1, storage: page.storage };
  };
  return {
    async getPageStorage(title, spaceKey) {
      preflight("confluence", deps.state, deps.signal);
      try {
        // `title`/`spaceKey` come from MACRO PARAMETERS (page-editor-controlled
        // — a different trust boundary than panel input), so they go through
        // the same `escapeCqlValue` every other CQL builder uses.
        const cql = spaceKey
          ? `type=page AND space="${escapeCqlValue(spaceKey)}" AND title="${escapeCqlValue(title)}"`
          : `type=page AND title="${escapeCqlValue(title)}"`;
        const results = await client.searchPages(cql, 1);
        if (results.length === 0) return undefined;
        return await fetchStorage(results[0].id);
      } catch (err) {
        classifySessionPortError(err, "confluence", deps.state);
      }
    },
    async getPageStorageById(id) {
      preflight("confluence", deps.state, deps.signal);
      try {
        return await fetchStorage(id);
      } catch (err) {
        classifySessionPortError(err, "confluence", deps.state);
      }
    },
    async getChildren(pageId, opts) {
      preflight("confluence", deps.state, deps.signal);
      try {
        // getChildrenWithPosition (child-page endpoint), NOT the CQL-based
        // getChildren: CQL indexing lags and has no position guarantee.
        const cap = opts?.limit ?? 100;
        const children = await client.getChildrenWithPosition(pageId, { limit: cap });
        return children.slice(0, cap).map((c) => ({ id: c.id, title: c.title }));
      } catch (err) {
        classifySessionPortError(err, "confluence", deps.state);
      }
    },
    async searchCql(cql, opts) {
      preflight("confluence", deps.state, deps.signal);
      try {
        const results = await client.searchPages(cql, opts?.limit ?? 25);
        return results.map((r) => ({ id: r.id, title: r.title }));
      } catch (err) {
        classifySessionPortError(err, "confluence", deps.state);
      }
    },
  };
}

/** {@link AttachmentLookupPort} over `ConfluenceClient`, one listing per page. */
export function sessionAttachmentLookupPort(
  client: ConfluenceClient,
  deps: SessionPortDeps
): AttachmentLookupPort {
  const listings = new Map<
    string,
    Promise<Awaited<ReturnType<ConfluenceClient["listAttachments"]>>>
  >();
  return {
    async lookup(pageId, filename): Promise<AttachmentMeta | undefined> {
      preflight("confluence", deps.state, deps.signal);
      try {
        let listing = listings.get(pageId);
        if (!listing) {
          listing = client.listAttachments(pageId);
          listings.set(pageId, listing);
        }
        const found = (await listing).find((a) => a.filename === filename);
        if (!found) return undefined;
        return {
          filename: found.filename,
          version: found.version,
          ...(found.modified ? { modified: found.modified } : {}),
        };
      } catch (err) {
        listings.delete(pageId);
        classifySessionPortError(err, "confluence", deps.state);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Registry + resolution options
// ---------------------------------------------------------------------------

/**
 * The extension's `defaultRegistry` construction site. Mirrors the CLI
 * (`apps/cli/src/commands/export-macros-wiring.ts#buildMacroResolutionOptions`)
 * exactly — same injected deps, same renderer set — so a macro renders
 * identically from the panel and from the CLI. The only difference is the
 * import specifier: the browser barrel (`@atlcli/confluence/browser`), which
 * `scripts/check-browser-build.ts` proves is free of `node:`/`bun:` specifiers,
 * and which exports `html-to-blocks.ts` (folder 004's T1.10).
 */
export function createSessionMacroRegistry(): MacroRendererRegistry {
  return defaultRegistry({
    storageToBlocks,
    htmlToExportBlocks,
    parsePageProperties,
    extractMacroBody,
  });
}

export interface SessionMacroPorts {
  jira?: JiraIssuePort;
  exportView: ExportViewPort;
  confluence: ConfluenceContentPort;
  attachments: AttachmentLookupPort;
  externalAssets: ExternalAssetFetcher;
  policy: ExternalAssetPolicy;
  state: SessionMacroState;
}

export interface SessionMacroPortsInput {
  /** The active tab's URL — the single source of the session profile. */
  pageUrl: string;
  /** Overrides for tests / callers that already hold a client. */
  confluenceClient?: ConfluenceClient;
  /**
   * A `JiraClient` (structurally {@link JiraClientLike}). Optional: without it
   * the Jira renderer degrades through the chain exactly as it does in the CLI
   * for a profile with no Jira access.
   */
  jiraClient?: JiraClientLike;
  signal?: AbortSignal;
  state?: SessionMacroState;
  /** Extra origins beyond the site's own; defaults to the Atlassian media set. */
  allowedMediaOrigins?: readonly string[];
  fetchFn?: typeof fetch;
  versionOf?: (pageId: string) => number | undefined;
}

/**
 * Build every session port from the active tab URL. Throws for a non-Atlassian
 * tab — the same gate `pageResolver`/`TemplateSection` already apply, so the
 * panel never attempts a session fetch the manifest would not permit.
 */
export function createSessionMacroPorts(input: SessionMacroPortsInput): SessionMacroPorts {
  const profile = profileFromTabUrl(input.pageUrl);
  if (!profile) {
    throw new Error("The active page is not on an approved Atlassian host.");
  }
  const state = input.state ?? createSessionMacroState();
  const deps: SessionPortDeps = { state, ...(input.signal ? { signal: input.signal } : {}) };
  const confluence = input.confluenceClient ?? new ConfluenceClient(profile);
  const policy = createExternalAssetPolicy({
    siteOrigin: profile.baseUrl,
    ...(input.allowedMediaOrigins ? { allowedMediaOrigins: input.allowedMediaOrigins } : {}),
  });
  return {
    ...(input.jiraClient
      ? { jira: sessionJiraIssuePort(input.jiraClient, profile.baseUrl, deps) }
      : {}),
    exportView: sessionExportViewPort(confluence, {
      ...deps,
      ...(input.versionOf ? { versionOf: input.versionOf } : {}),
    }),
    confluence: sessionConfluenceContentPort(confluence, deps),
    attachments: sessionAttachmentLookupPort(confluence, deps),
    externalAssets: createExternalAssetFetcher(policy, {
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    }),
    policy,
    state,
  };
}

export interface BuildSessionMacroOptionsInput extends SessionMacroPortsInput {
  targetEngine: "docx" | "pdf";
  /** `false` when the panel's "Resolve dynamic macros" toggle is off. */
  live?: boolean;
  /** Whether the DOCX template already carries a native TOC field. */
  nativeTocPresent?: boolean;
  /** Reuse ports already built by {@link createSessionMacroPorts}. */
  ports?: SessionMacroPorts;
}

export interface SessionMacroResolution {
  options: MacroResolutionOptions;
  ports: SessionMacroPorts;
  /** Report notes to append after the resolve pass (session expiry, …). */
  notes(): ExportNote[];
}

/**
 * Assemble the `MacroResolutionOptions` the engine env accepts.
 *
 * **`contextFor` is passed through UNCHANGED from `@atlcli/export-macros`.**
 * The resolver calls `contextFor(block.sourcePage ?? ctx.page)`
 * (`packages/export-macros/src/resolve.ts:300`), i.e. it hands us each macro's
 * OWN source page in a tree/space export. This function therefore builds the
 * context from the `page` argument and nothing else — it must never substitute
 * the export root's id, or every Jira/`export_view` macro on a child page would
 * resolve against the wrong page (wrong attachment lookups, wrong diagram
 * previews, wrong macro bodies) while looking perfectly successful in the
 * report. `page.version` is recorded per page for the `export_view`
 * single-macro fallback, again keyed by the macro's own page.
 *
 * The ports themselves are shared across pages on purpose: the batch/listing
 * memoisation, the dedup cache and the circuit breaker are all keyed by page id
 * inside the ports, so sharing them is what makes a 200-page export cost one
 * `export_view` request per page rather than one per macro.
 */
export function buildSessionMacroResolutionOptions(
  input: BuildSessionMacroOptionsInput
): SessionMacroResolution {
  const pageVersions = new Map<string, number>();
  const ports =
    input.ports ??
    createSessionMacroPorts({
      ...input,
      versionOf: input.versionOf ?? ((pageId) => pageVersions.get(pageId)),
    });
  const registry = createSessionMacroRegistry();
  const siteId = profileFromTabUrl(input.pageUrl)?.baseUrl ?? input.pageUrl;

  const options: MacroResolutionOptions = {
    registry,
    ...(input.live !== undefined ? { live: input.live } : {}),
    contextFor(page): MacroExportContext {
      // Per-source-page, never the export root (see the doc comment above).
      if (page.version !== undefined) pageVersions.set(page.id, page.version);
      return {
        page,
        confluence: ports.confluence,
        exportView: ports.exportView,
        attachments: ports.attachments,
        ...(ports.jira ? { jira: ports.jira } : {}),
        externalAssets: ports.externalAssets,
        depth: 0,
        visited: new Set<string>(),
        siteId,
        ...(input.signal ? { signal: input.signal } : {}),
        flags: {
          ...(input.nativeTocPresent ? { nativeTocPresent: true } : {}),
          targetEngine: input.targetEngine,
        },
      };
    },
  };

  return { options, ports, notes: () => ports.state.notes() };
}

export { EXTERNAL_ASSET_MAX_BYTES };
