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

export type DatasourceMapResult =
  | { params: MacroParameter[] }
  | { degrade: { code: DatasourceDegradeCode; level: "info" | "warning"; message: string } };

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

/**
 * Every datasource provider we recognize. Two are registered as
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
  {
    id: CONFLUENCE_SEARCH_DATASOURCE_ID,
    label: "Confluence search results",
    status: "known-unsupported",
  },
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
