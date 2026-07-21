import { describe, expect, test } from "bun:test";
import {
  ASSETS_DATASOURCE_ID,
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
 * The VERBATIM `data-datasource` attribute of DOCSY page 1126236245
 * ("M1 Abnahme Abschnitt 7.7"), as Confluence Cloud stores it — HTML entities
 * intact. This is the artifact that exposed the whole defect; every parser
 * change is measured against it rather than against a hand-written idealization.
 */
const REAL_ATTR_ENCODED =
  "{&quot;id&quot;:&quot;d8b75300-dfda-4519-b6cd-e49abbd50401&quot;," +
  "&quot;parameters&quot;:{&quot;cloudId&quot;:&quot;ca7c5cc9-632e-4985-b88e-fb2a96c0b9ca&quot;," +
  "&quot;jql&quot;:&quot;project in (GROW) and status in (Review) ORDER BY created DESC&quot;}," +
  "&quot;views&quot;:[{&quot;type&quot;:&quot;table&quot;,&quot;properties&quot;:{&quot;columns&quot;:[" +
  "{&quot;key&quot;:&quot;issuetype&quot;},{&quot;key&quot;:&quot;key&quot;},{&quot;key&quot;:&quot;summary&quot;}," +
  "{&quot;key&quot;:&quot;assignee&quot;},{&quot;key&quot;:&quot;priority&quot;},{&quot;key&quot;:&quot;status&quot;}," +
  "{&quot;key&quot;:&quot;updated&quot;}]}}]}";

const REAL_HREF =
  "https://mayflowergmbh.atlassian.net/issues/?jql=project%20in%20(GROW)%20and%20status%20in%20(Review)%20ORDER%20BY%20created%20DESC";

const REAL_JQL = "project in (GROW) and status in (Review) ORDER BY created DESC";

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
    expect(datasourceProvider(CONFLUENCE_SEARCH_DATASOURCE_ID)?.status).toBe("known-unsupported");
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
      "ca7c5cc9-632e-4985-b88e-fb2a96c0b9ca"
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

  test("Confluence search degrades by name", () => {
    const out = translateDatasourceLink(
      attr({ id: CONFLUENCE_SEARCH_DATASOURCE_ID, parameters: {}, views: [{ type: "table" }] }),
      "https://x.atlassian.net/thing"
    );
    expect(out.kind).toBe("degrade");
    if (out.kind !== "degrade") return;
    expect(out.code).toBe("datasource-provider-unsupported");
    expect(out.message).toContain("Confluence search");
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
