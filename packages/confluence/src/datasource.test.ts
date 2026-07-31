import { describe, expect, test } from "bun:test";
import {
  ASSETS_DATASOURCE_ID,
  CONFLUENCE_LIST_MACRO,
  CONFLUENCE_SEARCH_DATASOURCE_ID,
  DATASOURCE_DEFAULT_MAX_ROWS,
  DATASOURCE_PROVIDERS,
  JIRA_DATASOURCE_ID,
  datasourceProvider,
  parseDatasourceAttribute,
  tableColumns,
  translateDatasourceLink,
} from "./datasource.js";
import { macroParamText } from "./export-blocks.js";

/**
 * A privacy-sanitized `data-datasource` fixture preserving Confluence Cloud's
 * HTML-entity encoding and structural shape. Every parser change is measured
 * against this captured shape rather than a hand-written idealization.
 */
const REAL_ATTR_ENCODED =
  "{&quot;id&quot;:&quot;d8b75300-dfda-4519-b6cd-e49abbd50401&quot;," +
  "&quot;parameters&quot;:{&quot;cloudId&quot;:&quot;11111111-2222-4333-8444-555555555555&quot;," +
  "&quot;jql&quot;:&quot;project in (DEMO) and status in (Review) ORDER BY created DESC&quot;}," +
  "&quot;views&quot;:[{&quot;type&quot;:&quot;table&quot;,&quot;properties&quot;:{&quot;columns&quot;:[" +
  "{&quot;key&quot;:&quot;issuetype&quot;},{&quot;key&quot;:&quot;key&quot;},{&quot;key&quot;:&quot;summary&quot;}," +
  "{&quot;key&quot;:&quot;assignee&quot;},{&quot;key&quot;:&quot;priority&quot;},{&quot;key&quot;:&quot;status&quot;}," +
  "{&quot;key&quot;:&quot;updated&quot;}]}}]}";

const REAL_HREF =
  "https://example.atlassian.net/issues/?jql=project%20in%20(DEMO)%20and%20status%20in%20(Review)%20ORDER%20BY%20created%20DESC";

const REAL_JQL = "project in (DEMO) and status in (Review) ORDER BY created DESC";

/** Build a datasource attribute value (already decoded) from parts. */
function attr(payload: unknown): string {
  return JSON.stringify(payload);
}

function jiraDatasource(overrides: Record<string, unknown> = {}): string {
  return attr({
    id: JIRA_DATASOURCE_ID,
    parameters: { cloudId: "c-1", jql: "project = ATL" },
    views: [{ type: "table", properties: { columns: [{ key: "key" }, { key: "summary" }] } }],
    ...overrides,
  });
}

describe("parseDatasourceAttribute — entity decoding", () => {
  test("reads the entity-encoded storage form", () => {
    const res = parseDatasourceAttribute(REAL_ATTR_ENCODED);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.detail);
    expect(res.datasource.id).toBe(JIRA_DATASOURCE_ID);
    expect(res.datasource.parameters.jql).toBe(REAL_JQL);
  });

  test("reads the already-decoded form the storage tokenizer produces", () => {
    // parseXml decodes attribute values, so the walker hands us plain JSON.
    const decoded = REAL_ATTR_ENCODED.replaceAll("&quot;", '"');
    const res = parseDatasourceAttribute(decoded);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.detail);
    expect(res.datasource.parameters.jql).toBe(REAL_JQL);
  });

  test("does not double-decode a payload that already parses as JSON", () => {
    // `&quot;` inside a JQL string literal must survive verbatim: decoding an
    // already-valid payload a second time would silently rewrite the query.
    const raw = attr({
      id: JIRA_DATASOURCE_ID,
      parameters: { cloudId: "c", jql: 'summary ~ "&quot;" and project = A' },
      views: [{ type: "table", properties: { columns: [] } }],
    });
    const res = parseDatasourceAttribute(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.detail);
    expect(res.datasource.parameters.jql).toBe('summary ~ "&quot;" and project = A');
  });
});

describe("parseDatasourceAttribute — schema validation", () => {
  test("rejects malformed JSON without throwing", () => {
    const res = parseDatasourceAttribute("{not json");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("not-json");
  });

  test("rejects an empty attribute", () => {
    expect(parseDatasourceAttribute("   ").ok).toBe(false);
  });

  test("rejects a non-object payload", () => {
    const res = parseDatasourceAttribute("[1,2,3]");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("not-object");
  });

  test("rejects a missing id", () => {
    const res = parseDatasourceAttribute(
      attr({ parameters: {}, views: [{ type: "table" }] })
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("bad-id");
  });

  test("rejects non-object parameters", () => {
    const res = parseDatasourceAttribute(
      attr({ id: JIRA_DATASOURCE_ID, parameters: "x", views: [{ type: "table" }] })
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("bad-parameters");
  });

  test("rejects empty views (the schema requires minItems 1)", () => {
    const res = parseDatasourceAttribute(
      attr({ id: JIRA_DATASOURCE_ID, parameters: {}, views: [] })
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("bad-views");
  });

  test("rejects an unexpected envelope key (additionalProperties: false)", () => {
    const res = parseDatasourceAttribute(
      attr({
        id: JIRA_DATASOURCE_ID,
        parameters: {},
        views: [{ type: "table" }],
        somethingNew: 1,
      })
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("unexpected-key");
    // The offending key must be nameable from the report alone.
    expect(res.detail).toContain("somethingNew");
  });

  test("keeps presentation-only column metadata but ignores keyless columns", () => {
    const res = parseDatasourceAttribute(
      attr({
        id: JIRA_DATASOURCE_ID,
        parameters: {},
        views: [
          {
            type: "table",
            properties: {
              columns: [{ key: "key", width: 120, isWrapped: true }, { width: 9 }, { key: "  " }],
            },
          },
        ],
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.detail);
    expect(res.datasource.views[0].properties?.columns).toEqual([
      { key: "key", width: 120, isWrapped: true },
    ]);
  });
});

describe("tableColumns", () => {
  test("returns the author's column order from the real artifact", () => {
    const res = parseDatasourceAttribute(REAL_ATTR_ENCODED);
    if (!res.ok) throw new Error(res.detail);
    expect(tableColumns(res.datasource)).toEqual([
      "issuetype",
      "key",
      "summary",
      "assignee",
      "priority",
      "status",
      "updated",
    ]);
  });

  test("returns undefined when no table view exists", () => {
    const res = parseDatasourceAttribute(
      attr({ id: JIRA_DATASOURCE_ID, parameters: {}, views: [{ type: "gallery" }] })
    );
    if (!res.ok) throw new Error(res.detail);
    expect(tableColumns(res.datasource)).toBeUndefined();
  });
});

describe("provider registry", () => {
  test("resolves the three known provider ids", () => {
    expect(datasourceProvider(JIRA_DATASOURCE_ID)?.status).toBe("supported");
    expect(datasourceProvider(ASSETS_DATASOURCE_ID)?.status).toBe("known-unsupported");
    expect(datasourceProvider(CONFLUENCE_SEARCH_DATASOURCE_ID)?.status).toBe("supported");
    expect(datasourceProvider(CONFLUENCE_SEARCH_DATASOURCE_ID)?.macroName).toBe(CONFLUENCE_LIST_MACRO);
    expect(datasourceProvider("nope")).toBeUndefined();
  });

  test("every supported provider declares a macro name and a mapper", () => {
    for (const p of DATASOURCE_PROVIDERS) {
      if (p.status !== "supported") continue;
      expect(typeof p.macroName).toBe("string");
      expect(typeof p.toParams).toBe("function");
    }
  });
});

describe("translateDatasourceLink — the real artifact", () => {
  const outcome = translateDatasourceLink(REAL_ATTR_ENCODED, REAL_HREF);

  test("maps onto the EXISTING jira macro, not a new renderer", () => {
    expect(outcome.kind).toBe("macro");
    if (outcome.kind !== "macro") return;
    expect(outcome.macroName).toBe("jira");
  });

  test("passes the JQL — including its trailing ORDER BY — through verbatim", () => {
    // Regression: the user's chosen sort lives inside parameters.jql. Any
    // rewrite here silently re-sorts their table.
    if (outcome.kind !== "macro") throw new Error("expected macro");
    expect(macroParamText(outcome.params, "jqlQuery")).toBe(REAL_JQL);
    expect(macroParamText(outcome.params, "jqlQuery")).toContain("ORDER BY created DESC");
  });

  test("honours the author's column order", () => {
    if (outcome.kind !== "macro") throw new Error("expected macro");
    expect(macroParamText(outcome.params, "columns")).toBe(
      "issuetype,key,summary,assignee,priority,status,updated"
    );
  });

  test("supplies the row cap Atlassian does not store", () => {
    if (outcome.kind !== "macro") throw new Error("expected macro");
    expect(macroParamText(outcome.params, "maximumIssues")).toBe(
      String(DATASOURCE_DEFAULT_MAX_ROWS)
    );
  });

  test("carries the cloudId and href for the cross-site guard", () => {
    if (outcome.kind !== "macro") throw new Error("expected macro");
    expect(macroParamText(outcome.params, "datasourceId")).toBe(JIRA_DATASOURCE_ID);
    expect(macroParamText(outcome.params, "datasourceCloudId")).toBe(
      "11111111-2222-4333-8444-555555555555"
    );
    expect(macroParamText(outcome.params, "datasourceUrl")).toBe(REAL_HREF);
  });
});

describe("translateDatasourceLink — degradation", () => {
  test("unknown provider degrades and PRINTS THE RAW ID", () => {
    const id = "00000000-1111-2222-3333-444444444444";
    const out = translateDatasourceLink(
      attr({ id, parameters: {}, views: [{ type: "table" }] }),
      "https://x.atlassian.net/thing"
    );
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-provider-unknown");
    // Atlassian adds providers server-side; the id is what makes a brand-new
    // one identifiable from a report with no code change on our side.
    expect(out.message).toContain(id);
  });

  test("JSM Assets degrades by name", () => {
    const out = translateDatasourceLink(
      attr({ id: ASSETS_DATASOURCE_ID, parameters: {}, views: [{ type: "table" }] }),
      "https://x.atlassian.net/thing"
    );
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-provider-unsupported");
    expect(out.message).toContain("Assets");
  });

  test("Confluence search is SUPPORTED now — it routes to a macro, not a degradation", () => {
    const out = translateDatasourceLink(
      attr({
        id: CONFLUENCE_SEARCH_DATASOURCE_ID,
        parameters: { cloudId: "c-1", spaceKeys: ["DOCSY"] },
        views: [{ type: "table", properties: { columns: [{ key: "title" }] } }],
      }),
      "https://x.atlassian.net/wiki/search?text="
    );
    expect(out.kind).toBe("macro");
    if (out.kind !== "macro") return;
    expect(out.macroName).toBe(CONFLUENCE_LIST_MACRO);
  });

  test("a Confluence list with NO usable filter still degrades — never a site-wide search", () => {
    const out = translateDatasourceLink(
      attr({ id: CONFLUENCE_SEARCH_DATASOURCE_ID, parameters: {}, views: [{ type: "table" }] }),
      "https://x.atlassian.net/thing"
    );
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-query-empty");
  });

  test("the saved-filter variant degrades with its own code", () => {
    const out = translateDatasourceLink(
      jiraDatasource({ parameters: { cloudId: "c-1", filter: "10042" } }),
      "https://x.atlassian.net/issues/?filter=10042"
    );
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-filter-unsupported");
  });

  test("a Jira datasource with neither jql nor filter degrades as invalid", () => {
    const out = translateDatasourceLink(
      jiraDatasource({ parameters: { cloudId: "c-1" } }),
      "https://x.atlassian.net/issues"
    );
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-invalid");
  });

  test("malformed JSON degrades and never throws", () => {
    const out = translateDatasourceLink("{&quot;id&quot;:", "https://x/y");
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-invalid");
  });

  test("a non-table view degrades and names the view types found", () => {
    const out = translateDatasourceLink(
      jiraDatasource({ views: [{ type: "gallery" }] }),
      "https://x/y"
    );
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-invalid");
    expect(out.message).toContain("gallery");
  });

  test("every degradation carries a non-empty, user-facing message", () => {
    const cases = [
      "{broken",
      attr({ id: "unknown-id", parameters: {}, views: [{ type: "table" }] }),
      attr({ id: ASSETS_DATASOURCE_ID, parameters: {}, views: [{ type: "table" }] }),
      jiraDatasource({ parameters: { filter: "1" } }),
    ];
    for (const raw of cases) {
      const out = translateDatasourceLink(raw, "https://x/y");
      expect(out.kind).toBe("degrade");
      if (out.kind !== "degrade") continue;
      expect(out.message.length).toBeGreaterThan(20);
      expect(out.level).toBe("warning");
    }
  });
});

// ---------------------------------------------------------------------------
// Confluence list ("Confluence search") provider
// ---------------------------------------------------------------------------

/**
 * The VERBATIM `data-datasource` attribute of DOCSY page 1126236229
 * ("M1 Abnahme Abschnitt 7.6"), as Confluence Cloud stores it — HTML entities
 * intact, fetched from the live page on 2026-07-21.
 *
 * Two facts about this artifact drive the whole provider, and both would be
 * lost by a hand-written idealization: `searchString` is the EMPTY STRING, and
 * the only real filter is an ARRAY.
 */
const REAL_CONFLUENCE_ATTR_ENCODED =
  "{&quot;id&quot;:&quot;768fc736-3af4-4a8f-b27e-203602bff8ca&quot;," +
  "&quot;parameters&quot;:{&quot;cloudId&quot;:&quot;11111111-2222-4333-8444-555555555555&quot;," +
  "&quot;contributorAccountIds&quot;:[&quot;fixture-account-001&quot;]," +
  "&quot;searchString&quot;:&quot;&quot;}," +
  "&quot;views&quot;:[{&quot;type&quot;:&quot;table&quot;,&quot;properties&quot;:{&quot;columns&quot;:[" +
  "{&quot;key&quot;:&quot;type&quot;},{&quot;key&quot;:&quot;title&quot;},{&quot;key&quot;:&quot;space&quot;}," +
  "{&quot;key&quot;:&quot;description&quot;},{&quot;key&quot;:&quot;ownedBy&quot;},{&quot;key&quot;:&quot;updatedAt&quot;}," +
  "{&quot;key&quot;:&quot;labels&quot;},{&quot;key&quot;:&quot;status&quot;}]}}]}";

const REAL_CONFLUENCE_HREF =
  "https://example.atlassian.net/wiki/search?text=&contributors=fixture-account-001";

function confluenceList(parameters: Record<string, unknown>, columns: string[] = ["title"]): string {
  return attr({
    id: CONFLUENCE_SEARCH_DATASOURCE_ID,
    parameters,
    views: [{ type: "table", properties: { columns: columns.map((key) => ({ key })) } }],
  });
}

/** The composed CQL, or `undefined` when the parameters degraded. */
function cqlOf(parameters: Record<string, unknown>): string | undefined {
  const out = translateDatasourceLink(confluenceList(parameters), "https://x.atlassian.net/wiki/s");
  return out.kind === "macro" ? macroParamText(out.params, "cql") : undefined;
}

function degradeOf(parameters: Record<string, unknown>): { code: string; message: string } | undefined {
  const out = translateDatasourceLink(confluenceList(parameters), "https://x.atlassian.net/wiki/s");
  return out.kind === "degrade" ? { code: out.code, message: out.message } : undefined;
}

describe("Confluence list — the real artifact (DOCSY 1126236229)", () => {
  test("trap 1: an EMPTY searchString still yields a query, built from the filters", () => {
    const out = translateDatasourceLink(REAL_CONFLUENCE_ATTR_ENCODED, REAL_CONFLUENCE_HREF);
    expect(out.kind).toBe("macro");
    if (out.kind !== "macro") return;
    const cql = macroParamText(out.params, "cql");
    expect(cql).toBe('contributor in ("fixture-account-001")');
    // The whole trap: keying on `searchString` would have produced a `text ~ ""`
    // fragment (or concluded "no query"). Neither may appear.
    expect(cql).not.toContain("text ~");
    expect(cql).not.toContain("title ~");
  });

  test("carries the author's eight columns, in the author's order", () => {
    const out = translateDatasourceLink(REAL_CONFLUENCE_ATTR_ENCODED, REAL_CONFLUENCE_HREF);
    if (out.kind !== "macro") throw new Error("expected a macro");
    expect(macroParamText(out.params, "columns")).toBe(
      "type,title,space,description,ownedBy,updatedAt,labels,status"
    );
  });

  test("carries the row cap, the provider id, the cloud id and the live-list URL", () => {
    const out = translateDatasourceLink(REAL_CONFLUENCE_ATTR_ENCODED, REAL_CONFLUENCE_HREF);
    if (out.kind !== "macro") throw new Error("expected a macro");
    expect(macroParamText(out.params, "maximumResults")).toBe(String(DATASOURCE_DEFAULT_MAX_ROWS));
    expect(macroParamText(out.params, "datasourceId")).toBe(CONFLUENCE_SEARCH_DATASOURCE_ID);
    expect(macroParamText(out.params, "datasourceCloudId")).toBe("11111111-2222-4333-8444-555555555555");
    expect(macroParamText(out.params, "datasourceUrl")).toBe(REAL_CONFLUENCE_HREF);
  });
});

describe("Confluence list — parameter → CQL mapping", () => {
  test("trap 2: array parameters become `in (…)` lists, not scalars", () => {
    expect(cqlOf({ spaceKeys: ["DOCSY", "ATL"] })).toBe('space in ("DOCSY","ATL")');
    expect(cqlOf({ labels: ["a", "b"] })).toBe('label in ("a","b")');
    expect(cqlOf({ ancestorPageIds: ["1", "2"] })).toBe('ancestor in ("1","2")');
    expect(cqlOf({ creatorAccountIds: ["u1"] })).toBe('creator in ("u1")');
  });

  test("a search string becomes `text ~`, and `shouldMatchTitleOnly` switches it to `title ~`", () => {
    expect(cqlOf({ searchString: "budget" })).toBe('text ~ "budget"');
    expect(cqlOf({ searchString: "budget", shouldMatchTitleOnly: true })).toBe('title ~ "budget"');
  });

  test("every literal goes through escapeCqlValue — including a value carrying a quote", () => {
    const cql = cqlOf({ searchString: 'ev"il', labels: ['a"b', "c\\d"] })!;
    // The quote is escaped rather than closing the literal early.
    expect(cql).toContain('text ~ "ev\\"il"');
    expect(cql).toContain('label in ("a\\"b","c\\\\d")');
    // A naive builder would emit `text ~ "ev"il"`, which is a different query.
    expect(cql).not.toContain('"ev"il"');
  });

  test("all present parameters are AND-joined, in a fixed order", () => {
    // Key order in the object is deliberately scrambled: the CQL must not be.
    const cql = cqlOf({
      labels: ["x"],
      searchString: "q",
      spaceKeys: ["S"],
      entityTypes: ["page"],
    });
    expect(cql).toBe('text ~ "q" AND type in ("page") AND space in ("S") AND label in ("x")');
  });

  test("entityTypes maps onto CQL's own vocabulary and rejects what CQL would 400 on", () => {
    // Measured against Cloud: these eight are accepted by `type in (…)`.
    expect(cqlOf({ entityTypes: ["page", "blogpost", "attachment", "folder"] })).toBe(
      'type in ("page","blogpost","attachment","folder")'
    );
    // `blog` is Atlassian's older spelling and 400s as a CQL type.
    expect(cqlOf({ entityTypes: ["blog"] })).toBe('type in ("blogpost")');
    // A type we cannot map degrades rather than being sent and failing opaquely.
    expect(degradeOf({ entityTypes: ["hologram"] })?.code).toBe("datasource-filter-unsupported");
    expect(degradeOf({ entityTypes: ["hologram"] })?.message).toContain("hologram");
  });

  test("contentStatuses rides BESIDE the CQL — content status is not a CQL field", () => {
    // Measured: `status = "archived"` is a 400 on Cloud; the filter belongs in
    // `cqlcontext`. It also does not on its own make a query non-empty.
    const out = translateDatasourceLink(
      confluenceList({ spaceKeys: ["S"], contentStatuses: ["current", "archived"] }),
      "https://x/y"
    );
    if (out.kind !== "macro") throw new Error("expected a macro");
    expect(macroParamText(out.params, "cql")).toBe('space in ("S")');
    expect(macroParamText(out.params, "cql")).not.toContain("status");
    expect(macroParamText(out.params, "contentStatuses")).toBe("current,archived");
    expect(degradeOf({ contentStatuses: ["current"] })?.code).toBe("datasource-query-empty");
  });

  test("an absolute lastModified window becomes CQL date bounds", () => {
    expect(cqlOf({ lastModified: { from: "2026-01-01", to: "2026-06-30" } })).toBe(
      'lastmodified >= "2026-01-01" AND lastmodified <= "2026-06-30"'
    );
  });

  test("a RELATIVE lastModified degrades — an export has no reproducible timezone", () => {
    expect(degradeOf({ lastModified: { from: "-7d" } })?.code).toBe("datasource-filter-unsupported");
    expect(degradeOf({ lastModified: "today" })?.code).toBe("datasource-filter-unsupported");
  });

  test("contentARIs degrades rather than widening the table by dropping the filter", () => {
    // Present ALONGSIDE a mappable filter: honouring only the mappable one
    // would show rows the author excluded, which looks perfectly successful.
    const d = degradeOf({ spaceKeys: ["S"], contentARIs: ["ari:cloud:confluence:x:page/1"] });
    expect(d?.code).toBe("datasource-filter-unsupported");
    expect(d?.message).toContain("contentARIs");
  });

  test("a KNOWN filter in an unexpected shape degrades instead of being skipped", () => {
    // Skipping it would widen the table with rows the author excluded — the
    // same failure mode as dropping `contentARIs`.
    const d = degradeOf({ spaceKeys: "DOCSY" });
    expect(d?.code).toBe("datasource-filter-unsupported");
    expect(d?.message).toContain("spaceKeys");
  });

  test("an unrecognized filter degrades and names itself", () => {
    const d = degradeOf({ spaceKeys: ["S"], someFutureFilter: ["v"] });
    expect(d?.code).toBe("datasource-filter-unsupported");
    expect(d?.message).toContain("someFutureFilter");
  });

  test("empty values are not filters: empty arrays and blank strings yield no fragment", () => {
    expect(degradeOf({ cloudId: "c", searchString: "", spaceKeys: [], labels: [] })?.code).toBe(
      "datasource-query-empty"
    );
    // ...and cloudId alone never counts as a query.
    expect(degradeOf({ cloudId: "c" })?.code).toBe("datasource-query-empty");
  });

  test("regression: the Jira provider is untouched by the second provider", () => {
    const out = translateDatasourceLink(REAL_ATTR_ENCODED, REAL_HREF);
    expect(out.kind).toBe("macro");
    if (out.kind !== "macro") return;
    expect(out.macroName).toBe("jira");
    expect(macroParamText(out.params, "jqlQuery")).toBe(REAL_JQL);
  });
});
