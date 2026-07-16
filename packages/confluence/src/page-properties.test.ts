import { describe, expect, test } from "bun:test";
import { lookupPageProperty, parsePageProperties } from "./page-properties.js";

/** The modern editor writes the label as <th>; older content uses <td>. */
function detailsMacro(rows: string, id?: string): string {
  const param = id ? `<ac:parameter ac:name="id">${id}</ac:parameter>` : "";
  return `<ac:structured-macro ac:name="details">${param}<ac:rich-text-body><table><tbody>${rows}</tbody></table></ac:rich-text-body></ac:structured-macro>`;
}

describe("parsePageProperties", () => {
  test("reads th/td rows into a label→value map", () => {
    const macros = parsePageProperties(
      detailsMacro("<tr><th>Status</th><td>Approved</td></tr><tr><th>Owner</th><td>Olga</td></tr>")
    );
    expect(macros).toHaveLength(1);
    expect([...macros[0].rows]).toEqual([
      ["Status", "Approved"],
      ["Owner", "Olga"],
    ]);
  });

  test("accepts the older td/td shape (label is the FIRST cell, whatever its tag)", () => {
    const macros = parsePageProperties(detailsMacro("<tr><td>Key</td><td>Value</td></tr>"));
    expect(macros[0].rows.get("Key")).toBe("Value");
  });

  test("captures the macro id parameter", () => {
    const macros = parsePageProperties(detailsMacro("<tr><th>A</th><td>1</td></tr>", "specs"));
    expect(macros[0].id).toBe("specs");
  });

  test("decodes entities and collapses whitespace in labels and values", () => {
    const macros = parsePageProperties(
      detailsMacro("<tr><th>Gr&ouml;&szlig;e</th><td>  drei   &uuml;ber  </td></tr>")
    );
    expect(macros[0].rows.get("Größe")).toBe("drei über");
  });

  test("keeps inline markup as plain text", () => {
    const macros = parsePageProperties(
      detailsMacro("<tr><th>Status</th><td><strong>Ap</strong>proved</td></tr>")
    );
    expect(macros[0].rows.get("Status")).toBe("Approved");
  });

  test("finds a details macro NESTED inside another macro's body", () => {
    // A regex hunting the next </ac:structured-macro> would slice the outer
    // macro at the inner close tag; the tree walk does not.
    const storage = `<ac:structured-macro ac:name="expand"><ac:rich-text-body>${detailsMacro(
      "<tr><th>Inner</th><td>yes</td></tr>"
    )}</ac:rich-text-body></ac:structured-macro>`;
    const macros = parsePageProperties(storage);
    expect(macros).toHaveLength(1);
    expect(macros[0].rows.get("Inner")).toBe("yes");
  });

  test("returns every macro in document order", () => {
    const macros = parsePageProperties(
      detailsMacro("<tr><th>A</th><td>1</td></tr>", "first") +
        detailsMacro("<tr><th>B</th><td>2</td></tr>", "second")
    );
    expect(macros.map((m) => m.id)).toEqual(["first", "second"]);
  });

  test("skips rows that carry no property, and duplicate labels keep the first", () => {
    const macros = parsePageProperties(
      detailsMacro(
        "<tr><th>Lonely</th></tr><tr><th></th><td>no label</td></tr>" +
          "<tr><th>Dup</th><td>one</td></tr><tr><th>Dup</th><td>two</td></tr>"
      )
    );
    expect([...macros[0].rows]).toEqual([["Dup", "one"]]);
  });

  test("no details macro → no macros (and no work on unrelated storage)", () => {
    expect(parsePageProperties("<p>plain</p>")).toEqual([]);
    expect(parsePageProperties("")).toEqual([]);
  });

  // Verbatim from a real DOCSY page (2026-07-16). Hand-built fixtures missed
  // both the ac:schema-version/ac:macro-id attributes and the fact that the
  // markdown path renders the first table row as <th>.
  test("parses REAL Confluence-authored markup, attributes and all", () => {
    const real =
      '<ac:structured-macro ac:name="details" ac:schema-version="1" ac:macro-id="8ac0da71-e600-4d01-afc0-cf96635ea85e">' +
      '<ac:parameter ac:name="id">zoo-meta</ac:parameter><ac:rich-text-body>' +
      "<table><thead><tr><th>Status</th><th>Freigegeben</th></tr></thead><tbody>" +
      "<tr><td>Verantwortlich</td><td>Bj&ouml;rn Schotte</td></tr>" +
      "<tr><td>Dokumentart</td><td>Pr&uuml;fseite</td></tr>" +
      "</tbody></table></ac:rich-text-body></ac:structured-macro>";
    const macros = parsePageProperties(real);
    expect(macros).toHaveLength(1);
    expect(macros[0].id).toBe("zoo-meta");
    expect(macros[0].macroId).toBe("8ac0da71-e600-4d01-afc0-cf96635ea85e");
    expect([...macros[0].rows]).toEqual([
      ["Status", "Freigegeben"],
      ["Verantwortlich", "Björn Schotte"],
      ["Dokumentart", "Prüfseite"],
    ]);
  });
});

describe("lookupPageProperty", () => {
  const macros = parsePageProperties(
    detailsMacro("<tr><th>Status</th><td>Approved</td></tr>", "specs") +
      detailsMacro("<tr><th>Status</th><td>Draft</td></tr><tr><th>Only</th><td>here</td></tr>", "other")
  );

  test("matches the label case-insensitively", () => {
    expect(lookupPageProperty(macros, "status")).toBe("Approved");
    expect(lookupPageProperty(macros, "  STATUS ")).toBe("Approved");
  });

  test("first macro carrying the key wins when no id is given", () => {
    expect(lookupPageProperty(macros, "Status")).toBe("Approved");
  });

  test("an id scopes the lookup to that macro", () => {
    expect(lookupPageProperty(macros, "Status", "other")).toBe("Draft");
    // The key exists elsewhere, but not in the requested macro.
    expect(lookupPageProperty(macros, "Only", "specs")).toBeUndefined();
  });

  test("the id also matches the ac:macro-id attribute, not just the parameter", () => {
    const withUuid = parsePageProperties(
      '<ac:structured-macro ac:name="details" ac:macro-id="uuid-1"><ac:rich-text-body>' +
        "<table><tr><th>K</th><td>V</td></tr></table></ac:rich-text-body></ac:structured-macro>"
    );
    expect(lookupPageProperty(withUuid, "K", "uuid-1")).toBe("V");
    expect(lookupPageProperty(withUuid, "K", "nope")).toBeUndefined();
  });

  test("absent key and empty key are undefined, not empty string", () => {
    expect(lookupPageProperty(macros, "Nope")).toBeUndefined();
    expect(lookupPageProperty(macros, "")).toBeUndefined();
  });
});
