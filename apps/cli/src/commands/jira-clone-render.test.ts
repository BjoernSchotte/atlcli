import { describe, expect, test, beforeAll } from "bun:test";
import { initJinja } from "@atlcli/core";
import { createTemplateScope, RenderError } from "@atlcli/core";
import { buildCloneFields } from "./jira.js";

beforeAll(() => initJinja());

const doc = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("clone rendering", () => {
  const scope = createTemplateScope({ vars: { v: "2" }, source: { key: "A-1" } });

  test("renders summary, description and labels; --replace runs first", () => {
    const out = buildCloneFields({ summary: "R {{x}}", description: doc("{{source.key}}"), labels: ["l-{{v}}"] }, { pairs: [["{{x}}", "{{v}}"]], scope });
    expect(out.summary).toBe("R 2");
    expect(out.description).toEqual(doc("A-1"));
    expect(out.labels).toEqual(["l-2"]);
    expect(out.warnings).toEqual([]);
  });
  test("wiki markup descriptions render as wiki markup", () => {
    const out = buildCloneFields({ summary: "s", description: "{code}{{v}}{code} {{v}}" }, { pairs: [], scope });
    expect(out.description).toBe("{code}{{v}}{code} 2");
  });
  test("unknown placeholders stay and warn; strict throws", () => {
    expect(buildCloneFields({ summary: "{{nope}}" }, { pairs: [], scope }).warnings[0]!.code).toBe("unresolved");
    expect(() => buildCloneFields({ summary: "{{nope}}" }, { pairs: [], scope, strict: true })).toThrow(RenderError);
  });
});
