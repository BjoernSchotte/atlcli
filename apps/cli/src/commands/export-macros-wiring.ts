/**
 * CLI host wiring for dynamic-macro resolution (spec 004, "Host wiring").
 *
 * Adapts the token-auth `JiraClient`/`ConfluenceClient` into the pure ports
 * `@atlcli/export-macros` defines, and assembles a `MacroResolutionOptions` the
 * DOCX/PDF engines accept. Everything Confluence/Jira-specific lives HERE, never
 * in `@atlcli/export-macros` (which stays isomorphic + client-free).
 */
import type { Profile } from "@atlcli/core";
import {
  ASSET_MAX_BYTES,
  ConfluenceClient,
  escapeCqlValue,
  extractMacroBody,
  storageToBlocks,
  htmlToExportBlocks,
  parsePageProperties,
} from "@atlcli/confluence";
import type { AssetFetcher, AssetRef, HostCallContext } from "@atlcli/docx";
import type { PdfAssetResolver, PdfResolvedAsset } from "@atlcli/pdf";
import { JiraClient, type JiraIssue } from "@atlcli/jira";
import {
  defaultRegistry,
  jiraStatusColor,
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
  type MacroResolutionOptions,
  type PortErrorKind,
} from "@atlcli/export-macros";

/** Parse the leading `(NNN)` status code out of a client's generic error. */
function statusOf(err: unknown): number | undefined {
  const m = (err instanceof Error ? err.message : String(err)).match(/\((\d{3})\)/);
  return m ? Number(m[1]) : undefined;
}

function classify(err: unknown, service: string): never {
  const status = statusOf(err);
  let kind: PortErrorKind = "network";
  if (status === 403 || status === 401) kind = "permission";
  else if (status === 404) kind = "not-found";
  else if (status === 429) kind = "rate-limited";
  throw portError(kind, err instanceof Error ? err.message : String(err), { service, cause: err });
}

/** Best-effort extra-column values for a JQL table (beyond key/summary/status). */
function extraFields(issue: JiraIssue): Record<string, string> {
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

export function jiraIssuePortFromClient(client: JiraClient, browseBaseUrl: string): JiraIssuePort {
  const base = browseBaseUrl.replace(/\/$/, "");
  const toRef = (issue: JiraIssue): JiraIssueRef => ({
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    statusColor: jiraStatusColor(issue.fields.status?.statusCategory?.colorName),
    url: `${base}/browse/${issue.key}`,
    fields: extraFields(issue),
  });
  return {
    async getIssue(key) {
      try {
        return toRef(await client.getIssue(key));
      } catch (err) {
        classify(err, "jira");
      }
    },
    async searchJql(jql, opts) {
      try {
        const res = await client.search(jql, { maxResults: opts.maximumIssues });
        return res.issues.slice(0, opts.maximumIssues).map(toRef);
      } catch (err) {
        classify(err, "jira");
      }
    },
  };
}

export function confluenceContentPortFromClient(client: ConfluenceClient): ConfluenceContentPort {
  const fetchStorage = async (id: string) => {
    try {
      const page = await client.getPage(id);
      return { id: page.id, version: page.version ?? 1, storage: page.storage };
    } catch (err) {
      classify(err, "confluence");
    }
  };
  return {
    async getPageStorage(title, spaceKey) {
      try {
        // `title`/`spaceKey` come from MACRO PARAMETERS (page-editor-controlled,
        // a different trust boundary than CLI flags) — escape through the same
        // escapeCqlValue every other CQL builder uses, never raw interpolation.
        const cql = spaceKey
          ? `type=page AND space="${escapeCqlValue(spaceKey)}" AND title="${escapeCqlValue(title)}"`
          : `type=page AND title="${escapeCqlValue(title)}"`;
        const results = await client.searchPages(cql, 1);
        if (results.length === 0) return undefined;
        return fetchStorage(results[0].id);
      } catch (err) {
        classify(err, "confluence");
      }
    },
    async getPageStorageById(id) {
      return fetchStorage(id);
    },
    async getChildren(pageId, opts) {
      try {
        const children = await client.getChildren(pageId, { limit: opts?.limit ?? 100 });
        return children.map((c) => ({ id: c.id, title: c.title }));
      } catch (err) {
        classify(err, "confluence");
      }
    },
    async searchCql(cql, opts) {
      try {
        const results = await client.searchPages(cql, opts?.limit ?? 25);
        return results.map((r) => ({ id: r.id, title: r.title }));
      } catch (err) {
        classify(err, "confluence");
      }
    },
  };
}

export function exportViewPortFromClient(client: ConfluenceClient): ExportViewPort {
  return {
    async renderMacroHtml(pageId, macroId) {
      try {
        // Batch: one export_view fetch per page, matched by data-macro-id.
        const macros = await client.getExportViewMacros(pageId);
        return macros.get(macroId);
      } catch (err) {
        classify(err, "exportView");
      }
    },
  };
}

export function attachmentLookupFromClient(client: ConfluenceClient): AttachmentLookupPort {
  const listings = new Map<string, Promise<Awaited<ReturnType<ConfluenceClient["listAttachments"]>>>>();
  return {
    async lookup(pageId, filename): Promise<AttachmentMeta | undefined> {
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
        classify(err, "confluence");
      }
    },
  };
}

/** Default same-origin-only policy for external `export_view` image bytes. */
export function defaultExternalAssetPolicy(profileBaseUrl: string): ExternalAssetPolicy {
  let origin = "";
  try {
    origin = new URL(profileBaseUrl).origin;
  } catch {
    origin = "";
  }
  return {
    allow(url: string): boolean {
      let u: URL;
      try {
        u = new URL(url, origin || undefined);
      } catch {
        return false;
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      // Reject loopback / private / link-local targets (SSRF guard).
      const host = u.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "::1" ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      ) {
        return false;
      }
      return origin === "" ? false : u.origin === origin;
    },
  };
}

/**
 * A redirect-checked, byte-capped external fetcher (spec 004). Re-checks the
 * policy against every `Location` hop and rejects as soon as the byte cap is
 * exceeded (never buffers the full body first, unlike `tokenAssetFetcher`).
 */
export function defaultExternalAssetFetcher(policy: ExternalAssetPolicy): ExternalAssetFetcher {
  const MAX_HOPS = 5;
  return {
    async fetch(url, opts) {
      let current = url;
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        if (!policy.allow(current)) {
          throw new Error(`external asset blocked by policy: ${current}`);
        }
        const res = await fetch(current, {
          redirect: "manual",
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) throw new Error(`redirect without Location from ${current}`);
          current = new URL(loc, current).toString();
          continue;
        }
        if (!res.ok) throw new Error(`external asset fetch failed (${res.status}) for ${current}`);
        const bytes = await readCapped(res, opts.maxBytes);
        return { bytes, mediaType: res.headers.get("content-type") ?? undefined };
      }
      throw new Error(`too many redirects fetching ${url}`);
    },
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  // Fail fast on a declared oversize body before reading ANY bytes — this also
  // covers the (theoretical) no-stream fallback below without buffering first.
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`external asset exceeded ${maxBytes} bytes`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    // Unreachable under Bun for any non-empty 2xx response (fetch always
    // exposes a ReadableStream body); kept as a defensive fallback for other
    // runtimes. The content-length pre-check above rejects declared oversize
    // without buffering; the post-check below catches an undeclared one —
    // by then the bytes are already in memory, which is why the streaming
    // path (not this branch) is the primary enforcement.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`external asset exceeded ${maxBytes} bytes`);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`external asset exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Trust-routing DOCX asset fetcher (spec 004 — SSRF enforcement, sink side).
 * `trust: "export-view"` refs (URLs from third-party-rendered macro HTML, NOT
 * page-author content) go through the policy-checked, redirect-re-checked,
 * byte-capped {@link ExternalAssetFetcher}; everything else (page-trust
 * attachments and page-author external images) stays on the token fetcher's
 * existing path unchanged.
 */
export function trustRoutingAssetFetcher(
  inner: AssetFetcher,
  external: ExternalAssetFetcher
): AssetFetcher {
  return {
    async fetch(ref: AssetRef, context?: HostCallContext): Promise<Uint8Array> {
      if (ref.trust === "export-view") {
        const { bytes } = await external.fetch(ref.url, {
          maxBytes: ASSET_MAX_BYTES,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        return bytes;
      }
      return inner.fetch(ref, context);
    },
  };
}

/**
 * Trust-routing PDF asset resolver (spec 004 — same enforcement for the PDF
 * engine's seam). The CLI has no PDF export path yet (the extension owns PDF,
 * T5.4), but the seam contract is identical, so the router lives here next to
 * its DOCX sibling and is tested through the real `preparePdfDocument` seam.
 */
export function trustRoutingPdfAssetResolver(
  inner: PdfAssetResolver,
  external: ExternalAssetFetcher
): PdfAssetResolver {
  return {
    async resolve(ref): Promise<PdfResolvedAsset> {
      if (ref.kind === "external" && ref.trust === "export-view") {
        if (!ref.url) throw new Error("external asset ref without url");
        const { bytes, mediaType } = await external.fetch(ref.url, { maxBytes: ASSET_MAX_BYTES });
        return { bytes, mediaType: mediaType ?? "application/octet-stream" };
      }
      return inner.resolve(ref);
    },
  };
}

export interface BuildMacroOptionsArgs {
  profile: Profile;
  confluence: ConfluenceClient;
  /** Present only when the profile has Jira access configured. */
  jira?: JiraClient;
  targetEngine: "docx" | "pdf";
  /** `false` for `--no-live-macros` (compliance/deterministic exports). */
  live?: boolean;
  /** Whether the DOCX template already carries a native TOC field. */
  nativeTocPresent?: boolean;
}

/**
 * Assemble the `MacroResolutionOptions` the engine env accepts: the default
 * registry (with the injected confluence deps) plus a `contextFor` that builds
 * a per-source-page context sharing the ports/policy across pages.
 */
export function buildMacroResolutionOptions(args: BuildMacroOptionsArgs): MacroResolutionOptions {
  const registry = defaultRegistry({
    storageToBlocks,
    htmlToExportBlocks,
    parsePageProperties,
    extractMacroBody,
  });
  const confluencePort = confluenceContentPortFromClient(args.confluence);
  const exportViewPort = exportViewPortFromClient(args.confluence);
  const attachmentsPort = attachmentLookupFromClient(args.confluence);
  const jiraPort = args.jira
    ? jiraIssuePortFromClient(args.jira, args.profile.baseUrl)
    : undefined;
  const policy = defaultExternalAssetPolicy(args.profile.baseUrl);
  const externalAssets = defaultExternalAssetFetcher(policy);
  const siteId = args.profile.baseUrl;

  return {
    registry,
    ...(args.live !== undefined ? { live: args.live } : {}),
    contextFor(page): MacroExportContext {
      return {
        page,
        confluence: confluencePort,
        exportView: exportViewPort,
        attachments: attachmentsPort,
        ...(jiraPort ? { jira: jiraPort } : {}),
        externalAssets,
        depth: 0,
        visited: new Set(),
        siteId,
        flags: {
          ...(args.nativeTocPresent ? { nativeTocPresent: true } : {}),
          targetEngine: args.targetEngine,
        },
      };
    },
  };
}
