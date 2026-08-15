import { describe, expect, it } from "bun:test";
import { renderPolicySummary, resolveImportPolicy } from "./overrides.js";
import { parseDocx } from "./parse.js";
import { DEFAULT_STYLES, buildDocxFixture, p, r } from "./test-support.js";

describe("resolveImportPolicy", () => {
  it("resolves defaults with default provenance", () => {
    const { policy, errors } = resolveImportPolicy({});
    expect(errors).toEqual([]);
    expect(policy.options).toEqual({ revisions: "accept", unsupported: "report", comments: "auto" });
    expect(policy.provenance["options.revisions"]).toBe("default");
    expect(renderPolicySummary(policy)).toEqual([]);
  });

  it("applies precedence default < recipe < cli < override-file with provenance", () => {
    const { policy, errors } = resolveImportPolicy({
      recipe: {
        options: { revisions: "reject", unsupported: "fail" },
        styleMappings: { Hinweis: "blockquote", Warnung: "blockquote" },
      },
      cli: { options: { revisions: "accept" }, styleMappings: { hinweis: "code" } },
      overrideFile: { styleMappings: { warnung: "heading-3" } },
    });
    expect(errors).toEqual([]);
    expect(policy.options.revisions).toBe("accept");
    expect(policy.provenance["options.revisions"]).toBe("cli");
    expect(policy.options.unsupported).toBe("fail");
    expect(policy.provenance["options.unsupported"]).toBe("recipe");
    expect(policy.styleMappings).toEqual({ hinweis: "code", warnung: "heading-3" });
    expect(policy.provenance["style:hinweis"]).toBe("cli");
    expect(policy.provenance["style:warnung"]).toBe("override-file");
  });

  it("fails on conflicts between the two explicit layers", () => {
    const { errors } = resolveImportPolicy({
      cli: { options: { revisions: "accept" }, styleMappings: { note: "code" } },
      overrideFile: { options: { revisions: "reject" }, styleMappings: { note: "blockquote" } },
    });
    expect(errors).toEqual([
      'Conflicting explicit settings for options.revisions: CLI says "accept", override file says "reject". Remove one.',
      'Conflicting explicit style mapping for "note": CLI says "code", override file says "blockquote". Remove one.',
    ]);
  });

  it("rejects unknown targets and option values, collecting everything", () => {
    const { errors } = resolveImportPolicy({
      cli: {
        options: { revisions: "maybe" as never, unsupported: "warn" as never },
        styleMappings: { x: "panel-info", "": "code" },
      },
    });
    expect(errors).toHaveLength(4);
    expect(errors.join("\n")).toContain("revisions must be accept|reject");
    expect(errors.join("\n")).toContain("unknown target \"panel-info\"");
    expect(errors.join("\n")).toContain("empty style name");
  });
});

describe("parseDocx with policy", () => {
  const styles = DEFAULT_STYLES.replace(
    "</w:styles>",
    `<w:style w:type="paragraph" w:styleId="Hinweis1"><w:name w:val="Hinweis"/></w:style></w:styles>`,
  );

  it("maps a custom style by display name and demotes a heading to paragraph", () => {
    const bytes = buildDocxFixture({
      body:
        p(r("Wichtiger Hinweis."), { style: "Hinweis1" }) +
        p(r("Was heading"), { style: "Heading2" }),
      styles,
    });
    const doc = parseDocx(bytes, {
      styleMappings: { hinweis: "blockquote", heading2: "paragraph" },
    });
    expect(doc.blocks.map((b) => b.type)).toEqual(["blockquote", "paragraph"]);
  });

  it("maps a style to a heading level and reports unmatched mapping keys", () => {
    const bytes = buildDocxFixture({ body: p(r("Titelzeile"), { style: "Hinweis1" }), styles });
    const doc = parseDocx(bytes, {
      styleMappings: { hinweis1: "heading-2", ghost: "code" },
    });
    expect(doc.blocks[0].type).toBe("heading");
    if (doc.blocks[0].type !== "heading") throw new Error("unreachable");
    expect(doc.blocks[0].level).toBe(2);
    expect(doc.issues.some((i) => i.code === "docx-import/style-mapping-unmatched")).toBe(true);
  });

  it("revisions=reject drops insertions and keeps deletions", () => {
    const bytes = buildDocxFixture({
      body: p(
        `<w:ins><w:r><w:t>added</w:t></w:r></w:ins>` +
          `<w:del><w:r><w:delText>removed</w:delText></w:r></w:del>` +
          r(" base"),
      ),
    });
    const rejected = parseDocx(bytes, { revisions: "reject" });
    const text = JSON.stringify(rejected.blocks);
    expect(text).not.toContain("added");
    expect(text).toContain("removed");
    const codes = rejected.issues.map((i) => i.code);
    expect(codes).toContain("docx-import/revision-insertion-rejected");
    expect(codes).toContain("docx-import/revision-deletion-kept");

    // Default behavior unchanged (regression).
    const accepted = parseDocx(bytes);
    const acceptedText = JSON.stringify(accepted.blocks);
    expect(acceptedText).toContain("added");
    expect(acceptedText).not.toContain("removed");
  });
});
