import { describe, expect, test } from "bun:test";
import { createTemplateScope } from "../render.js";
import { collectVariables, renderBody } from "./index.js";
import { renderWikiMarkup } from "./wikimarkup.js";

const scope = createTemplateScope({ vars: { year: 2026 } });

describe("wiki markup", () => {
  test("skips code and noformat, keeps unknown monospace", () => {
    const s = "Audit {{year}} {{monospace}}\n{code:js}{{year}}{code}\n{noformat}{{year}}{noformat}";
    expect(renderWikiMarkup(s, scope, { unit: "d" }).value).toBe("Audit 2026 {{monospace}}\n{code:js}{{year}}{code}\n{noformat}{{year}}{noformat}");
  });
});

describe("renderBody", () => {
  test("dispatches by shape and format", () => {
    expect(renderBody("Y{{year}}", scope, { unit: "s" }).value).toBe("Y2026");
    const empty = { type: "doc", version: 1, content: [] };
    expect(renderBody(empty, scope, { unit: "d" }).value).toBe(empty);
    expect(renderBody("<p>{{year}}</p>", scope, { unit: "p", format: "storage" }).value).toBe("<p>2026</p>");
    expect(renderBody("{{year}}", scope, { unit: "w", format: "wikimarkup" }).value).toBe("2026");
    expect(renderBody(null, scope, { unit: "n" }).value).toBeNull();
  });
  test("strict applies to every format", () => {
    expect(() => renderBody("{{nope}}", scope, { unit: "s", strict: true })).toThrow(/strict/);
  });
});

describe("collectVariables", () => {
  test("finds root variables across formats", () => {
    const uses = collectVariables([
      { unit: "summary", value: "Audit {{year}} {{@today}} {{source.key}} {{uppercase team}}" },
      {
        unit: "description",
        value: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "{{#each systems}}{{name}}{{/each}} {{default owner \"x\"}}" }] },
            { type: "paragraph", content: [{ type: "text", text: "{{#if (eq region \"eu\")}}" }] },
          ],
        },
      },
      { unit: "page", value: "<p>{{customer}}</p>", format: "storage" },
    ]);
    expect(uses.map((u) => u.name).sort()).toEqual(["customer", "owner", "region", "systems", "team", "year"]);
    expect(uses.find((u) => u.name === "year")).toEqual({ name: "year", unit: "summary", line: 1 });
  });
});
