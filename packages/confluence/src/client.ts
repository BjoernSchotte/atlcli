import { parseRetryAfterMs } from "./retry-after.js";
import {
  SessionRedirectBlockedError,
  createAtlassianSessionRedirectPolicy,
  fetchSessionBinaryFollowingRedirects,
  type SessionRedirectPolicy,
} from "@atlcli/core/internal";
import {
  Profile,
  getLogger,
  generateRequestId,
  redactSensitive,
  buildAuthHeader,
  buildTlsOptions,
  getConfluenceBaseUrl,
  TlsOptions,
} from "@atlcli/core";
import { drainPaginated } from "./pagination.js";
import { extractExportViewMacros as extractMacroFragments } from "./html-to-blocks.js";

export type ConfluencePage = {
  id: string;
  title: string;
  url?: string;
  version?: number;
  spaceKey?: string;
  parentId?: string | null;
  ancestors?: { id: string; title: string }[];
};

export type ConfluenceUser = {
  accountId?: string;
  displayName: string;
  email?: string;
};

export type ConfluencePageDetails = ConfluencePage & {
  storage: string;
  created?: string;
  createdBy?: ConfluenceUser;
  modified?: string;
  modifiedBy?: ConfluenceUser;
  labels?: string[];
  tinyUrl?: string;
  /** Editor version: 'v2' (new editor), 'v1' (legacy), or null (unknown) */
  editorVersion?: "v2" | "v1" | null;
};

export type ConfluenceSpace = {
  id: string;
  key: string;
  name: string;
  type: "global" | "personal";
  url?: string;
};

/** A space's logo, from `GET /space/{key}?expand=icon` (spec 005, gap G3). */
export type SpaceIcon = {
  /** Wiki-base-relative download path (e.g. `/download/attachments/…`). */
  path: string;
  width?: number;
  height?: number;
  /** True for the stock Confluence space logo (an SVG on Cloud). */
  isDefault?: boolean;
};

export type ConfluenceSearchResult = {
  id: string;
  title: string;
  url?: string;
  spaceKey?: string;
  spaceName?: string;
  version?: number;
  lastModified?: string;
  excerpt?: string;
  type?: string;
  labels?: string[];
  creator?: string;
  created?: string;
};

/** Sync scope type for polling */
export type SyncScope =
  | { type: "page"; pageId: string }
  | { type: "tree"; ancestorId: string }
  | { type: "space"; spaceKey: string };

/** Page change info for polling */
export interface PageChangeInfo {
  id: string;
  title: string;
  version: number;
  lastModified?: string;
  spaceKey?: string;
}

/**
 * Confluence Cloud folder (introduced Sept 2024).
 * Folders are containers with no content body, used to organize pages.
 */
export type ConfluenceFolder = {
  id: string;
  title: string;
  spaceId: string;
  parentId: string | null;
  url?: string;
  createdAt?: string;
};

/**
 * Child content within a container (page or folder).
 *
 * `type` is an **open** union on purpose: `direct-children` endpoints return
 * more than pages and folders (whiteboards, databases, embeds, …). Narrowing it
 * to `"page" | "folder"` forced an unsound cast that silently mislabeled a
 * whiteboard as a page (it would then 404 or fetch the wrong content on a body
 * fetch). Callers that only traverse pages/folders must switch on the literal
 * members and treat any other string as an unsupported kind.
 */
export type FolderChild = {
  id: string;
  title: string;
  type: "page" | "folder" | (string & {});
  spaceId?: string;
  parentId?: string | null;
  url?: string;
};

/** Attachment metadata from Confluence API */
export interface AttachmentInfo {
  /** Attachment ID (content ID) */
  id: string;
  /** Filename as stored in Confluence */
  filename: string;
  /** MIME type (e.g., "image/png", "application/pdf") */
  mediaType: string;
  /** File size in bytes */
  fileSize: number;
  /** Version number */
  version: number;
  /** ISO timestamp of the attachment's last version (`version.when`), when the
   *  Confluence response exposes it — used by the spec-004 diagram-preview
   *  staleness note. Absent on responses that omit it. */
  modified?: string;
  /** Page ID this attachment belongs to */
  pageId: string;
  /** Download URL relative to the resolved Confluence base */
  downloadUrl: string;
  /** Full webui URL for viewing */
  url?: string;
  /** Comment/description for this version */
  comment?: string;
}

/**
 * Escape a value for safe inclusion inside a **double-quoted** CQL string
 * literal, e.g. `label in ("${escapeCqlValue(label)}")` or
 * `id in (${ids.map(escapeCqlValue)...})`.
 *
 * CQL string literals are double-quoted; the two characters that can break out
 * of one are the double quote and the backslash, so both are backslash-escaped.
 * Control characters (which CQL rejects and which can smuggle newlines into a
 * query) are stripped. Returns the escaped inner text WITHOUT the surrounding
 * quotes, so the caller controls quoting.
 *
 * Pure and exported (spec 002 owns this; spec 005 imports it — see PLAN.md
 * label-filter task). Today's search command escapes `text`/`title`/`creator`
 * but not `label`; this helper closes that gap for every CQL literal.
 */
export function escapeCqlValue(value: string): string {
  return value
    // Strip C0/C1 control characters (incl. NUL, newlines, DEL).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Extract the `cursor` query parameter from a v2 `_links.next` URL (which may be
 * relative), or `undefined` when there is no next link. Used as the pagination
 * token for cursor-based v2 endpoints.
 */
function extractCursor(nextLink: string | undefined, baseUrl: string): string | undefined {
  if (!nextLink) return undefined;
  const nextUrl = new URL(nextLink, baseUrl);
  return nextUrl.searchParams.get("cursor") ?? undefined;
}

export class ConfluenceClient {
  private confluenceBaseUrl: string;
  private authHeader: string;
  private useSession: boolean;
  private maxRetries = 3;
  private baseDelayMs = 1000;
  private tlsOptions: TlsOptions | undefined;
  /**
   * Where a SESSION-mode binary download may be redirected to. Injected into
   * `requestBinary`'s redirect follower rather than hardcoded there, so the
   * allowlist stays one reviewable decision (`@atlcli/core/internal`) shared with
   * `JiraClient` instead of a per-client copy.
   */
  private sessionRedirectPolicy: SessionRedirectPolicy;

  constructor(profile: Profile) {
    this.confluenceBaseUrl = getConfluenceBaseUrl(profile);
    if (profile.auth.type === "oauth") {
      throw new Error("OAuth is not implemented yet. Use API token or bearer auth.");
    }
    // Session auth relies on the ambient browser cookie (credentials: "include");
    // no Authorization header is built or sent. buildAuthHeader is guarded here
    // rather than allowed to throw (spec 001 §3.3).
    this.useSession = profile.auth.type === "session";
    this.authHeader = this.useSession ? "" : buildAuthHeader(profile);
    this.tlsOptions = buildTlsOptions(profile);
    this.sessionRedirectPolicy = createAtlassianSessionRedirectPolicy({
      siteOrigin: this.confluenceBaseUrl,
    });
  }

  /** Get the Confluence instance base URL */
  getInstanceUrl(): string {
    return this.confluenceBaseUrl;
  }

  /**
   * Build an absolute web (browser) URL from a Confluence `_links.webui` path,
   * honoring the instance context path. Returns undefined when no path is given.
   */
  private buildWebUrl(webuiPath: string | undefined): string | undefined {
    if (!webuiPath) return undefined;
    return `${this.confluenceBaseUrl}${webuiPath}`;
  }

  /**
   * Sleep utility for rate limiting / retry backoff.
   *
   * Abortable: when `signal` is provided and already/becomes aborted, the sleep
   * rejects immediately with the signal's reason instead of blocking for the
   * full delay. This is what makes Ctrl-C during a multi-second 429/5xx backoff
   * actually stop (the "Abort is real" requirement, spec 002).
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Finalize a fetch RequestInit: apply session-cookie auth and TLS options.
   *
   * For session profiles this strips any Authorization header and sets
   * `credentials: "include"` so the ambient Atlassian browser session is used.
   * Custom TLS options are merged in when present.
   */
  private applyFetchOptions(init: RequestInit): RequestInit {
    let result: RequestInit = init;
    if (this.useSession) {
      const headers: Record<string, string> = { ...(result.headers as Record<string, string> | undefined) };
      delete headers.Authorization;
      // `redirect: "manual"` (session only): an unauthenticated Atlassian API
      // call answers with a 3xx to `id.atlassian.com`. Manual redirect stops the
      // browser from FOLLOWING that bounce; instead the fetch resolves as an
      // opaque redirect we classify as not-logged-in (spec 003 §2.3). CLI
      // (token) mode keeps the default follow behavior — this branch never runs
      // for it.
      //
      // "Manual" means *we* decide, not "never follow". `request()` (JSON) never
      // follows: an API endpoint has no legitimate redirect. `requestBinary`
      // (attachment bytes) DOES follow, but only to a destination the session
      // redirect policy allows — Cloud delivers attachment content by 302ing to
      // `api.media.atlassian.com`, so refusing every redirect made session-mode
      // downloads unreachable by construction (spec 010 wave 2). The cross-origin
      // hop is re-issued with `credentials: "omit"`, so the ambient session never
      // travels with it.
      result = { ...result, headers, credentials: "include", redirect: "manual" };
    }
    if (this.tlsOptions) {
      result = { ...result, tls: this.tlsOptions } as RequestInit;
    }
    return result;
  }

  /**
   * The one place this package spells the session-expiry message.
   *
   * The wording is load-bearing, not cosmetic: the extension classifies session
   * expiry by matching `authentication redirect` against thrown client errors
   * (`apps/extension/utils/read-path.ts`,
   * `apps/extension/utils/macros/session-ports.ts`). Both the JSON guard below
   * and the binary redirect follower in `requestBinary` build their error here so
   * the two can never drift.
   */
  private authRedirectError(status: number): Error {
    return new Error(
      `Confluence API error (${status}): authentication redirect to Atlassian login (session not logged in)`
    );
  }

  /**
   * Session-mode guard for JSON API calls: a redirect means the ambient
   * Atlassian session is missing/expired (the request is being bounced to the
   * login host). With `redirect: "manual"` this surfaces as an opaque-redirect
   * response (`type === "opaqueredirect"`, `status 0`); some environments expose
   * the raw 3xx instead. Either way we throw an auth-redirect error (mapped to
   * `not-logged-in` by the extension) rather than following it. No-op for
   * CLI/token auth.
   *
   * JSON-only on purpose. An API endpoint has no legitimate reason to bounce
   * anywhere, so "any redirect is a login redirect" holds here. It does NOT hold
   * for attachment bytes, which Cloud delivers *via* a redirect to the media CDN
   * — that path is classified by destination in `requestBinary` instead.
   */
  private assertNotAuthRedirect(res: { type?: string; status: number }): void {
    if (!this.useSession) return;
    const isRedirect =
      res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
    if (isRedirect) {
      // 302 is hardcoded (rather than `res.status`) because an opaque redirect
      // reports status 0, which carries no information; this is the value the
      // downstream `(\d{3})` classifiers have always seen here.
      throw this.authRedirectError(302);
    }
  }

  /**
   * Session-mode guard for a 2xx response body. Atlassian answers some
   * unauthenticated/again-denied API calls with HTTP 200 whose body is NOT a
   * real page — either an HTML login page (non-JSON), or a JSON error envelope
   * carrying its own `statusCode`. Both must become errors, not silently-empty
   * pages (spec 003 §2.3, PLAN login-detection note). No-op for CLI/token auth.
   */
  private assertSessionJsonOk(text: string, data: unknown, isJson: boolean): void {
    if (!this.useSession) return;
    // Empty body (e.g. 200/204 from DELETE) is legitimate — only guard content.
    if (text && !isJson) {
      throw new Error(
        "Confluence API error (login): non-JSON 200 response (login page — session not logged in)"
      );
    }
    if (isJson && data && typeof data === "object") {
      const statusCode = (data as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === "number" && statusCode >= 400) {
        const message = (data as { message?: unknown }).message;
        throw new Error(
          `Confluence API error (${statusCode}): ${typeof message === "string" ? message : "error response body"}`
        );
      }
    }
  }

  private async request(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      signal?: AbortSignal;
      /**
       * Response-body logging policy (spec 004). Default (`undefined`/`true`)
       * keeps the existing full-body logging for all current callers. The
       * export_view/macro-body methods pass `"meta-only"` (or `false`) so full
       * page/macro CONTENT — potentially confidential and NOT redactable by
       * key-based `redactSensitive` — never lands in the JSONL logs; only
       * `{ byteLength, contentType, requestId }` is logged, in both the success
       * and error paths.
       */
      logBody?: false | "meta-only" | true;
    } = {}
  ): Promise<unknown> {
    const url = new URL(`${this.confluenceBaseUrl}/rest/api${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const logger = getLogger();
    const requestId = generateRequestId();
    const method = options.method ?? "GET";
    const startTime = Date.now();
    // spec 004: keep full page/macro content out of the JSONL logs when a caller
    // opts out (`redactSensitive` only strips token-shaped KEYS, not arbitrary
    // page text). Default behavior for every existing caller is unchanged.
    const suppressBody = options.logBody === false || options.logBody === "meta-only";
    const bodyMeta = (text: string, res: Response) => ({
      byteLength: text.length,
      contentType: res.headers.get("content-type") ?? undefined,
      requestId,
    });

    // Log request
    logger.api("request", {
      requestId,
      method,
      url: url.toString(),
      path,
      headers: redactSensitive({
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
      body: suppressBody
        ? options.body
          ? "[request body omitted: logBody policy]"
          : undefined
        : options.body
          ? redactSensitive(options.body)
          : undefined,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      const res = await fetch(url.toString(), this.applyFetchOptions({
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      }));

      // Session auth: a redirect means the session is missing — classify it
      // rather than follow it to a foreign origin with cookies.
      this.assertNotAuthRedirect(res);

      // Handle rate limiting (429)
      if (res.status === 429) {
        const delayMs =
          parseRetryAfterMs(res.headers.get("Retry-After")) ??
          this.baseDelayMs * Math.pow(2, attempt);

        if (attempt < this.maxRetries) {
          await this.sleep(delayMs, options.signal);
          continue;
        }
        const error = new Error(`Rate limited by Confluence API after ${this.maxRetries} retries`);
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: "Too Many Requests",
          durationMs: Date.now() - startTime,
          error: error.message,
        });
        throw error;
      }

      const text = await res.text();
      let data: unknown = text;
      let isJson = false;
      if (text) {
        try {
          data = JSON.parse(text);
          isJson = true;
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        // Under a logBody policy, keep the raw response text OUT of the thrown
        // message too (it embeds full response bodies) — surface only status.
        const message = suppressBody
          ? `[response body omitted: logBody policy]`
          : typeof data === "string"
            ? data
            : JSON.stringify(data);
        lastError = new Error(`Confluence API error (${res.status}): ${message}`);

        // Retry on server errors (5xx)
        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt), options.signal);
          continue;
        }
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: res.statusText,
          body: suppressBody ? bodyMeta(text, res) : redactSensitive(data),
          durationMs: Date.now() - startTime,
          error: lastError.message,
        });
        throw lastError;
      }

      // Session auth: reject a 2xx that is a login page / error envelope, not a
      // real API payload (spec 003 §2.3). No-op for CLI/token auth.
      this.assertSessionJsonOk(text, data, isJson);

      // Log successful response
      logger.api("response", {
        requestId,
        status: res.status,
        statusText: res.statusText,
        body: suppressBody ? bodyMeta(text, res) : redactSensitive(data),
        durationMs: Date.now() - startTime,
      });

      return data;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  /**
   * Request helper for v2 API endpoints.
   * v2 API uses /api/v2 below the resolved Confluence base.
   */
  private async requestV2(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      signal?: AbortSignal;
    } = {}
  ): Promise<unknown> {
    const url = new URL(`${this.confluenceBaseUrl}/api/v2${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const logger = getLogger();
    const requestId = generateRequestId();
    const method = options.method ?? "GET";
    const startTime = Date.now();

    // Log request
    logger.api("request", {
      requestId,
      method,
      url: url.toString(),
      path,
      headers: redactSensitive({
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
      body: options.body ? redactSensitive(options.body) : undefined,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      const res = await fetch(url.toString(), this.applyFetchOptions({
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      }));

      // Session auth: classify an auth-redirect rather than follow it.
      this.assertNotAuthRedirect(res);

      if (res.status === 429) {
        const delayMs =
          parseRetryAfterMs(res.headers.get("Retry-After")) ??
          this.baseDelayMs * Math.pow(2, attempt);

        if (attempt < this.maxRetries) {
          await this.sleep(delayMs, options.signal);
          continue;
        }
        const error = new Error(`Rate limited by Confluence API after ${this.maxRetries} retries`);
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: "Too Many Requests",
          durationMs: Date.now() - startTime,
          error: error.message,
        });
        throw error;
      }

      const text = await res.text();
      let data: unknown = text;
      let isJson = false;
      if (text) {
        try {
          data = JSON.parse(text);
          isJson = true;
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        const message = typeof data === "string" ? data : JSON.stringify(data);
        lastError = new Error(`Confluence API v2 error (${res.status}): ${message}`);

        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt), options.signal);
          continue;
        }
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: res.statusText,
          body: redactSensitive(data),
          durationMs: Date.now() - startTime,
          error: lastError.message,
        });
        throw lastError;
      }

      // Session auth: reject a 2xx login page / error envelope (spec 003 §2.3).
      this.assertSessionJsonOk(text, data, isJson);

      // Log successful response
      logger.api("response", {
        requestId,
        status: res.status,
        statusText: res.statusText,
        body: redactSensitive(data),
        durationMs: Date.now() - startTime,
      });

      return data;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  /**
   * Get the current authenticated user.
   * Useful for verifying authentication and connectivity.
   */
  async getCurrentUser(): Promise<{ accountId: string; displayName: string; email?: string }> {
    const data = (await this.request("/user/current")) as any;
    return {
      accountId: data.accountId,
      displayName: data.displayName,
      email: data.email,
    };
  }

  async getPage(id: string): Promise<ConfluencePage & { storage: string }> {
    const data = (await this.request(`/content/${id}`, {
      query: { expand: "body.storage,version,space,ancestors" },
    })) as any;

    // Extract ancestors (array of {id, title} from root to parent)
    const ancestors = Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];

    // Parent is the last ancestor
    const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null;

    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
      parentId,
      ancestors,
      storage: data.body?.storage?.value ?? "",
    };
  }

  /**
   * Fetch a single macro's server-side-rendered body via the v1 macro-body API
   * (spec 004, T1.10). Confluence renders the macro (including third-party apps
   * that declare an ADF export function) to HTML in the `export_view`
   * representation. Response content is not logged verbatim (`logBody`).
   *
   * @returns the rendered HTML, or `undefined` when the macro id is unknown.
   */
  async getMacroBodyByMacroId(
    pageId: string,
    version: number,
    macroId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<string | undefined> {
    const data = (await this.request(
      `/content/${pageId}/history/${version}/macro/id/${encodeURIComponent(macroId)}`,
      {
        query: { expand: "body" },
        logBody: "meta-only",
        signal: options.signal,
      }
    )) as any;
    // The v1 macro endpoint returns the macro's stored body; to obtain its
    // export_view HTML we round-trip it through convertToExportView.
    const body: string | undefined = data?.body ?? data?.value;
    if (typeof body !== "string" || body === "") return undefined;
    return this.convertToExportView(body, options);
  }

  /**
   * Convert a storage-format fragment to the `export_view` representation
   * (server-side rendered HTML) via the contentbody convert endpoint (spec 004,
   * T1.10). Response content is not logged verbatim (`logBody`).
   */
  async convertToExportView(
    storageFragment: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<string | undefined> {
    const data = (await this.request(`/contentbody/convert/export_view`, {
      method: "POST",
      body: { value: storageFragment, representation: "storage" },
      logBody: "meta-only",
      signal: options.signal,
    })) as any;
    const html: unknown = data?.value;
    return typeof html === "string" && html !== "" ? html : undefined;
  }

  /**
   * Batch path (spec 004, T1.10): fetch the WHOLE page's `export_view` body
   * once and return a `data-macro-id` → rendered-HTML map, so N macros on a page
   * cost ONE request instead of N (rate-limit protection). Response content is
   * not logged verbatim (`logBody`).
   */
  async getExportViewMacros(
    pageId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<Map<string, string>> {
    const data = (await this.request(`/content/${pageId}`, {
      query: { expand: "body.export_view,version" },
      logBody: "meta-only",
      signal: options.signal,
    })) as any;
    const html: string = data?.body?.export_view?.value ?? "";
    return extractMacroFragments(html);
  }

  /**
   * Get a page with metadata (history, labels, tiny URL, editor version).
   * Used for export workflows that need author/created/labels.
   */
  async getPageDetails(
    id: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<ConfluencePageDetails> {
    const data = (await this.request(`/content/${id}`, {
      query: {
        expand: [
          "body.storage",
          "version",
          "space",
          "ancestors",
          "history.lastUpdated",
          "history.createdBy",
          "history.createdDate",
          "metadata.labels",
          "metadata.properties.editor",
        ].join(","),
      },
      signal: options.signal,
    })) as any;

    // Extract ancestors (array of {id, title} from root to parent)
    const ancestors = Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];

    // Parent is the last ancestor
    const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null;

    // Extract labels from metadata
    const labels: string[] = [];
    if (data.metadata?.labels?.results) {
      for (const label of data.metadata.labels.results) {
        labels.push(label.name);
      }
    }

    // Extract editor version from metadata properties
    const editorProp = data.metadata?.properties?.editor?.value;
    const editorVersion: "v2" | "v1" | null =
      editorProp === "v2" ? "v2" : editorProp === "v1" ? "v1" : null;

    const parseUser = (user: any): ConfluenceUser | undefined => {
      if (!user) return undefined;
      return {
        accountId: user.accountId,
        displayName: user.displayName ?? user.publicName ?? "",
        email: user.email,
      };
    };

    const createdBy = parseUser(data.history?.createdBy);
    const modifiedBy = parseUser(data.history?.lastUpdated?.by ?? data.version?.by);
    const created = data.history?.createdDate;
    const modified = data.history?.lastUpdated?.when ?? data.version?.when;

    const base = data._links?.base;
    const webui = data._links?.webui;
    const tinyui = data._links?.tinyui;

    return {
      id: data.id,
      title: data.title,
      url: base && webui ? `${base}${webui}` : undefined,
      tinyUrl: base && tinyui ? `${base}${tinyui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
      parentId,
      ancestors,
      storage: data.body?.storage?.value ?? "",
      created,
      createdBy,
      modified,
      modifiedBy,
      labels,
      editorVersion,
    };
  }

  /**
   * Get ancestors for a page (from root to parent).
   */
  async getAncestors(pageId: string): Promise<{ id: string; title: string }[]> {
    const data = (await this.request(`/content/${pageId}`, {
      query: { expand: "ancestors" },
    })) as any;

    return Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];
  }

  /**
   * Search Confluence content using CQL.
   *
   * GET /content/search
   *
   * @param cql - Confluence Query Language query string
   * @param options - Search options
   * @returns Search results with pagination info
   */
  async search(
    cql: string,
    options: {
      limit?: number;
      start?: number;
      excerpt?: boolean;
      /** Optimization: "minimal" only fetches id/title/space, "standard" adds version/dates/labels, "full" adds excerpt */
      detail?: "minimal" | "standard" | "full";
      signal?: AbortSignal;
    } = {}
  ): Promise<SearchResults> {
    const { limit = 25, start = 0, detail = "standard" } = options;
    const excerpt = options.excerpt ?? (detail === "full");

    // Build expand parameter based on detail level
    const expandParts: string[] = [];

    // Minimal: just space (for spaceKey)
    if (detail !== "minimal") {
      expandParts.push("version", "space");
    } else {
      expandParts.push("space");
    }

    // Standard: add history and labels
    if (detail === "standard" || detail === "full") {
      expandParts.push("history.lastUpdated", "history.createdBy", "history.createdDate", "metadata.labels");
    }

    const data = (await this.request("/content/search", {
      query: {
        cql,
        limit,
        start,
        expand: expandParts.join(","),
        excerpt: excerpt ? "indexed" : undefined,
      },
      signal: options.signal,
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    const nextLink = data._links?.next;

    return {
      results: results.map((item: any) => this.parseSearchResult(item)),
      start: data.start ?? start,
      limit: data.limit ?? limit,
      size: data.size ?? results.length,
      totalSize: data.totalSize,
      hasMore: !!nextLink || (data.start ?? 0) + (data.size ?? results.length) < (data.totalSize ?? 0),
      nextLink,
    };
  }

  /**
   * Search pages with automatic pagination.
   *
   * Paginates through all results using cursor-based pagination via _links.next.
   * Note: The start parameter is deprecated and ignored by Confluence Cloud.
   */
  async searchPages(
    cql: string,
    limit = 25,
    options: { signal?: AbortSignal } = {}
  ): Promise<ConfluenceSearchResult[]> {
    // Cursor pagination ends only on the ABSENCE of a next link — a short (or
    // even empty) page carrying a live `_links.next` is not the last page (see
    // drainPaginated). A silent early break here dropped later results, which
    // for label-filter lookups means an exclude match on a dropped page could
    // ship in the export uncaught (privacy/completeness bug).
    return drainPaginated<ConfluenceSearchResult>(async (token) => {
      const result =
        token === undefined
          ? await this.search(cql, { limit, signal: options.signal })
          : await this.searchByUrl(token, options.signal);
      return { items: result.results, next: result.nextLink };
    });
  }

  /**
   * Look up pages by EXACT title through the DIRECT content endpoint
   * (`GET /content?type=page&title=…[&spaceKey=…]`), NOT the CQL search index.
   *
   * Why direct, not `search`/CQL: Confluence Cloud's search index lags page
   * creation by up to minutes, so a freshly created target (e.g. a CI pipeline
   * that creates a page then immediately exports a template that includes it by
   * title) comes back "not found" on the first try and only resolves on a later
   * retry. The `/content` endpoint reads the content store directly, so a page
   * is findable the moment it exists — the same reason spec 004's children macro
   * moved off CQL to the direct child-page endpoint (spec 005 D1).
   *
   * Titles are NOT unique (same title across spaces, or a bare-title lookup), so
   * this returns EVERY match; the caller sorts by id for deterministic
   * ambiguity handling. Paginated through the shared {@link drainPaginated}
   * driver (a title with many matches never silently truncates).
   */
  async findPagesByTitle(
    title: string,
    options: { spaceKey?: string; limit?: number; signal?: AbortSignal } = {}
  ): Promise<Array<{ id: string; title: string; spaceKey?: string }>> {
    const { spaceKey, limit = 25, signal } = options;
    const query: Record<string, string | number | undefined> = {
      type: "page",
      title,
      expand: "space",
      limit,
      ...(spaceKey ? { spaceKey } : {}),
    };
    return drainPaginated<{ id: string; title: string; spaceKey?: string }>(async (token) => {
      // First page uses the structured query; subsequent pages follow the
      // server's own `_links.next` path (its query already baked in), stripping
      // the /rest/api prefix request() re-adds — same shape as searchByUrl.
      const data = (token === undefined
        ? await this.request("/content", { query, signal })
        : await this.request(token.replace(/^\/rest\/api/, ""), { signal })) as any;
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        items: results.map((item: any) => ({
          id: item.id,
          title: item.title,
          spaceKey: item.space?.key,
        })),
        next: data._links?.next,
      };
    });
  }

  /**
   * Follow a pagination URL to get the next page of search results.
   * Strips the /rest/api prefix from the URL since request() adds it.
   */
  private async searchByUrl(url: string, signal?: AbortSignal): Promise<SearchResults> {
    // Strip /rest/api prefix since request() adds it
    const path = url.replace(/^\/rest\/api/, "");
    const data = (await this.request(path, { signal })) as any;
    const results = Array.isArray(data.results) ? data.results : [];
    const nextLink = data._links?.next;

    return {
      results: results.map((item: any) => this.parseSearchResult(item)),
      start: data.start ?? 0,
      limit: data.limit ?? results.length,
      size: data.size ?? results.length,
      totalSize: data.totalSize,
      hasMore: !!nextLink,
      nextLink,
    };
  }

  /**
   * Parse search result from API response.
   */
  private parseSearchResult(item: any): ConfluenceSearchResult {
    // Extract labels from metadata
    const labels: string[] = [];
    if (item.metadata?.labels?.results) {
      for (const label of item.metadata.labels.results) {
        labels.push(label.name);
      }
    }

    return {
      id: item.id,
      title: item.title,
      url: item._links?.base ? `${item._links.base}${item._links.webui}` : undefined,
      spaceKey: item.space?.key,
      spaceName: item.space?.name,
      version: item.version?.number,
      lastModified: item.history?.lastUpdated?.when,
      excerpt: item.excerpt,
      type: item.type,
      labels,
      creator: item.history?.createdBy?.displayName,
      created: item.history?.createdDate,
    };
  }

  async createPage(params: {
    spaceKey: string;
    title: string;
    storage: string;
    parentId?: string;
  }): Promise<ConfluencePage> {
    const body: any = {
      type: "page",
      title: params.title,
      space: { key: params.spaceKey },
      body: {
        storage: {
          value: params.storage,
          representation: "storage",
        },
      },
    };

    // Add parent if specified
    if (params.parentId) {
      body.ancestors = [{ id: params.parentId }];
    }

    const data = (await this.request("/content", {
      method: "POST",
      body,
    })) as any;

    // Extract ancestors from response
    const ancestors = Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];
    const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null;

    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
      parentId,
      ancestors,
    };
  }

  async updatePage(params: {
    id: string;
    title: string;
    storage: string;
    version: number;
  }): Promise<ConfluencePage> {
    const data = (await this.request(`/content/${params.id}`, {
      method: "PUT",
      body: {
        id: params.id,
        type: "page",
        title: params.title,
        version: { number: params.version },
        body: {
          storage: {
            value: params.storage,
            representation: "storage",
          },
        },
      },
    })) as any;
    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
    };
  }

  /**
   * Move a page to a new parent.
   *
   * PUT /content/{id} with new ancestors array
   */
  async movePage(pageId: string, newParentId: string): Promise<ConfluencePage> {
    // Get current page to preserve title and get version
    const current = await this.getPage(pageId);

    const data = (await this.request(`/content/${pageId}`, {
      method: "PUT",
      body: {
        id: pageId,
        type: "page",
        title: current.title,
        version: { number: (current.version ?? 1) + 1 },
        ancestors: [{ id: newParentId }],
      },
    })) as any;

    // Parse response like updatePage
    const ancestors = Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];
    const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null;

    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
      parentId,
      ancestors,
    };
  }

  /**
   * Move page to position relative to a sibling or parent.
   *
   * PUT /content/{id}/move/{position}/{targetId}
   *
   * @param position - "before" | "after" (sibling) or "append" (child of target)
   */
  async movePageToPosition(
    pageId: string,
    position: "before" | "after" | "append",
    targetId: string
  ): Promise<ConfluencePage> {
    // The move endpoint returns a minimal response, so we call it then fetch the page
    await this.request(
      `/content/${pageId}/move/${position}/${targetId}`,
      { method: "PUT" }
    );

    // Fetch the updated page to get full details
    return this.getPage(pageId);
  }

  /**
   * Get direct child pages with position information for ordering.
   *
   * Uses cursor-based pagination via _links.next (start parameter is deprecated).
   * GET /content/{id}/child/page?expand=extensions.position,version
   */
  async getChildrenWithPosition(
    parentId: string,
    options: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<Array<ConfluencePage & { position: number | null }>> {
    const { limit = 100 } = options;

    // Pagination ends only on the absence of `_links.next`; a short page that
    // still carries a next link is NOT the last page (see drainPaginated). The
    // previous `results.length < limit` early break silently truncated trees.
    const results = await drainPaginated<ConfluencePage & { position: number | null }>(
      async (token) => {
        const data: any =
          token === undefined
            ? await this.request(
                `/content/${parentId}/child/page?expand=extensions.position,version,ancestors&limit=${limit}`,
                { signal: options.signal }
              )
            : await this.request(token.replace(/^\/rest\/api/, ""), { signal: options.signal });

        const items = (Array.isArray(data.results) ? data.results : []).map((item: any) => {
          const ancestors = Array.isArray(item.ancestors)
            ? item.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
            : [];
          return {
            id: item.id,
            title: item.title,
            url: item._links?.base ? `${item._links.base}${item._links.webui}` : undefined,
            version: item.version?.number,
            spaceKey: item.space?.key,
            parentId,
            ancestors,
            position: item.extensions?.position ?? null,
          };
        });
        return { items, next: data._links?.next };
      }
    );

    // Sort by position (nulls go to end, then alphabetical fallback)
    return results.sort((a, b) => {
      if (a.position !== null && b.position !== null) {
        return a.position - b.position;
      }
      if (a.position !== null) return -1;
      if (b.position !== null) return 1;
      return a.title.localeCompare(b.title);
    });
  }

  /**
   * Copy/duplicate a page.
   *
   * Fetches source page and creates a new page with same content.
   */
  async copyPage(params: {
    sourceId: string;
    targetSpaceKey?: string;
    newTitle?: string;
    parentId?: string;
  }): Promise<ConfluencePage> {
    // Fetch source page with full content
    const source = await this.getPage(params.sourceId);

    // Create new page with same content
    return this.createPage({
      spaceKey: params.targetSpaceKey ?? source.spaceKey!,
      title: params.newTitle ?? `Copy of ${source.title}`,
      storage: source.storage!,
      parentId: params.parentId ?? source.parentId ?? undefined,
    });
  }

  /**
   * Get direct child pages of a parent page.
   *
   * Uses CQL parent= for direct children only (not recursive).
   */
  async getChildren(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<ConfluenceSearchResult[]> {
    const { limit = 100 } = options;
    const cql = `parent=${pageId} AND type=page`;
    return this.searchPages(cql, limit);
  }

  /**
   * Get all direct children of a page (including folders, whiteboards, etc.).
   *
   * GET /api/v2/pages/{id}/direct-children
   *
   * Unlike getChildren(), this returns ALL content types, not just pages.
   * Useful for detecting folders nested under pages.
   */
  async getPageDirectChildren(
    pageId: string,
    options: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<FolderChild[]> {
    const { limit = 100 } = options;

    // Cursor pagination ends only on the absence of a next cursor; a short page
    // carrying a live next link is NOT the last page (see drainPaginated).
    return drainPaginated<FolderChild>(async (cursor) => {
      const query: Record<string, string | number | undefined> = { limit };
      if (cursor) query.cursor = cursor;

      const data = (await this.requestV2(`/pages/${pageId}/direct-children`, {
        query,
        signal: options.signal,
      })) as any;

      const results = Array.isArray(data.results) ? data.results : [];
      const items: FolderChild[] = results.map((item: any) => ({
        id: item.id,
        title: item.title,
        // Preserve the raw type (open union): whiteboards/databases/embeds must
        // NOT be widened into "page" — the caller maps them to "unsupported".
        type: item.type,
        spaceId: item.spaceId,
        parentId: pageId,
        url: this.buildWebUrl(item._links?.webui),
      }));

      return { items, next: extractCursor(data._links?.next, this.confluenceBaseUrl) };
    });
  }

  /**
   * Delete a page.
   *
   * DELETE /content/{id}
   */
  async deletePage(pageId: string): Promise<void> {
    await this.request(`/content/${pageId}`, {
      method: "DELETE",
    });
  }

  /**
   * Archive a page (set status to archived).
   *
   * PUT /content/{id} with status: "archived"
   */
  async archivePage(pageId: string): Promise<ConfluencePage> {
    // Get current page to preserve title and get version
    const current = await this.getPage(pageId);

    const data = (await this.request(`/content/${pageId}`, {
      method: "PUT",
      body: {
        id: pageId,
        type: "page",
        title: current.title,
        version: { number: (current.version ?? 1) + 1 },
        status: "archived",
      },
    })) as any;

    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
    };
  }

  /**
   * Execute a bulk operation on multiple pages with concurrency control.
   *
   * @param pageIds - List of page IDs to operate on
   * @param operation - Function to execute for each page
   * @param options - Options including concurrency limit and progress callback
   * @returns Summary of results including successes and failures
   */
  async bulkOperation<T>(
    pageIds: string[],
    operation: (pageId: string) => Promise<T>,
    options: {
      concurrency?: number;
      onProgress?: (done: number, total: number) => void;
    } = {}
  ): Promise<BulkOperationResult> {
    const { concurrency = 5, onProgress } = options;
    const result: BulkOperationResult = {
      total: pageIds.length,
      successful: 0,
      failed: 0,
      errors: [],
    };

    let completed = 0;

    for (let i = 0; i < pageIds.length; i += concurrency) {
      const chunk = pageIds.slice(i, i + concurrency);
      const promises = chunk.map(async (pageId) => {
        try {
          await operation(pageId);
          result.successful++;
        } catch (err) {
          result.failed++;
          result.errors.push({
            pageId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          completed++;
          onProgress?.(completed, pageIds.length);
        }
      });

      await Promise.all(promises);
    }

    return result;
  }

  // ============ Space Operations ============

  /**
   * Create a new Confluence space.
   */
  async createSpace(params: {
    key: string;
    name: string;
    description?: string;
  }): Promise<ConfluenceSpace> {
    const data = (await this.request("/space", {
      method: "POST",
      body: {
        key: params.key,
        name: params.name,
        description: params.description
          ? {
              plain: {
                value: params.description,
                representation: "plain",
              },
            }
          : undefined,
      },
    })) as any;
    return {
      id: data.id,
      key: data.key,
      name: data.name,
      type: data.type ?? "global",
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
    };
  }

  /**
   * List all spaces.
   */
  async listSpaces(limit = 25): Promise<ConfluenceSpace[]> {
    const data = (await this.request("/space", {
      query: { limit },
    })) as any;
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      id: item.id,
      key: item.key,
      name: item.name,
      type: item.type ?? "global",
      url: item._links?.base ? `${item._links.base}${item._links.webui}` : undefined,
    }));
  }

  /**
   * Get a space by key.
   */
  async getSpace(key: string): Promise<ConfluenceSpace> {
    const data = (await this.request(`/space/${key}`, {})) as any;
    return {
      id: data.id,
      key: data.key,
      name: data.name,
      type: data.type ?? "global",
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
    };
  }

  /**
   * Get a space's logo icon (spec 005: drives `$scroll.spacelogo` /
   * `$scroll.globallogo` embedding). Returns `null` when the space carries no
   * icon — Cloud normally always has one (the default is an SVG).
   */
  async getSpaceIcon(key: string): Promise<SpaceIcon | null> {
    return (await this.getSpaceWithIcon(key)).icon;
  }

  /**
   * Get a space AND its logo icon in one round-trip
   * (`GET /space/{key}?expand=icon`). Perf: an export whose template uses
   * both `$scroll.space.*` and a logo placeholder previously paid two calls
   * to the same endpoint; hosts memoize this one instead.
   */
  async getSpaceWithIcon(key: string): Promise<{ space: ConfluenceSpace; icon: SpaceIcon | null }> {
    const data = (await this.request(`/space/${key}`, {
      query: { expand: "icon" },
    })) as any;
    const space: ConfluenceSpace = {
      id: data.id,
      key: data.key,
      name: data.name,
      type: data.type ?? "global",
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
    };
    const icon = data.icon?.path
      ? {
          path: data.icon.path,
          width: data.icon.width,
          height: data.icon.height,
          isDefault: data.icon.isDefault,
        }
      : null;
    return { space, icon };
  }

  /**
   * Get page version info only (lightweight check for polling).
   */
  async getPageVersion(
    id: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<PageChangeInfo> {
    const data = (await this.request(`/content/${id}`, {
      query: { expand: "version,space,history.lastUpdated" },
      signal: options.signal,
    })) as any;
    return {
      id: data.id,
      title: data.title,
      version: data.version?.number ?? 1,
      lastModified: data.history?.lastUpdated?.when,
      spaceKey: data.space?.key,
    };
  }

  /**
   * Get pages modified since a given date using CQL.
   * Used for efficient polling of spaces or page trees.
   *
   * Uses cursor-based pagination via _links.next (start parameter is deprecated).
   */
  async getPagesSince(params: {
    scope: SyncScope;
    since: string; // ISO date string
    limit?: number;
  }): Promise<PageChangeInfo[]> {
    const { scope, since, limit = 100 } = params;

    // Single page: direct fetch
    if (scope.type === "page") {
      const pageInfo = await this.getPageVersion(scope.pageId);
      return [pageInfo];
    }

    // Format date for CQL (YYYY-MM-DD)
    const dateStr = since.split("T")[0];

    // Build CQL for tree or space scope
    let cql: string;
    switch (scope.type) {
      case "tree":
        cql = `ancestor=${scope.ancestorId} AND type=page AND lastModified >= "${dateStr}"`;
        break;
      case "space":
        cql = `space="${scope.spaceKey}" AND type=page AND lastModified >= "${dateStr}"`;
        break;
    }

    // Use cursor-based pagination
    return this.searchPagesAsChangeInfo(cql, limit);
  }

  /**
   * Get all pages in a scope (initial sync).
   *
   * For space scope: uses v2 API with reliable cursor-based pagination.
   * For tree scope: uses cursor-based CQL search via _links.next.
   */
  async getAllPages(params: {
    scope: SyncScope;
    limit?: number;
  }): Promise<PageChangeInfo[]> {
    const { scope, limit = 100 } = params;

    // Single page: direct fetch
    if (scope.type === "page") {
      const pageInfo = await this.getPageVersion(scope.pageId);
      return [pageInfo];
    }

    // Space scope: use v2 API for reliable pagination
    if (scope.type === "space") {
      return this.getAllPagesInSpaceV2(scope.spaceKey, limit);
    }

    // Tree scope: use cursor-based CQL search
    const cql = `ancestor=${scope.ancestorId} AND type=page`;
    return this.searchPagesAsChangeInfo(cql, limit);
  }

  /**
   * Get all pages in a space using v2 API with cursor-based pagination.
   */
  private async getAllPagesInSpaceV2(
    spaceKey: string,
    limit: number
  ): Promise<PageChangeInfo[]> {
    const space = await this.getSpace(spaceKey);
    const allResults: PageChangeInfo[] = [];
    let cursor: string | undefined;

    while (true) {
      const query: Record<string, string | number | undefined> = { limit };
      if (cursor) query.cursor = cursor;

      const data = (await this.requestV2(`/spaces/${space.id}/pages`, { query })) as any;
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) break;

      for (const item of results) {
        allResults.push({
          id: item.id,
          title: item.title,
          version: item.version?.number ?? 1,
          lastModified: item.version?.createdAt,
          spaceKey,
        });
      }

      if (data._links?.next) {
        const nextUrl = new URL(data._links.next, this.confluenceBaseUrl);
        cursor = nextUrl.searchParams.get("cursor") ?? undefined;
      } else {
        break;
      }

      if (results.length < limit) break;
    }

    return allResults;
  }

  /**
   * Search pages using CQL with cursor-based pagination, returning PageChangeInfo.
   * Uses _links.next for pagination since 'start' parameter is deprecated.
   */
  private async searchPagesAsChangeInfo(
    cql: string,
    limit: number
  ): Promise<PageChangeInfo[]> {
    const allResults: PageChangeInfo[] = [];
    let nextLink: string | undefined;
    let isFirstRequest = true;

    while (true) {
      let data: any;

      if (isFirstRequest) {
        data = await this.request("/content/search", {
          query: { cql, limit, expand: "version,space,history.lastUpdated" },
        });
        isFirstRequest = false;
      } else if (nextLink) {
        // Strip /rest/api prefix since request() adds it
        const path = nextLink.replace(/^\/rest\/api/, "");
        data = await this.request(path);
      } else {
        break;
      }

      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) break;

      for (const item of results) {
        allResults.push({
          id: item.id,
          title: item.title,
          version: item.version?.number ?? 1,
          lastModified: item.history?.lastUpdated?.when,
          spaceKey: item.space?.key,
        });
      }

      nextLink = data._links?.next;
      if (!nextLink || results.length < limit) break;
    }

    return allResults;
  }

  /**
   * Fetch multiple pages in parallel with concurrency limit.
   */
  async getPagesBatch(
    ids: string[],
    concurrency = 5
  ): Promise<(ConfluencePage & { storage: string })[]> {
    const results: (ConfluencePage & { storage: string })[] = [];

    for (let i = 0; i < ids.length; i += concurrency) {
      const chunk = ids.slice(i, i + concurrency);
      const pages = await Promise.all(chunk.map((id) => this.getPage(id)));
      results.push(...pages);
    }

    return results;
  }

  // ============ Attachment Operations ============

  /**
   * List attachments for a page.
   *
   * GET /content/{id}/child/attachment
   */
  async listAttachments(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<AttachmentInfo[]> {
    const data = (await this.request(`/content/${pageId}/child/attachment`, {
      query: {
        expand: "version,metadata.mediaType",
        limit: options.limit ?? 100,
      },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => this.parseAttachmentResponse(item, pageId));
  }

  /**
   * Get a single attachment by ID.
   *
   * GET /content/{attachmentId}
   */
  async getAttachment(attachmentId: string): Promise<AttachmentInfo> {
    const data = (await this.request(`/content/${attachmentId}`, {
      query: { expand: "version,container,metadata.mediaType" },
    })) as any;

    return this.parseAttachmentResponse(data, data.container?.id ?? "");
  }

  /**
   * Upload a new attachment to a page.
   *
   * POST /content/{id}/child/attachment
   * Requires multipart/form-data with X-Atlassian-Token: nocheck header.
   */
  async uploadAttachment(params: {
    pageId: string;
    filename: string;
    data: Uint8Array;
    mimeType?: string;
    comment?: string;
  }): Promise<AttachmentInfo> {
    const { pageId, filename, data, mimeType, comment } = params;

    const formData = new FormData();
    const fileData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as unknown as BlobPart;
    const file = new File([fileData], filename, {
      type: mimeType ?? this.detectMimeType(filename),
    });
    formData.append("file", file);

    if (comment) {
      formData.append("comment", comment);
    }

    const result = await this.requestMultipart(
      `/content/${pageId}/child/attachment`,
      formData
    );

    return this.parseAttachmentResponse(result, pageId);
  }

  /**
   * Update an existing attachment with new data.
   *
   * POST /content/{pageId}/child/attachment/{attachmentId}/data
   */
  async updateAttachment(params: {
    attachmentId: string;
    pageId: string;
    filename?: string;
    data: Uint8Array;
    mimeType?: string;
    comment?: string;
  }): Promise<AttachmentInfo> {
    const { attachmentId, pageId, filename, data, mimeType, comment } = params;

    const formData = new FormData();
    const detectedMimeType = filename
      ? this.detectMimeType(filename)
      : "application/octet-stream";
    const fileData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as unknown as BlobPart;
    const file = new File([fileData], filename ?? "file", {
      type: mimeType ?? detectedMimeType,
    });
    formData.append("file", file);

    if (comment) {
      formData.append("comment", comment);
    }

    const result = await this.requestMultipart(
      `/content/${pageId}/child/attachment/${attachmentId}/data`,
      formData
    );

    return this.parseAttachmentResponse(result, pageId);
  }

  /**
   * Delete an attachment.
   *
   * DELETE /content/{attachmentId}
   */
  async deleteAttachment(attachmentId: string): Promise<void> {
    await this.request(`/content/${attachmentId}`, {
      method: "DELETE",
    });
  }

  /**
   * Download attachment binary data.
   *
   * GET {downloadUrl} (relative to wiki base)
   */
  async downloadAttachment(
    attachment: AttachmentInfo | { downloadUrl: string },
    options: { signal?: AbortSignal } = {}
  ): Promise<Uint8Array> {
    return this.requestBinary(attachment.downloadUrl, { signal: options.signal });
  }

  /**
   * Request helper for multipart form data uploads.
   */
  private async requestMultipart(
    path: string,
    formData: FormData
  ): Promise<any> {
    const url = new URL(`${this.confluenceBaseUrl}/rest/api${path}`);

    const logger = getLogger();
    const requestId = generateRequestId();
    const startTime = Date.now();

    // Log request (don't log formData body as it may be binary/large)
    logger.api("request", {
      requestId,
      method: "POST",
      url: url.toString(),
      path,
      headers: redactSensitive({
        Authorization: this.authHeader,
        Accept: "application/json",
        "X-Atlassian-Token": "nocheck",
      }),
      body: "[multipart/form-data]",
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url.toString(), this.applyFetchOptions({
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "X-Atlassian-Token": "nocheck",
          // Note: Do NOT set Content-Type - fetch will set it with boundary
        },
        body: formData,
      }));

      if (res.status === 429) {
        const delayMs =
          parseRetryAfterMs(res.headers.get("Retry-After")) ??
          this.baseDelayMs * Math.pow(2, attempt);

        if (attempt < this.maxRetries) {
          await this.sleep(delayMs);
          continue;
        }
        const error = new Error(`Rate limited after ${this.maxRetries} retries`);
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: "Too Many Requests",
          durationMs: Date.now() - startTime,
          error: error.message,
        });
        throw error;
      }

      const text = await res.text();
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        const message = typeof data === "string" ? data : JSON.stringify(data);
        lastError = new Error(`Attachment upload error (${res.status}): ${message}`);

        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: res.statusText,
          body: redactSensitive(data),
          durationMs: Date.now() - startTime,
          error: lastError.message,
        });
        throw lastError;
      }

      // Log successful response
      logger.api("response", {
        requestId,
        status: res.status,
        statusText: res.statusText,
        body: redactSensitive(data),
        durationMs: Date.now() - startTime,
      });

      return data;
    }

    throw lastError ?? new Error("Upload failed after retries");
  }

  /**
   * Request helper for binary downloads.
   *
   * Session mode follows a redirect to an ALLOWLISTED destination (spec 010
   * wave 2). Confluence Cloud answers `/download/attachments/…` with a 302 to
   * the media CDN, so the previous blanket "a redirect means the session
   * expired" rule made this method unusable for session profiles. The rule is
   * now by destination: a login bounce still raises the same typed auth error
   * (there are no attachment bytes at a login page), a media/site hop is
   * followed with the session credential stripped, and anything else is refused.
   */
  private async requestBinary(
    downloadPath: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<Uint8Array> {
    const url = new URL(`${this.confluenceBaseUrl}${downloadPath}`);

    const logger = getLogger();
    const requestId = generateRequestId();
    const startTime = Date.now();

    // Log request
    logger.api("request", {
      requestId,
      method: "GET",
      url: url.toString(),
      path: downloadPath,
      headers: redactSensitive({
        Authorization: this.authHeader,
      }),
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      const init = this.applyFetchOptions({
        method: "GET",
        headers: {
          Authorization: this.authHeader,
        },
        signal: options.signal,
      });
      // Token mode is untouched: no `redirect: "manual"` was set for it, so
      // fetch keeps following redirects exactly as before.
      const res = this.useSession
        ? await fetchSessionBinaryFollowingRedirects(
            url.toString(),
            init,
            this.sessionRedirectPolicy,
            {
              loginRedirectError: (status) => this.authRedirectError(status),
              blockedRedirectError: (target, reason) =>
                new SessionRedirectBlockedError("Confluence attachment download", target, reason),
            }
          )
        : await fetch(url.toString(), init);

      if (res.status === 429) {
        const delayMs =
          parseRetryAfterMs(res.headers.get("Retry-After")) ??
          this.baseDelayMs * Math.pow(2, attempt);

        if (attempt < this.maxRetries) {
          await this.sleep(delayMs, options.signal);
          continue;
        }
        const error = new Error(`Rate limited after ${this.maxRetries} retries`);
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: "Too Many Requests",
          durationMs: Date.now() - startTime,
          error: error.message,
        });
        throw error;
      }

      if (!res.ok) {
        lastError = new Error(`Download error (${res.status})`);

        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt), options.signal);
          continue;
        }
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: res.statusText,
          durationMs: Date.now() - startTime,
          error: lastError.message,
        });
        throw lastError;
      }

      const arrayBuffer = await res.arrayBuffer();
      // Isomorphic: `new Uint8Array(arrayBuffer)` instead of the node-only
      // `Buffer.from(...)` so this file stays browser-safe (no `Buffer` global
      // in the extension bundle). Node callers that need base64 wrap the result
      // in `Buffer.from(...)` at the call site.
      const buffer = new Uint8Array(arrayBuffer);

      // Log successful response (without binary body, just size)
      logger.api("response", {
        requestId,
        status: res.status,
        statusText: res.statusText,
        body: `[binary ${buffer.length} bytes]`,
        durationMs: Date.now() - startTime,
      });

      return buffer;
    }

    throw lastError ?? new Error("Download failed after retries");
  }

  /**
   * Parse Confluence attachment API response to AttachmentInfo.
   */
  private parseAttachmentResponse(data: any, pageId: string): AttachmentInfo {
    // Handle both single result and array response (POST returns array)
    const item = Array.isArray(data.results) ? data.results[0] : data;

    return {
      id: item.id,
      filename: item.title,
      mediaType: item.metadata?.mediaType || item.extensions?.mediaType || "application/octet-stream",
      fileSize: item.extensions?.fileSize ?? 0,
      version: item.version?.number ?? 1,
      // spec 004: keep the version timestamp for the diagram-preview staleness
      // note (previously dropped). Absent on older responses → undefined.
      modified: item.version?.when,
      pageId,
      downloadUrl: item._links?.download ?? "",
      url: item._links?.base ? `${item._links.base}${item._links.webui}` : undefined,
      comment: item.metadata?.comment,
    };
  }

  /**
   * Detect MIME type from filename extension.
   */
  private detectMimeType(filename: string): string {
    const ext = filename.toLowerCase().split(".").pop();
    const mimeTypes: Record<string, string> = {
      // Images
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      // Documents
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // Text
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
      xml: "application/xml",
      yaml: "application/x-yaml",
      yml: "application/x-yaml",
      // Archives
      zip: "application/zip",
      tar: "application/x-tar",
      gz: "application/gzip",
    };
    return mimeTypes[ext ?? ""] ?? "application/octet-stream";
  }

  // ============ Webhook Management ============

  /**
   * Register a webhook for page events.
   * Note: Requires app/add-on permissions in Confluence.
   */
  async registerWebhook(params: {
    name: string;
    url: string;
    events: string[];
  }): Promise<WebhookRegistration> {
    const data = (await this.webhookRequest("/webhook", {
      method: "POST",
      body: {
        name: params.name,
        url: params.url,
        events: params.events,
        active: true,
      },
    })) as any;

    return {
      id: data.id ?? data.self,
      name: data.name,
      url: data.url,
      events: data.events ?? [],
      active: data.active ?? true,
    };
  }

  /**
   * List all registered webhooks.
   */
  async listWebhooks(): Promise<WebhookRegistration[]> {
    const data = (await this.webhookRequest("/webhook", {})) as any;
    const results = Array.isArray(data) ? data : data.results ?? [];
    return results.map((item: any) => ({
      id: item.id ?? item.self,
      name: item.name,
      url: item.url,
      events: item.events ?? [],
      active: item.active ?? true,
    }));
  }

  /**
   * Delete a webhook by ID.
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    await this.webhookRequest(`/webhook/${webhookId}`, {
      method: "DELETE",
    });
  }

  /**
   * Request helper for webhook API (different base path).
   */
  private async webhookRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
    } = {}
  ): Promise<unknown> {
    const url = new URL(`${this.confluenceBaseUrl}/rest/webhooks/1.0${path}`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url.toString(), this.applyFetchOptions({
        method: options.method ?? "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      }));

      if (res.status === 429) {
        const delayMs =
          parseRetryAfterMs(res.headers.get("Retry-After")) ??
          this.baseDelayMs * Math.pow(2, attempt);

        if (attempt < this.maxRetries) {
          await this.sleep(delayMs);
          continue;
        }
        throw new Error(`Rate limited after ${this.maxRetries} retries`);
      }

      if (res.status === 204) {
        return {}; // No content (DELETE success)
      }

      const text = await res.text();
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        const message = typeof data === "string" ? data : JSON.stringify(data);
        lastError = new Error(`Webhook API error (${res.status}): ${message}`);

        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      return data;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  // ============ Label Operations ============

  /**
   * Get labels for a page.
   *
   * GET /content/{id}/label
   */
  async getLabels(pageId: string): Promise<LabelInfo[]> {
    const data = (await this.request(`/content/${pageId}/label`, {
      query: { limit: 200 },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      prefix: item.prefix ?? "global",
      name: item.name,
      id: item.id,
    }));
  }

  /**
   * Add one or more labels to a page.
   *
   * POST /content/{id}/label
   */
  async addLabels(pageId: string, labels: string[]): Promise<LabelInfo[]> {
    const body = labels.map((name) => ({
      prefix: "global",
      name,
    }));

    const data = (await this.request(`/content/${pageId}/label`, {
      method: "POST",
      body,
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      prefix: item.prefix ?? "global",
      name: item.name,
      id: item.id,
    }));
  }

  /**
   * Remove a label from a page.
   *
   * DELETE /content/{id}/label/{label}
   */
  async removeLabel(pageId: string, label: string): Promise<void> {
    await this.request(`/content/${pageId}/label/${encodeURIComponent(label)}`, {
      method: "DELETE",
    });
  }

  /**
   * Get pages with a specific label.
   *
   * Uses CQL: label = "labelname" [AND space = "SPACEKEY"]
   */
  async getPagesByLabel(
    label: string,
    options: { spaceKey?: string; limit?: number } = {}
  ): Promise<PageChangeInfo[]> {
    const { spaceKey, limit = 100 } = options;

    let cql = `label = "${label}" AND type = page`;
    if (spaceKey) {
      cql += ` AND space = "${spaceKey}"`;
    }

    const data = (await this.request("/content/search", {
      query: { cql, limit, expand: "version,space,history.lastUpdated" },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      id: item.id,
      title: item.title,
      version: item.version?.number ?? 1,
      lastModified: item.history?.lastUpdated?.when,
      spaceKey: item.space?.key,
    }));
  }

  // ============ Version History Operations ============

  /**
   * Get version history for a page.
   *
   * GET /content/{id}/version
   */
  async getPageHistory(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<PageHistory> {
    const { limit = 25 } = options;

    const data = (await this.request(`/content/${pageId}/version`, {
      query: { limit, expand: "content" },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    const versions: PageVersion[] = results.map((item: any) => ({
      number: item.number,
      by: {
        displayName: item.by?.displayName ?? "Unknown",
        email: item.by?.email,
      },
      when: item.when,
      message: item.message,
      minorEdit: item.minorEdit ?? false,
    }));

    return {
      pageId,
      versions,
      latest: versions.length > 0 ? versions[0].number : 1,
    };
  }

  /**
   * Get page content at a specific version.
   *
   * GET /content/{id}/version/{versionNumber}
   */
  async getPageAtVersion(
    pageId: string,
    version: number
  ): Promise<ConfluencePage & { storage: string }> {
    const data = (await this.request(`/content/${pageId}/version/${version}`, {
      query: { expand: "content.body.storage,content.space,content.ancestors" },
    })) as any;

    // The response structure nests content under 'content' key
    const content = data.content || data;

    // Extract ancestors
    const ancestors = Array.isArray(content.ancestors)
      ? content.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];
    const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null;

    return {
      id: content.id || pageId,
      title: content.title || data.title,
      url: content._links?.base ? `${content._links.base}${content._links.webui}` : undefined,
      version: data.number || version,
      spaceKey: content.space?.key,
      parentId,
      ancestors,
      storage: content.body?.storage?.value ?? "",
    };
  }

  /**
   * Restore a page to a previous version.
   * Creates a new version with the content from the specified version.
   *
   * This fetches the old version's content and updates the page.
   */
  async restorePageVersion(
    pageId: string,
    version: number,
    message?: string
  ): Promise<ConfluencePage> {
    // Get the content at the specified version
    const oldVersion = await this.getPageAtVersion(pageId, version);

    // Get the current page to get the latest version number
    const current = await this.getPage(pageId);
    const newVersion = (current.version ?? 1) + 1;

    // Update the page with the old content
    const data = (await this.request(`/content/${pageId}`, {
      method: "PUT",
      body: {
        id: pageId,
        type: "page",
        title: current.title,
        version: {
          number: newVersion,
          message: message ?? `Restored to version ${version}`,
        },
        body: {
          storage: {
            value: oldVersion.storage,
            representation: "storage",
          },
        },
      },
    })) as any;

    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
    };
  }

  // ============ Comments Operations (v2 API) ============

  /**
   * Get footer (page-level) comments for a page.
   *
   * GET /api/v2/pages/{id}/footer-comments
   */
  async getFooterComments(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<FooterComment[]> {
    const { limit = 100 } = options;

    const data = (await this.requestV2(`/pages/${pageId}/footer-comments`, {
      query: {
        limit,
        "body-format": "storage",
      },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    const comments = results.map((item: any) => this.parseFooterComment(item));

    // Fetch replies for each comment
    for (const comment of comments) {
      comment.replies = await this.getFooterCommentReplies(comment.id);
    }

    return comments;
  }

  /**
   * Get replies to a footer comment.
   *
   * GET /api/v2/footer-comments/{id}/children
   */
  async getFooterCommentReplies(
    commentId: string,
    options: { limit?: number } = {}
  ): Promise<FooterComment[]> {
    const { limit = 50 } = options;

    try {
      const data = (await this.requestV2(`/footer-comments/${commentId}/children`, {
        query: {
          limit,
          "body-format": "storage",
        },
      })) as any;

      const results = Array.isArray(data.results) ? data.results : [];
      return results.map((item: any) => this.parseFooterComment(item));
    } catch {
      // No replies or endpoint not available
      return [];
    }
  }

  /**
   * Get inline comments for a page.
   *
   * GET /api/v2/pages/{id}/inline-comments
   */
  async getInlineComments(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<InlineComment[]> {
    const { limit = 100 } = options;

    const data = (await this.requestV2(`/pages/${pageId}/inline-comments`, {
      query: {
        limit,
        "body-format": "storage",
      },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    const comments = results.map((item: any) => this.parseInlineComment(item));

    // Fetch replies for each comment
    for (const comment of comments) {
      comment.replies = await this.getInlineCommentReplies(comment.id);
    }

    return comments;
  }

  /**
   * Get replies to an inline comment.
   *
   * GET /api/v2/inline-comments/{id}/children
   */
  async getInlineCommentReplies(
    commentId: string,
    options: { limit?: number } = {}
  ): Promise<InlineComment[]> {
    const { limit = 50 } = options;

    try {
      const data = (await this.requestV2(`/inline-comments/${commentId}/children`, {
        query: {
          limit,
          "body-format": "storage",
        },
      })) as any;

      const results = Array.isArray(data.results) ? data.results : [];
      return results.map((item: any) => this.parseInlineComment(item));
    } catch {
      // No replies or endpoint not available
      return [];
    }
  }

  /**
   * Get all comments (footer + inline) for a page.
   */
  async getAllComments(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<PageComments> {
    const [footerComments, inlineComments] = await Promise.all([
      this.getFooterComments(pageId, options),
      this.getInlineComments(pageId, options),
    ]);

    return {
      pageId,
      lastSynced: new Date().toISOString(),
      footerComments,
      inlineComments,
    };
  }

  /**
   * Parse footer comment from v2 API response.
   */
  private parseFooterComment(item: any): FooterComment {
    return {
      id: item.id,
      author: {
        displayName: item.version?.authorId ?? "Unknown",
        accountId: item.version?.authorId,
      },
      created: item.version?.createdAt ?? item.createdAt,
      body: item.body?.storage?.value ?? "",
      status: item.resolutionStatus ?? "open",
      parentId: item.parentCommentId,
      replies: [],
    };
  }

  /**
   * Parse inline comment from v2 API response.
   */
  private parseInlineComment(item: any): InlineComment {
    const props = item.inlineCommentProperties ?? {};
    return {
      id: item.id,
      author: {
        displayName: item.version?.authorId ?? "Unknown",
        accountId: item.version?.authorId,
      },
      created: item.version?.createdAt ?? item.createdAt,
      body: item.body?.storage?.value ?? "",
      status: item.resolutionStatus ?? "open",
      parentId: item.parentCommentId,
      replies: [],
      textSelection: props.textSelection ?? "",
      textSelectionMatchCount: props.textSelectionMatchCount,
      textSelectionMatchIndex: props.textSelectionMatchIndex,
    };
  }

  // ============ Comment Creation (v2 API) ============

  /**
   * Create a footer (page-level) comment.
   *
   * POST /api/v2/footer-comments
   */
  async createFooterComment(params: {
    pageId: string;
    body: string;
    parentCommentId?: string;
  }): Promise<FooterComment> {
    const { pageId, body, parentCommentId } = params;

    // API requires exactly ONE of pageId or parentCommentId, not both
    const requestBody: Record<string, unknown> = {
      body: {
        representation: "storage",
        value: body,
      },
    };

    if (parentCommentId) {
      requestBody.parentCommentId = parentCommentId;
    } else {
      requestBody.pageId = pageId;
    }

    const data = (await this.requestV2("/footer-comments", {
      method: "POST",
      body: requestBody,
    })) as any;

    return this.parseFooterComment(data);
  }

  /**
   * Create an inline comment on specific text.
   *
   * POST /api/v2/inline-comments
   */
  async createInlineComment(params: {
    pageId: string;
    body: string;
    textSelection: string;
    textSelectionMatchCount?: number;
    textSelectionMatchIndex?: number;
    parentCommentId?: string;
  }): Promise<InlineComment> {
    const {
      pageId,
      body,
      textSelection,
      textSelectionMatchCount = 1,
      textSelectionMatchIndex = 0,
      parentCommentId,
    } = params;

    // API requires exactly ONE of pageId or parentCommentId, not both
    const requestBody: Record<string, unknown> = {
      body: {
        representation: "storage",
        value: body,
      },
      inlineCommentProperties: {
        textSelection,
        textSelectionMatchCount,
        textSelectionMatchIndex,
      },
    };

    if (parentCommentId) {
      requestBody.parentCommentId = parentCommentId;
    } else {
      requestBody.pageId = pageId;
    }

    const data = (await this.requestV2("/inline-comments", {
      method: "POST",
      body: requestBody,
    })) as any;

    return this.parseInlineComment(data);
  }

  /**
   * Resolve a comment (mark as resolved).
   *
   * PUT /api/v2/{type}-comments/{id}
   */
  async resolveComment(
    commentId: string,
    type: "footer" | "inline"
  ): Promise<void> {
    const endpoint = type === "footer" ? "footer-comments" : "inline-comments";

    // First fetch the comment to get its current body and version
    const current = (await this.requestV2(
      `/${endpoint}/${commentId}?body-format=storage`,
      { method: "GET" }
    )) as any;

    const version = current.version?.number ?? 1;
    const body = current.body?.storage?.value ?? "";

    await this.requestV2(`/${endpoint}/${commentId}`, {
      method: "PUT",
      body: {
        version: { number: version + 1 },
        body: {
          representation: "storage",
          value: body,
        },
        resolutionStatus: "resolved",
      },
    });
  }

  /**
   * Delete a comment.
   *
   * DELETE /api/v2/{type}-comments/{id}
   */
  async deleteComment(
    commentId: string,
    type: "footer" | "inline"
  ): Promise<void> {
    const endpoint = type === "footer" ? "footer-comments" : "inline-comments";

    await this.requestV2(`/${endpoint}/${commentId}`, {
      method: "DELETE",
    });
  }

  // ============ Folder Operations (v2 API) ============

  /**
   * Get a folder by ID.
   *
   * GET /api/v2/folders/{id}
   *
   * Note: Folders are a Confluence Cloud feature introduced in Sept 2024.
   */
  async getFolder(folderId: string): Promise<ConfluenceFolder> {
    const data = (await this.requestV2(`/folders/${folderId}`, {})) as any;

    return {
      id: data.id,
      title: data.title,
      spaceId: data.spaceId,
      parentId: data.parentId ?? null,
      url: this.buildWebUrl(data._links?.webui),
      createdAt: data.createdAt,
    };
  }

  /**
   * Update a folder (rename).
   *
   * Uses v1 content API: PUT /content/{id}
   * The v2 folder API doesn't support updates, only create/get/delete.
   *
   * Note: Folders are a Confluence Cloud feature introduced in Sept 2024.
   */
  async updateFolder(folderId: string, title: string): Promise<ConfluenceFolder> {
    // First get current folder to get version number
    const current = await this.getFolder(folderId);

    // Get current version from v1 API
    const currentContent = (await this.request(`/content/${folderId}`, {
      query: { expand: "version" },
    })) as any;
    const version = (currentContent.version?.number ?? 1) + 1;

    // Use v1 content API to update folder title
    const data = (await this.request(`/content/${folderId}`, {
      method: "PUT",
      body: {
        id: folderId,
        type: "folder",
        title,
        version: { number: version },
      },
    })) as any;

    return {
      id: data.id,
      title: data.title,
      spaceId: current.spaceId,
      parentId: current.parentId,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      createdAt: current.createdAt,
    };
  }

  /**
   * Get direct children of a folder.
   *
   * GET /api/v2/folders/{id}/direct-children
   *
   * Returns mixed content types (pages and folders).
   */
  async getFolderChildren(
    folderId: string,
    options: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<FolderChild[]> {
    const { limit = 100 } = options;

    // Cursor pagination ends only on the absence of a next cursor (see
    // drainPaginated). The raw `item.type` is preserved (open union) so a
    // whiteboard/database child is never mislabeled as a "page".
    return drainPaginated<FolderChild>(async (cursor) => {
      const query: Record<string, string | number | undefined> = { limit };
      if (cursor) query.cursor = cursor;

      const data = (await this.requestV2(`/folders/${folderId}/direct-children`, {
        query,
        signal: options.signal,
      })) as any;

      const results = Array.isArray(data.results) ? data.results : [];
      const items: FolderChild[] = results.map((item: any) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        spaceId: item.spaceId,
        parentId: folderId,
        url: this.buildWebUrl(item._links?.webui),
      }));

      return { items, next: extractCursor(data._links?.next, this.confluenceBaseUrl) };
    });
  }

  /**
   * Get all folders in a space by walking from the space homepage.
   *
   * Since Confluence Cloud v2 API doesn't have a direct endpoint to list all
   * folders in a space, we traverse from the homepage using getPageDirectChildren.
   *
   * @param spaceKey - The space key (e.g., "DOCSY")
   */
  async getSpaceFolders(spaceKey: string): Promise<ConfluenceFolder[]> {
    // Find homepage using CQL (page with no parent in the space)
    const searchResults = await this.searchPages(
      `space = "${spaceKey}" AND type = page ORDER BY created ASC`,
      50
    );

    let homepageId: string | undefined;

    for (const result of searchResults) {
      // Check if this page has no parent (homepage)
      const pageDetails = await this.getPage(result.id);
      if (!pageDetails.parentId && (!pageDetails.ancestors || pageDetails.ancestors.length === 0)) {
        homepageId = result.id;
        break;
      }
    }

    if (!homepageId) {
      return []; // No homepage found, return empty
    }

    // Walk the tree from homepage to find all folders
    return this.getFoldersInTree(homepageId);
  }

  /**
   * Create a folder in a space.
   *
   * POST /api/v2/folders
   */
  async createFolder(params: {
    spaceId: string;
    title: string;
    parentFolderId?: string;
  }): Promise<ConfluenceFolder> {
    const { spaceId, title, parentFolderId } = params;

    const body: Record<string, unknown> = {
      spaceId,
      title,
    };

    if (parentFolderId) {
      body.parentId = parentFolderId;
    }

    const data = (await this.requestV2("/folders", {
      method: "POST",
      body,
    })) as any;

    return {
      id: data.id,
      title: data.title,
      spaceId: data.spaceId,
      parentId: data.parentId ?? null,
      url: this.buildWebUrl(data._links?.webui),
      createdAt: data.createdAt,
    };
  }

  /**
   * Delete a folder.
   *
   * DELETE /api/v2/folders/{id}
   */
  async deleteFolder(folderId: string): Promise<void> {
    await this.requestV2(`/folders/${folderId}`, {
      method: "DELETE",
    });
  }

  /**
   * Get folder version using v1 content API.
   *
   * The v2 folder API doesn't expose version numbers, so we use the v1 API.
   */
  async getFolderVersion(folderId: string): Promise<number> {
    const data = (await this.request(`/content/${folderId}`, {
      query: { expand: "version" },
    })) as any;
    return data.version?.number ?? 1;
  }

  /**
   * Get all folders in scope with their versions.
   *
   * Used by the poller to track folder changes.
   */
  async getAllFoldersWithVersions(params: {
    scope: SyncScope;
  }): Promise<Array<{ id: string; title: string; version: number }>> {
    const { scope } = params;
    let folders: ConfluenceFolder[] = [];

    if (scope.type === "space") {
      folders = await this.getSpaceFolders(scope.spaceKey);
    } else if (scope.type === "tree") {
      // Get folders recursively under ancestor
      folders = await this.getFoldersInTree(scope.ancestorId);
    }
    // For single page scope, no folders to track

    // Get versions for each folder
    const results: Array<{ id: string; title: string; version: number }> = [];
    for (const folder of folders) {
      try {
        const version = await this.getFolderVersion(folder.id);
        results.push({ id: folder.id, title: folder.title, version });
      } catch {
        // Folder may have been deleted
      }
    }

    return results;
  }

  /**
   * Get folders recursively under a parent (page or folder).
   *
   * Traverses the hierarchy to find all nested folders.
   */
  async getFoldersInTree(parentId: string): Promise<ConfluenceFolder[]> {
    const folders: ConfluenceFolder[] = [];
    const visited = new Set<string>();

    const traverse = async (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      // Get direct children (can include folders)
      let children: FolderChild[];
      try {
        children = await this.getPageDirectChildren(id);
      } catch (err) {
        // Parent may have been deleted or access denied
        return;
      }

      for (const child of children) {
        if (child.type === "folder") {
          // Fetch full folder info
          try {
            const folder = await this.getFolder(child.id);
            folders.push(folder);
            // Recurse into folder
            await traverse(child.id);
          } catch {
            // Folder may have been deleted
          }
        }
      }
    };

    await traverse(parentId);
    return folders;
  }

  /**
   * Move a page into a folder.
   *
   * Note: v2 API doesn't support folder as parent directly. We use
   * PUT /rest/api/content/{id}/move to move into a folder.
   */
  async movePageToFolder(pageId: string, folderId: string): Promise<ConfluencePage> {
    // Use the v1 move endpoint - move page to be a child of the folder
    await this.request(`/content/${pageId}/move/append/${folderId}`, {
      method: "PUT",
    });

    // Fetch the updated page
    return this.getPage(pageId);
  }

  // ============ User API ============

  /**
   * Get user information by account ID.
   *
   * GET /rest/api/user?accountId=xxx
   *
   * @param accountId - Atlassian account ID
   * @returns User info or null if not found
   */
  async getUser(accountId: string): Promise<UserInfo | null> {
    try {
      const data = (await this.request("/user", {
        query: { accountId },
      })) as any;

      return {
        accountId: data.accountId,
        displayName: data.displayName ?? data.publicName ?? null,
        email: data.email ?? null,
        isActive: data.accountStatus === "active",
        profilePicture: data.profilePicture?.path ?? null,
      };
    } catch (error) {
      // User not found or no permission
      if (error instanceof Error && error.message.includes("404")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get a space homepage's storage body in one call.
   *
   * Exists for the Page Properties space-homepage fallback (spec 001 gap
   * **G4**): Scroll's `$scroll.pageproperty.(key,true)` falls back to the
   * space homepage's Page Properties macro when the page itself lacks the key.
   * `expand=homepage.body.storage` returns the homepage inline, so this stays a
   * single round-trip rather than a space lookup followed by a page fetch.
   *
   * @param spaceKey - Space key.
   * @returns The homepage's storage XML, or `null` when the space has no
   *   homepage or it carries no storage body.
   */
  async getSpaceHomepageStorage(spaceKey: string): Promise<string | null> {
    const data = (await this.request(`/space/${spaceKey}`, {
      query: { expand: "homepage.body.storage" },
    })) as { homepage?: { body?: { storage?: { value?: string } } } };
    return data?.homepage?.body?.storage?.value ?? null;
  }

  /**
   * Resolve a space's homepage page id in a **single** round-trip.
   *
   * Uses `GET /space/{spaceKey}?expand=homepage.id` (mirrors
   * {@link getSpaceHomepageStorage}'s `expand=homepage.body.storage`) rather
   * than `getSpaceFolders`' CQL-search-then-N-sequential-`getPage()` homepage
   * detection, which costs up to 51 requests for a one-call lookup. Backs the
   * `space` export scope (spec 002): the homepage is the tree root.
   *
   * @returns The homepage id, or `null` when the space has no classic homepage
   *   (e.g. a folder-only space root) — the caller reports actionable guidance.
   */
  async getSpaceHomepageId(
    spaceKey: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<string | null> {
    const data = (await this.request(`/space/${spaceKey}`, {
      query: { expand: "homepage.id" },
      signal: options.signal,
    })) as { homepage?: { id?: string } };
    return data?.homepage?.id ?? null;
  }

  /**
   * Get a page's **owner** (Confluence Cloud) — deliberately distinct from its
   * creator: ownership can be transferred, so `ownerId !== authorId` in general.
   *
   * Only the **v2** API exposes this (`ownerId` on `GET /api/v2/pages/{id}`);
   * v1's `history` carries `createdBy` but no owner, which is why this needs its
   * own call rather than riding along on {@link getPageDetails}. Callers should
   * therefore invoke it lazily, only when something actually asks for the owner
   * (spec 001 mapping gap **G1**).
   *
   * @param pageId - Page id.
   * @returns The owner with a resolved display name, or `null` when the page has
   *   no owner or the account cannot be looked up (caller renders empty).
   */
  async getPageOwner(pageId: string): Promise<ConfluenceUser | null> {
    const data = (await this.requestV2(`/pages/${pageId}`, {})) as {
      ownerId?: string | null;
    };
    const ownerId = data?.ownerId;
    if (!ownerId) return null;

    const user = await this.getUser(ownerId);
    if (!user?.displayName) return null;
    return {
      accountId: ownerId,
      displayName: user.displayName,
      email: user.email ?? undefined,
    };
  }

  /**
   * Get multiple users by account IDs.
   * Uses individual requests since Confluence doesn't have a bulk user endpoint.
   *
   * @param accountIds - List of Atlassian account IDs
   * @param options - Options for batch processing
   * @returns Map of accountId to UserInfo (missing users have null value)
   */
  async getUsersBulk(
    accountIds: string[],
    options: { concurrency?: number } = {}
  ): Promise<Map<string, UserInfo | null>> {
    const { concurrency = 5 } = options;
    const results = new Map<string, UserInfo | null>();
    const uniqueIds = [...new Set(accountIds)];

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < uniqueIds.length; i += concurrency) {
      const batch = uniqueIds.slice(i, i + concurrency);
      const promises = batch.map(async (id) => {
        const user = await this.getUser(id);
        results.set(id, user);
      });
      await Promise.all(promises);
    }

    return results;
  }

  // ============ Version History API ============

  /**
   * Get version history for a page.
   *
   * GET /content/{id}/version
   *
   * @param pageId - Page ID
   * @param options - Pagination options
   * @returns Page version history
   */
  async getVersionHistory(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<PageHistory> {
    const { limit = 100 } = options;
    const versions: PageVersion[] = [];
    let start = 0;
    let latest = 0;

    while (true) {
      const data = (await this.request(`/content/${pageId}/version`, {
        query: { limit, start },
      })) as any;

      if (!data.results || data.results.length === 0) break;

      for (const item of data.results) {
        const version: PageVersion = {
          number: item.number,
          by: {
            accountId: item.by?.accountId,
            displayName: item.by?.displayName ?? item.by?.publicName ?? "Unknown",
            email: item.by?.email,
          },
          when: item.when,
          message: item.message,
          minorEdit: item.minorEdit ?? false,
        };
        versions.push(version);

        if (item.number > latest) {
          latest = item.number;
        }
      }

      if (data.results.length < limit) break;
      start += limit;
    }

    return {
      pageId,
      versions,
      latest,
    };
  }

  // ============ Editor Version API ============

  /**
   * Get the editor version for a page.
   *
   * GET /rest/api/content/{id}?expand=metadata.properties.editor
   *
   * @param pageId - The page ID
   * @returns 'v2' for new editor, 'v1' for legacy, or null if not set
   */
  async getEditorVersion(pageId: string): Promise<"v2" | "v1" | null> {
    const data = (await this.request(`/content/${pageId}`, {
      query: { expand: "metadata.properties.editor" },
    })) as any;
    const value = data.metadata?.properties?.editor?.value;
    if (value === "v2") return "v2";
    if (value === "v1") return "v1";
    return null;
  }

  /**
   * Set the editor version for a page.
   *
   * Creates or updates the 'editor' content property.
   *
   * @param pageId - The page ID
   * @param version - 'v2' for new editor, 'v1' for legacy
   */
  async setEditorVersion(pageId: string, version: "v2" | "v1"): Promise<void> {
    // Try to get existing property to determine if we need POST or PUT
    try {
      const existing = (await this.request(
        `/content/${pageId}/property/editor`
      )) as any;
      // Property exists, update it
      await this.request(`/content/${pageId}/property/editor`, {
        method: "PUT",
        body: {
          key: "editor",
          value: version,
          version: { number: existing.version.number + 1 },
        },
      });
    } catch (error) {
      // Property doesn't exist, create it
      if (error instanceof Error && error.message.includes("404")) {
        await this.request(`/content/${pageId}/property/editor`, {
          method: "POST",
          body: { key: "editor", value: version },
        });
      } else {
        throw error;
      }
    }
  }
}

/** Webhook registration info */
export interface WebhookRegistration {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
}

/** Label info from Confluence API */
export interface LabelInfo {
  /** Label prefix (usually "global" for user-created labels) */
  prefix: string;
  /** Label name */
  name: string;
  /** Label ID */
  id: string;
}

/** Page version info */
export interface PageVersion {
  /** Version number */
  number: number;
  /** User who created this version */
  by: {
    accountId?: string;
    displayName: string;
    email?: string;
  };
  /** When this version was created (ISO timestamp) */
  when: string;
  /** Version message/comment */
  message?: string;
  /** Whether this was a minor edit */
  minorEdit: boolean;
}

/** Page version history */
export interface PageHistory {
  /** Page ID */
  pageId: string;
  /** List of versions (newest first) */
  versions: PageVersion[];
  /** Latest version number */
  latest: number;
}

/** Search results with pagination info */
export interface SearchResults {
  /** Search results */
  results: ConfluenceSearchResult[];
  /** Start index */
  start: number;
  /** Requested limit */
  limit: number;
  /** Number of results returned */
  size: number;
  /** Total number of results (if available) */
  totalSize?: number;
  /** Whether there are more results */
  hasMore: boolean;
  /** URL for next page of results (cursor-based pagination) */
  nextLink?: string;
}

/** Comment author info */
export interface CommentAuthor {
  /** Display name */
  displayName: string;
  /** Atlassian account ID */
  accountId?: string;
  /** Email (if available) */
  email?: string;
}

/** Base comment interface */
export interface BaseComment {
  /** Comment ID */
  id: string;
  /** Comment author */
  author: CommentAuthor;
  /** When the comment was created (ISO timestamp) */
  created: string;
  /** Comment body (storage format HTML) */
  body: string;
  /** Resolution status */
  status: "open" | "resolved";
  /** Parent comment ID (for replies) */
  parentId?: string;
  /** Reply comments */
  replies: BaseComment[];
}

/** Footer (page-level) comment */
export interface FooterComment extends BaseComment {
  replies: FooterComment[];
}

/** Inline comment attached to text selection */
export interface InlineComment extends BaseComment {
  /** The selected text this comment is attached to */
  textSelection: string;
  /** Number of times the selection appears on the page */
  textSelectionMatchCount?: number;
  /** Which occurrence (0-indexed) this comment is attached to */
  textSelectionMatchIndex?: number;
  replies: InlineComment[];
}

/** All comments for a page */
export interface PageComments {
  /** Page ID */
  pageId: string;
  /** When comments were last synced (ISO timestamp) */
  lastSynced: string;
  /** Footer (page-level) comments */
  footerComments: FooterComment[];
  /** Inline comments */
  inlineComments: InlineComment[];
}

/** Result of a bulk operation */
export interface BulkOperationResult {
  /** Total number of pages */
  total: number;
  /** Number of successful operations */
  successful: number;
  /** Number of failed operations */
  failed: number;
  /** Details of each failure */
  errors: Array<{
    pageId: string;
    title?: string;
    error: string;
  }>;
}

/** User information from Confluence API */
export interface UserInfo {
  /** Atlassian account ID */
  accountId: string;
  /** Display name */
  displayName: string | null;
  /** Email address (may be hidden based on privacy settings) */
  email: string | null;
  /** Whether the user account is active */
  isActive: boolean;
  /** Profile picture URL path */
  profilePicture: string | null;
}
