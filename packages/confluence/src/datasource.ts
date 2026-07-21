/**
 * Datasource smart links — the modern Confluence Cloud replacement for the
 * legacy `<ac:structured-macro ac:name="jira">` table
 * (spec `SUPPORT-DATASOURCE-JIRA`).
 *
 * Since Atlassian's 2026-05-22 cutover the Cloud editor no longer emits a Jira
 * macro when a user inserts an issue table. It emits
 *
 * ```html
 * <a href="https://site.atlassian.net/issues/?jql=…"
 *    data-card-appearance="block"
 *    data-datasource="{&quot;id&quot;:…,&quot;parameters&quot;:…,&quot;views&quot;:[…]}">…</a>
 * ```
 *
 * which the plain `<a>` walk turned into a percent-encoded URL blob with an
 * empty report. This module is the **pure** half of the fix: it decodes and
 * validates the attribute, resolves the provider `id` against a registry, and
 * translates a supported provider into the `MacroParameter[]` shape the
 * EXISTING Jira renderer already consumes. No second renderer, no IO, no host
 * APIs — the storage walk (`export-blocks.ts`) turns the result into either an
 * `unknown` macro block (which the spec-004 fallback chain then renders live)
 * or a link plus a typed note.
 *
 * Design notes that are load-bearing:
 *
 * - **The `id` is a provider, not a tenant.** It is a global constant compiled
 *   into every Cloud site's editor bundle (`ari:cloud:linking-platform:
 *   datasource/<uuid>`, platform-scoped, no tenant segment), and Atlassian adds
 *   providers server-side with no schema change. An unrecognized id is
 *   therefore a first-class case that must print the RAW id, so a newly
 *   introduced provider is identifiable from an export report alone.
 * - **The JQL is passed through verbatim.** The user's chosen sort order lives
 *   inside `parameters.jql` as a trailing `ORDER BY` — Atlassian's own column
 *   sort appends it there. Rewriting or normalizing the query silently
 *   re-sorts the user's table.
 * - **Provider parameters are permissive, the envelope is strict.** The ADF
 *   schema declares `additionalProperties: false` on the envelope while typing
 *   `parameters`/`views[].properties` as bare objects. We validate exactly that
 *   much: an unexpected envelope key degrades with a note naming the key
 *   (visible, diagnosable) rather than being interpreted on a guess.
 */

import { decodeHTML } from "entities";
import { escapeCqlValue } from "./client.js";
import type { ExportNoteCode, MacroParameter } from "./export-blocks.js";

// ---------------------------------------------------------------------------
// Provider ids (global constants, read off Atlassian's shipped bundles)
// ---------------------------------------------------------------------------

/** `JIRA_LIST_OF_LINKS_DATASOURCE_ID` — Jira work items (JQL or saved filter). */
export const JIRA_DATASOURCE_ID = "d8b75300-dfda-4519-b6cd-e49abbd50401";
/** `ASSETS_LIST_OF_LINKS_DATASOURCE_ID` — JSM Assets (AQL over a schema). */
export const ASSETS_DATASOURCE_ID = "361d618a-3c04-40ad-9b27-3c8ea6927020";
/** `CONFLUENCE_SEARCH_DATASOURCE_ID` — Confluence search results. */
export const CONFLUENCE_SEARCH_DATASOURCE_ID = "768fc736-3af4-4a8f-b27e-203602bff8ca";

// ---------------------------------------------------------------------------
// Parsed shape
// ---------------------------------------------------------------------------

/** One column of a datasource table view. `key` is a provider schema property. */
export interface DatasourceColumn {
  key: string;
  /** Presentation-only (px). Retained so a future layout consumer can read it. */
  width?: number;
  /** Presentation-only. */
  isWrapped?: boolean;
}

/**
 * One view of a datasource. `"table"` is the only member of Atlassian's
 * `DatasourceAdfView` union today — switching a card to inline in the editor
 * converts the node to a plain `inlineCard` and drops the datasource entirely,
 * so there is no `inline`/`list` variant to support.
 */
export interface DatasourceView {
  type: string;
  properties?: { columns?: DatasourceColumn[] };
}

/** The decoded `data-datasource` payload. */
export interface Datasource {
  id: string;
  /** Provider-defined; deliberately untyped (see module docs). */
  parameters: Record<string, unknown>;
  views: DatasourceView[];
}

/** The three envelope keys the ADF schema allows (`additionalProperties: false`). */
const ENVELOPE_KEYS = new Set(["id", "parameters", "views"]);

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** The note codes this module can produce (all members of `ExportNoteCode`). */
export type DatasourceDegradeCode = Extract<
  ExportNoteCode,
  | "datasource-invalid"
  | "datasource-provider-unknown"
  | "datasource-provider-unsupported"
  | "datasource-filter-unsupported"
  | "datasource-query-empty"
>;

/**
 * What a `<a data-datasource>` element translates to.
 *
 * `"macro"` hands the storage walk a ready-made macro instance — the existing
 * renderer chain does the rest. `"degrade"` keeps the link and states why, in a
 * note the user can act on. There is no third outcome: a datasource element is
 * never dropped and never throws.
 */
export type DatasourceOutcome =
  | {
      kind: "macro";
      /** Target macro name (`"jira"`), i.e. an EXISTING renderer's `macros` entry. */
      macroName: string;
      params: MacroParameter[];
      provider: DatasourceProvider;
    }
  | {
      kind: "degrade";
      code: DatasourceDegradeCode;
      level: "info" | "warning";
      message: string;
      /** The provider, when it was recognized at all. */
      provider?: DatasourceProvider;
    };

/**
 * A datasource provider. Adding support for Assets or Confluence search is a
 * new entry in {@link DATASOURCE_PROVIDERS} plus a `toParams` — not a new code
 * path in the walker.
 */
export interface DatasourceProvider {
  /** The global provider UUID. */
  id: string;
  /** Human label for report notes, e.g. `"Jira work items"`. */
  label: string;
  status: "supported" | "known-unsupported";
  /** Target macro name; required for `status: "supported"`. */
  macroName?: string;
  /** Translate the provider's parameters into macro parameters. */
  toParams?(ds: Datasource, ctx: DatasourceMapContext): DatasourceMapResult;
}

/** Everything a provider mapper needs beyond the datasource itself. */
export interface DatasourceMapContext {
  /** The element's `href` — the site the table points at, and the fallback link. */
  href: string;
  /** Resolved table columns, in the author's chosen order (may be empty). */
  columns: string[];
}

/** A typed, user-facing reason a datasource was kept as a link. */
export interface DatasourceDegradation {
  code: DatasourceDegradeCode;
  level: "info" | "warning";
  message: string;
}

export type DatasourceMapResult = { params: MacroParameter[] } | { degrade: DatasourceDegradation };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Row cap for a datasource table.
 *
 * Atlassian does NOT store a row limit in the datasource — its own PDF export
 * flips the live component's page size to 100 and auto-pages until exhausted,
 * which an export pipeline cannot do. 100 matches that page size and is also
 * `HARD_MAX_ISSUES` in the Jira renderer, so the cap is stated once here and
 * enforced once there. The renderer emits a truncation note whenever the cap
 * actually bites — a silently truncated table is the same class of defect as
 * the silently dropped one this whole change fixes.
 */
export const DATASOURCE_DEFAULT_MAX_ROWS = 100;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Why {@link parseDatasourceAttribute} rejected an attribute value. */
export interface DatasourceParseFailure {
  ok: false;
  /** Short machine reason, for tests and messages. */
  reason:
    | "not-json"
    | "not-object"
    | "bad-id"
    | "bad-parameters"
    | "bad-views"
    | "unexpected-key";
  detail: string;
}

export type DatasourceParseResult = { ok: true; datasource: Datasource } | DatasourceParseFailure;

/**
 * Decode + validate a raw `data-datasource` attribute value.
 *
 * Accepts BOTH the storage-format form (HTML entities intact, e.g.
 * `{&quot;id&quot;:…}`) and the already-decoded form the storage tokenizer
 * hands the walker. The decode is attempted only when the raw value does not
 * already parse as JSON, so a payload that legitimately contains `&`-sequences
 * is never double-decoded.
 *
 * Never throws: every rejection is a typed failure the caller degrades on.
 */
export function parseDatasourceAttribute(raw: string): DatasourceParseResult {
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "not-json", detail: "the attribute is empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    try {
      parsed = JSON.parse(decodeHTML(value));
    } catch (err) {
      return {
        ok: false,
        reason: "not-json",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object", detail: "the payload is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(key)) {
      return {
        ok: false,
        reason: "unexpected-key",
        detail: `unexpected key "${key}" (the datasource schema allows only id/parameters/views)`,
      };
    }
  }

  const id = obj.id;
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, reason: "bad-id", detail: "missing or non-string `id`" };
  }

  const parameters = obj.parameters;
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { ok: false, reason: "bad-parameters", detail: "missing or non-object `parameters`" };
  }

  const rawViews = obj.views;
  if (!Array.isArray(rawViews) || rawViews.length === 0) {
    return { ok: false, reason: "bad-views", detail: "missing or empty `views`" };
  }
  const views: DatasourceView[] = [];
  for (const v of rawViews) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, reason: "bad-views", detail: "a `views` entry is not an object" };
    }
    const view = v as Record<string, unknown>;
    if (typeof view.type !== "string") {
      return { ok: false, reason: "bad-views", detail: "a `views` entry has no string `type`" };
    }
    views.push({
      type: view.type,
      ...(isRecord(view.properties) ? { properties: readProperties(view.properties) } : {}),
    });
  }

  return {
    ok: true,
    datasource: { id: id.trim(), parameters: parameters as Record<string, unknown>, views },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readProperties(props: Record<string, unknown>): { columns?: DatasourceColumn[] } {
  if (!Array.isArray(props.columns)) return {};
  const columns: DatasourceColumn[] = [];
  for (const c of props.columns) {
    if (!isRecord(c)) continue;
    const key = c.key;
    if (typeof key !== "string" || key.trim() === "") continue;
    columns.push({
      key: key.trim(),
      ...(typeof c.width === "number" ? { width: c.width } : {}),
      ...(typeof c.isWrapped === "boolean" ? { isWrapped: c.isWrapped } : {}),
    });
  }
  return { columns };
}

/**
 * The columns of the datasource's table view, in the author's order.
 * Returns `undefined` when no `"table"` view exists (the only view type
 * Atlassian defines — anything else is either corrupt or a format we have not
 * seen, and must degrade rather than be guessed at).
 */
export function tableColumns(ds: Datasource): string[] | undefined {
  const table = ds.views.find((v) => v.type === "table");
  if (!table) return undefined;
  return (table.properties?.columns ?? []).map((c) => c.key);
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** `parameters.jql` / `parameters.filter`, when present as a non-empty string. */
function stringParam(ds: Datasource, name: string): string | undefined {
  const v = ds.parameters[name];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

const jiraProvider: DatasourceProvider = {
  id: JIRA_DATASOURCE_ID,
  label: "Jira work items",
  status: "supported",
  macroName: "jira",
  toParams(ds, ctx) {
    // The JQL is passed through BYTE-FOR-BYTE. Atlassian appends the user's
    // chosen column sort into it as a trailing `ORDER BY …`; normalizing,
    // re-quoting or re-ordering the query here would silently re-sort the
    // user's table. There is a regression test for exactly this.
    const jql = stringParam(ds, "jql");
    if (jql === undefined) {
      if (stringParam(ds, "filter") !== undefined) {
        return {
          degrade: {
            code: "datasource-filter-unsupported",
            level: "warning",
            message:
              "A Jira datasource table built on a saved filter was kept as a link: resolving a saved filter to its JQL is not supported yet.",
          },
        };
      }
      return {
        degrade: {
          code: "datasource-invalid",
          level: "warning",
          message:
            "A Jira datasource table carried neither a `jql` nor a `filter` parameter; it was kept as a link.",
        },
      };
    }

    const params: MacroParameter[] = [{ name: "jqlquery", text: jql }];
    if (ctx.columns.length > 0) {
      params.push({ name: "columns", text: ctx.columns.join(",") });
    }
    // Not stored by Atlassian — see DATASOURCE_DEFAULT_MAX_ROWS.
    params.push({ name: "maximumissues", text: String(DATASOURCE_DEFAULT_MAX_ROWS) });
    params.push({ name: "datasourceid", text: ds.id });
    const cloudId = stringParam(ds, "cloudId");
    if (cloudId !== undefined) params.push({ name: "datasourcecloudid", text: cloudId });
    if (ctx.href !== "") params.push({ name: "datasourceurl", text: ctx.href });
    return { params };
  },
};

// ---------------------------------------------------------------------------
// Confluence search provider (spec SUPPORT-DATASOURCE-CONFLUENCE)
// ---------------------------------------------------------------------------

/**
 * Synthetic macro name for a Confluence-list datasource.
 *
 * Synthetic on purpose: unlike `"jira"` there is no legacy
 * `<ac:structured-macro ac:name="confluence-list">` to collide with, so this
 * name exists solely to route the translated datasource at the renderer the
 * registry owns. It is deliberately NOT added to `KNOWN_MACROS` (the *markdown*
 * converter's vocabulary describes real Confluence macros).
 */
export const CONFLUENCE_LIST_MACRO = "confluence-list";

/**
 * The `type` values CQL accepts, measured against Confluence Cloud
 * (`GET /rest/api/search?cql=type = "…"`, 2026-07-21): every other value is a
 * 400, so passing an unrecognized `entityTypes` entry straight through would
 * fail the whole query with an opaque message. `blog` is Atlassian's older
 * spelling and is the one alias that is safe to normalize.
 */
const CQL_CONTENT_TYPES = new Set([
  "page",
  "blogpost",
  "attachment",
  "comment",
  "whiteboard",
  "database",
  "embed",
  "folder",
]);
const ENTITY_TYPE_ALIASES: Record<string, string> = { blog: "blogpost", blogpost: "blogpost" };

/**
 * `parameters` keys that carry no filter. `cloudId` identifies the site (the
 * `href` is the site evidence the renderer actually uses); `searchString` and
 * `shouldMatchTitleOnly` are consumed by the text fragment.
 */
const CONFLUENCE_NON_FILTER_PARAMS = new Set([
  "cloudId",
  "searchString",
  "shouldMatchTitleOnly",
]);

/**
 * List parameter → CQL field, in the order fragments are emitted.
 *
 * Order is fixed here rather than taken from `Object.keys(parameters)`, so two
 * exports of the same page produce a byte-identical CQL string (and therefore
 * hit the resolver's dedup cache) no matter how the editor happened to
 * serialize the object.
 */
const CONFLUENCE_LIST_FILTERS: readonly { param: string; field: string }[] = [
  { param: "entityTypes", field: "type" },
  { param: "spaceKeys", field: "space" },
  { param: "labels", field: "label" },
  { param: "ancestorPageIds", field: "ancestor" },
  { param: "creatorAccountIds", field: "creator" },
  { param: "contributorAccountIds", field: "contributor" },
];

/**
 * A Confluence-list query: the CQL, plus the one filter that is NOT expressible
 * in CQL (see {@link composeConfluenceSearchCql}).
 */
export interface ConfluenceSearchQuery {
  cql: string;
  /** `current` / `archived` / `draft` — a request parameter, not a CQL fragment. */
  contentStatuses?: string[];
}

/** A datasource parameter value that would constrain the query if we honoured it. */
function isMeaningful(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(isMeaningful);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).some(isMeaningful);
  return true;
}

/** Non-empty string entries of an array parameter (trap 2: values are lists). */
function listParam(ds: Datasource, name: string): string[] | undefined {
  const v = ds.parameters[name];
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return items.length > 0 ? items : undefined;
}

/** `field in ("a","b")`, every literal through `escapeCqlValue`. */
function inFragment(field: string, values: readonly string[]): string {
  return `${field} in (${values.map((v) => `"${escapeCqlValue(v)}"`).join(",")})`;
}

/** `yyyy-MM-dd`, the one CQL date literal shape we accept (see below). */
function cqlDate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/);
  return m ? m[1] : undefined;
}

function degrade(
  code: DatasourceDegradeCode,
  level: "info" | "warning",
  message: string
): DatasourceMapResult {
  return { degrade: { code, level, message } };
}

/**
 * Compose the CQL for a Confluence-list datasource from **all** present
 * parameters.
 *
 * The trap this function exists for: on the real artifact `searchString` is the
 * EMPTY STRING and the entire query lives in `contributorAccountIds`. Keying on
 * `searchString` (the obvious field, and the Jira provider's `jql` analogue)
 * would conclude "no query" and render nothing. So the empty case is "no
 * parameter produced a fragment", never "no searchString".
 *
 * Returns the composed query, or a typed degradation. Never an unbounded
 * site-wide search: a parameter set that yields no fragment degrades, because
 * `GET /search?cql=` over a whole site is not what the author asked for.
 */
export function composeConfluenceSearchCql(
  ds: Datasource
): ConfluenceSearchQuery | { degrade: DatasourceDegradation } {
  // `contentARIs` first: it is the one documented filter with NO CQL
  // equivalent, so honouring the rest and dropping it would WIDEN the result
  // set — a table of plausible-looking rows the author never asked for, which
  // is the same failure mode the Jira cross-site guard exists to prevent.
  if (isMeaningful(ds.parameters.contentARIs)) {
    return {
      degrade: {
        code: "datasource-filter-unsupported",
        level: "warning",
        message:
          "A Confluence list filters on specific content (`contentARIs`), which has no CQL equivalent; it was kept as a link rather than rendered from a wider query.",
      },
    };
  }

  const fragments: string[] = [];

  // 1. Free text. `shouldMatchTitleOnly` is a MODIFIER of this fragment, not a
  //    filter of its own — with no search string it has nothing to modify.
  const searchString = stringParam(ds, "searchString");
  if (searchString !== undefined) {
    const field = ds.parameters.shouldMatchTitleOnly === true ? "title" : "text";
    fragments.push(`${field} ~ "${escapeCqlValue(searchString)}"`);
  }

  // 2. List filters → `in (…)`.
  for (const { param, field } of CONFLUENCE_LIST_FILTERS) {
    const values = listParam(ds, param);
    if (!values) {
      // A filter that is PRESENT but not a usable list (a scalar, say, if
      // Atlassian ever changes the shape) must not be quietly skipped: dropping
      // it widens the table with rows the author excluded.
      if (isMeaningful(ds.parameters[param])) {
        return {
          degrade: {
            code: "datasource-filter-unsupported",
            level: "warning",
            message: `A Confluence list carries a "${param}" filter in a shape this exporter does not recognize; it was kept as a link rather than rendered from a query missing that filter.`,
          },
        };
      }
      continue;
    }
    if (param === "entityTypes") {
      const mapped: string[] = [];
      for (const raw of values) {
        const key = raw.toLowerCase();
        const cqlType = ENTITY_TYPE_ALIASES[key] ?? key;
        if (!CQL_CONTENT_TYPES.has(cqlType)) {
          return {
            degrade: {
              code: "datasource-filter-unsupported",
              level: "warning",
              message: `A Confluence list filters on content type "${raw}", which is not a CQL content type; it was kept as a link rather than rendered from a query missing that filter.`,
            },
          };
        }
        mapped.push(cqlType);
      }
      fragments.push(inFragment(field, mapped));
      continue;
    }
    fragments.push(inFragment(field, values));
  }

  // 3. Date window. This is the one filter we have no artifact for, so it is
  //    deliberately narrow: ABSOLUTE `yyyy-MM-dd` bounds only. Atlassian's own
  //    resolver sends an `origin-timezone` header with relative values
  //    (`today`, `-7d`), and an export has no defensible timezone to resolve
  //    those against — a reproducible document must not silently pick one.
  const lastModified = ds.parameters.lastModified;
  if (isMeaningful(lastModified)) {
    if (typeof lastModified !== "object" || Array.isArray(lastModified)) {
      return {
        degrade: {
          code: "datasource-filter-unsupported",
          level: "warning",
          message:
            "A Confluence list carries a `lastModified` filter in a shape this exporter does not recognize; it was kept as a link rather than rendered from a query missing that filter.",
        },
      };
    }
    const { from, to } = lastModified as Record<string, unknown>;
    const fromDate = from === undefined ? undefined : cqlDate(from);
    const toDate = to === undefined ? undefined : cqlDate(to);
    if ((from !== undefined && fromDate === undefined) || (to !== undefined && toDate === undefined)) {
      return {
        degrade: {
          code: "datasource-filter-unsupported",
          level: "warning",
          message:
            "A Confluence list filters on a relative last-modified window, which an export cannot resolve reproducibly (it depends on the reader's timezone); it was kept as a link.",
        },
      };
    }
    if (fromDate) fragments.push(`lastmodified >= "${fromDate}"`);
    if (toDate) fragments.push(`lastmodified <= "${toDate}"`);
  }

  // 4. Anything we do not recognize. A filter we silently drop widens the
  //    table; naming it in the report is the only honest outcome, and it is
  //    what makes a filter Atlassian adds after this release diagnosable.
  const known = new Set([
    ...CONFLUENCE_NON_FILTER_PARAMS,
    ...CONFLUENCE_LIST_FILTERS.map((f) => f.param),
    "contentStatuses",
    "contentARIs",
    "lastModified",
  ]);
  for (const [key, value] of Object.entries(ds.parameters)) {
    if (known.has(key) || !isMeaningful(value)) continue;
    return {
      degrade: {
        code: "datasource-filter-unsupported",
        level: "warning",
        message: `A Confluence list carries an unsupported filter "${key}"; it was kept as a link rather than rendered from a query missing that filter.`,
      },
    };
  }

  // 5. `contentStatuses` is NOT a CQL fragment. Measured against Confluence
  //    Cloud: `status = "archived"` is a 400 — content status is a REQUEST
  //    parameter (`cqlcontext.contentStatuses`), not a CQL field. It therefore
  //    rides beside the CQL rather than inside it, and it does not on its own
  //    make a query non-empty (a status with no other filter is still a
  //    site-wide search).
  const contentStatuses = listParam(ds, "contentStatuses");

  if (fragments.length === 0) {
    return {
      degrade: {
        code: "datasource-query-empty",
        level: "warning",
        message:
          "A Confluence list carries no filter this exporter can turn into a query; it was kept as a link rather than answered with an unbounded site-wide search.",
      },
    };
  }

  return {
    cql: fragments.join(" AND "),
    ...(contentStatuses ? { contentStatuses } : {}),
  };
}

const confluenceListProvider: DatasourceProvider = {
  id: CONFLUENCE_SEARCH_DATASOURCE_ID,
  label: "Confluence search results",
  status: "supported",
  macroName: CONFLUENCE_LIST_MACRO,
  toParams(ds, ctx) {
    const composed = composeConfluenceSearchCql(ds);
    if ("degrade" in composed) return degrade(composed.degrade.code, composed.degrade.level, composed.degrade.message);

    const params: MacroParameter[] = [{ name: "cql", text: composed.cql }];
    if (composed.contentStatuses) {
      params.push({ name: "contentstatuses", text: composed.contentStatuses.join(",") });
    }
    if (ctx.columns.length > 0) params.push({ name: "columns", text: ctx.columns.join(",") });
    // Not stored by Atlassian — see DATASOURCE_DEFAULT_MAX_ROWS. For this
    // provider the cap is the NORMAL case (the live artifact matches 2 817
    // rows), which is why the renderer's truncation note names both counts.
    params.push({ name: "maximumresults", text: String(DATASOURCE_DEFAULT_MAX_ROWS) });
    params.push({ name: "datasourceid", text: ds.id });
    const cloudId = stringParam(ds, "cloudId");
    if (cloudId !== undefined) params.push({ name: "datasourcecloudid", text: cloudId });
    if (ctx.href !== "") params.push({ name: "datasourceurl", text: ctx.href });
    return { params };
  },
};

/**
 * Every datasource provider we recognize. One is registered as
 * `known-unsupported` on purpose: "we recognize this and have not implemented
 * it" is a precise, actionable message, and it is materially different from
 * the unknown-id case, which must additionally print the raw id so a provider
 * Atlassian introduces AFTER this release is identifiable from a report alone.
 */
export const DATASOURCE_PROVIDERS: readonly DatasourceProvider[] = [
  jiraProvider,
  {
    id: ASSETS_DATASOURCE_ID,
    label: "Jira Service Management Assets",
    status: "known-unsupported",
  },
  confluenceListProvider,
];

/** Look a provider up by its global id. */
export function datasourceProvider(id: string): DatasourceProvider | undefined {
  const key = id.trim().toLowerCase();
  return DATASOURCE_PROVIDERS.find((p) => p.id.toLowerCase() === key);
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Translate one `<a data-datasource>` element into either a macro instance the
 * existing renderer chain consumes, or a typed degradation.
 *
 * @param rawAttr - the `data-datasource` attribute value (encoded or decoded).
 * @param href - the element's `href`, used as the site evidence and fallback link.
 */
export function translateDatasourceLink(rawAttr: string, href: string): DatasourceOutcome {
  const parsed = parseDatasourceAttribute(rawAttr);
  if (!parsed.ok) {
    return {
      kind: "degrade",
      code: "datasource-invalid",
      level: "warning",
      message: `A datasource smart link could not be read (${parsed.detail}); it was kept as a link.`,
    };
  }

  const ds = parsed.datasource;
  const provider = datasourceProvider(ds.id);

  if (!provider) {
    return {
      kind: "degrade",
      code: "datasource-provider-unknown",
      level: "warning",
      // The raw id is the whole point: Atlassian adds providers server-side,
      // and this string is what makes a brand-new one identifiable without a
      // code change on our side.
      message: `A datasource smart link uses an unrecognized provider (id "${ds.id}"); it was kept as a link.`,
    };
  }

  const columns = tableColumns(ds);
  if (columns === undefined) {
    return {
      kind: "degrade",
      code: "datasource-invalid",
      level: "warning",
      message: `A ${provider.label} datasource has no "table" view (found: ${ds.views
        .map((v) => `"${v.type}"`)
        .join(", ")}); it was kept as a link.`,
      provider,
    };
  }

  if (provider.status !== "supported" || !provider.macroName || !provider.toParams) {
    return {
      kind: "degrade",
      code: "datasource-provider-unsupported",
      level: "warning",
      message: `A ${provider.label} datasource table is not rendered by this exporter yet; it was kept as a link.`,
      provider,
    };
  }

  const mapped = provider.toParams(ds, { href, columns });
  if ("degrade" in mapped) {
    return { kind: "degrade", ...mapped.degrade, provider };
  }
  return { kind: "macro", macroName: provider.macroName, params: mapped.params, provider };
}
