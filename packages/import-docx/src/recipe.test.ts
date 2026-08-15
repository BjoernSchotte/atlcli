import { describe, expect, it } from "bun:test";
import { canonicalRecipeJson, parseRecipe, recipeApplicability } from "./recipe.js";
import { resolveImportPolicy } from "./overrides.js";

const VALID = `schema: atlcli.docx-import-recipe/1
id: company-handbook
version: "2.1"
title: Firmenhandbuch-Konventionen
targets: [cloud]
options:
  revisions: accept
  unsupported: fail
overrides:
  styleMappings:
    Hinweis: blockquote
    Listing: code
metadata:
  owners: [docs-team]
  tags: [handbook]
`;

describe("parseRecipe", () => {
  it("parses a valid recipe with a stable digest and policy layer", async () => {
    const a = await parseRecipe(VALID);
    expect(a.errors).toEqual([]);
    expect(a.parsed!.recipe.id).toBe("company-handbook");
    expect(a.parsed!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.parsed!.policyLayer).toEqual({
      options: { revisions: "accept", unsupported: "fail" },
      styleMappings: { Hinweis: "blockquote", Listing: "code" },
    });

    // Digest is byte-stable across key order (canonical JSON).
    const reordered = VALID.replace("id: company-handbook\nversion: \"2.1\"", "version: \"2.1\"\nid: company-handbook");
    const b = await parseRecipe(reordered);
    expect(b.parsed!.digest).toBe(a.parsed!.digest);

    // The layer feeds the standard precedence chain.
    const { policy } = resolveImportPolicy({ recipe: a.parsed!.policyLayer });
    expect(policy.options.unsupported).toBe("fail");
    expect(policy.provenance["style:hinweis"]).toBe("recipe");
  });

  it("rejects duplicate keys, aliases, custom tags, and unknown fields", async () => {
    expect((await parseRecipe(`schema: a\nschema: b\n`)).errors[0]).toContain("YAML");
    expect((await parseRecipe(`a: &x 1\nb: *x\n`)).errors.join()).toContain("anchors/aliases");
    expect((await parseRecipe(`a: !!js/function "x"\n`)).errors.join()).toMatch(/tag|YAML/);
    const unknown = await parseRecipe(VALID.replace("metadata:", "extras: 1\nmetadata:"));
    expect(unknown.errors.join()).toContain('Unknown field "extras"');
  });

  it("rejects bad ids, missing fields, unknown targets, and bad mapping targets", async () => {
    const bad = await parseRecipe(`schema: atlcli.docx-import-recipe/1
id: "Bad_ID!"
targets: [server]
overrides:
  styleMappings:
    X: panel-info
`);
    const text = bad.errors.join("\n");
    expect(text).toContain('"id" is invalid');
    expect(text).toContain('Missing required field "version"');
    expect(text).toContain('Missing required field "title"');
    expect(text).toContain('Unknown target "server"');
    expect(text).toContain("unknown target \"panel-info\"");
  });

  it("rejects oversized recipes and non-mapping roots", async () => {
    expect((await parseRecipe(`x`.repeat(70 * 1024))).errors[0]).toContain("exceeds");
    expect((await parseRecipe(`- just\n- a list\n`)).errors[0]).toContain("must be a mapping");
  });

  it("checks target applicability", async () => {
    const { parsed } = await parseRecipe(VALID.replace("[cloud]", "[data-center]"));
    expect(recipeApplicability(parsed!.recipe, "cloud")).toContain("not cloud");
    expect(recipeApplicability(parsed!.recipe, "data-center")).toBeUndefined();
  });

  it("canonical JSON sorts keys recursively", async () => {
    const { parsed } = await parseRecipe(VALID);
    const json = canonicalRecipeJson(parsed!.recipe);
    expect(json.indexOf('"id"')).toBeLessThan(json.indexOf('"schema"'));
    expect(json.indexOf('"Hinweis"')).toBeLessThan(json.indexOf('"Listing"'));
  });
});
