import { describe, test, expect } from "bun:test";
import { parseTemplate, extractVariableNames, extractModifierNames } from "./parser.js";

describe("parseTemplate", () => {
  describe("text parsing", () => {
    test("parses plain text", () => {
      const result = parseTemplate("Hello, world!");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe("text");
      expect((result.nodes[0] as any).content).toBe("Hello, world!");
    });

    test("parses multiline text", () => {
      const result = parseTemplate("Line 1\nLine 2\nLine 3");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe("text");
    });

    test("handles empty content", () => {
      const result = parseTemplate("");
      expect(result.nodes).toHaveLength(0);
    });
  });

  describe("variable parsing", () => {
    test("parses simple variable", () => {
      const result = parseTemplate("Hello, {{name}}!");
      expect(result.nodes).toHaveLength(3);
      expect(result.nodes[0].type).toBe("text");
      expect(result.nodes[1].type).toBe("variable");
      expect((result.nodes[1] as any).name).toBe("name");
      expect(result.nodes[2].type).toBe("text");
    });

    test("parses variable at start", () => {
      const result = parseTemplate("{{greeting}} world");
      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0].type).toBe("variable");
      expect((result.nodes[0] as any).name).toBe("greeting");
    });

    test("parses variable at end", () => {
      const result = parseTemplate("Hello {{name}}");
      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[1].type).toBe("variable");
    });

    test("parses multiple variables", () => {
      const result = parseTemplate("{{first}} and {{second}}");
      expect(result.variables.has("first")).toBe(true);
      expect(result.variables.has("second")).toBe(true);
    });

    test("parses nested property access", () => {
      const result = parseTemplate("{{user.name}}");
      expect(result.nodes).toHaveLength(1);
      expect((result.nodes[0] as any).name).toBe("user.name");
      expect(result.variables.has("user")).toBe(true);
    });

    test("parses variable with whitespace", () => {
      const result = parseTemplate("{{ name }}");
      expect(result.nodes).toHaveLength(1);
      expect((result.nodes[0] as any).name).toBe("name");
    });
  });

  describe("modifier parsing", () => {
    test("parses single modifier", () => {
      const result = parseTemplate("{{name | upper}}");
      const node = result.nodes[0] as any;
      expect(node.modifiers).toHaveLength(1);
      expect(node.modifiers[0].name).toBe("upper");
      expect(node.modifiers[0].args).toHaveLength(0);
    });

    test("parses modifier with argument", () => {
      const result = parseTemplate("{{text | truncate:50}}");
      const node = result.nodes[0] as any;
      expect(node.modifiers[0].name).toBe("truncate");
      expect(node.modifiers[0].args).toEqual(["50"]);
    });

    test("parses modifier with multiple arguments", () => {
      const result = parseTemplate("{{date | date:'YYYY-MM-DD'}}");
      const node = result.nodes[0] as any;
      expect(node.modifiers[0].name).toBe("date");
      expect(node.modifiers[0].args[0]).toBe("YYYY-MM-DD");
    });

    test("parses chained modifiers", () => {
      const result = parseTemplate("{{name | trim | upper}}");
      const node = result.nodes[0] as any;
      expect(node.modifiers).toHaveLength(2);
      expect(node.modifiers[0].name).toBe("trim");
      expect(node.modifiers[1].name).toBe("upper");
    });

    test("tracks used modifiers", () => {
      const result = parseTemplate("{{a | upper}} {{b | lower | trim}}");
      expect(result.modifiers.has("upper")).toBe(true);
      expect(result.modifiers.has("lower")).toBe(true);
      expect(result.modifiers.has("trim")).toBe(true);
    });
  });

  describe("conditional parsing", () => {
    test("parses simple if block", () => {
      const result = parseTemplate("{{#if show}}visible{{/if}}");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe("conditional");
      const node = result.nodes[0] as any;
      expect(node.condition.name).toBe("show");
      expect(node.inverse).toBe(false);
    });

    test("parses if-else block", () => {
      const result = parseTemplate("{{#if show}}yes{{else}}no{{/if}}");
      const node = result.nodes[0] as any;
      expect(node.consequent).toHaveLength(1);
      expect(node.alternate).toHaveLength(1);
      expect((node.consequent[0] as any).content).toBe("yes");
      expect((node.alternate[0] as any).content).toBe("no");
    });

    test("parses unless block", () => {
      const result = parseTemplate("{{#unless hidden}}visible{{/if}}");
      const node = result.nodes[0] as any;
      expect(node.type).toBe("conditional");
      expect(node.inverse).toBe(true);
    });

    test("parses condition with modifier", () => {
      const result = parseTemplate("{{#if items | length}}has items{{/if}}");
      const node = result.nodes[0] as any;
      expect(node.condition.modifiers).toHaveLength(1);
      expect(node.condition.modifiers[0].name).toBe("length");
    });

    test("parses nested conditionals", () => {
      const result = parseTemplate("{{#if a}}{{#if b}}both{{/if}}{{/if}}");
      const outer = result.nodes[0] as any;
      expect(outer.consequent).toHaveLength(1);
      expect(outer.consequent[0].type).toBe("conditional");
    });
  });

  describe("loop parsing", () => {
    test("parses simple each block", () => {
      const result = parseTemplate("{{#each items}}{{this}}{{/each}}");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe("loop");
      const node = result.nodes[0] as any;
      expect(node.iterable).toBe("items");
    });

    test("parses each with else", () => {
      const result = parseTemplate("{{#each items}}{{this}}{{else}}empty{{/each}}");
      const node = result.nodes[0] as any;
      expect(node.body).toHaveLength(1);
      expect(node.empty).toHaveLength(1);
    });

    test("parses nested loops", () => {
      const result = parseTemplate("{{#each outer}}{{#each inner}}{{this}}{{/each}}{{/each}}");
      const outer = result.nodes[0] as any;
      expect(outer.body).toHaveLength(1);
      expect(outer.body[0].type).toBe("loop");
    });

    test("tracks iterable as variable", () => {
      const result = parseTemplate("{{#each items}}{{this}}{{/each}}");
      expect(result.variables.has("items")).toBe(true);
    });
  });

  describe("complex templates", () => {
    test("parses mixed content", () => {
      const template = `# {{title}}

{{#if description}}
{{description}}
{{/if}}

{{#each items}}
- {{this}}
{{/each}}`;
      const result = parseTemplate(template);
      expect(result.variables.has("title")).toBe(true);
      expect(result.variables.has("description")).toBe(true);
      expect(result.variables.has("items")).toBe(true);
    });
  });
});

describe("extractVariableNames", () => {
  test("extracts simple variables", () => {
    const names = extractVariableNames("Hello {{name}}, welcome to {{place}}");
    expect(names).toContain("name");
    expect(names).toContain("place");
  });

  test("extracts nested properties as root variable", () => {
    const names = extractVariableNames("{{user.name}} - {{user.email}}");
    expect(names).toContain("user");
    expect(names).not.toContain("user.name");
  });

  test("extracts from conditionals", () => {
    const names = extractVariableNames("{{#if active}}active{{/if}}");
    expect(names).toContain("active");
  });

  test("extracts from loops", () => {
    const names = extractVariableNames("{{#each items}}{{this}}{{/each}}");
    expect(names).toContain("items");
  });
});

describe("extractModifierNames", () => {
  test("extracts modifier names", () => {
    const names = extractModifierNames("{{name | upper | trim}}");
    expect(names).toContain("upper");
    expect(names).toContain("trim");
  });

  test("extracts modifiers with arguments", () => {
    const names = extractModifierNames("{{text | truncate:50}}");
    expect(names).toContain("truncate");
  });

  test("extracts from conditionals", () => {
    const names = extractModifierNames("{{#if items | length}}has{{/if}}");
    expect(names).toContain("length");
  });
});
