import { expect, test } from "bun:test";
import { parseVarFlags } from "./page.js";

// `wiki page create --template` used to keep --var values as raw strings, so
// a JSON list rendered character by character in {% for %}.
test("page create --var parses JSON values and nests like every other --var", () => {
  expect(parseVarFlags({ var: ['items=["Budget","Hiring"]', "owner=ann", "a.b=1"], "var.legacy": "x" })).toEqual({
    items: ["Budget", "Hiring"],
    owner: "ann",
    a: { b: 1 },
    legacy: "x",
  });
});
