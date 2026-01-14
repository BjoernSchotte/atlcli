import { describe, expect, test } from "bun:test";
import {
  parseTemplate,
  serializeTemplate,
  hasFrontmatter,
} from "./parser.js";
import { getBuiltinVariables, formatDate } from "./builtins.js";
import {
  validateVariableValue,
  validateTemplate,
  extractUsedVariables,
} from "./validation.js";
import { TemplateEngine } from "./engine.js";
import type { Template, TemplateVariable } from "./types.js";

describe("parser", () => {
  test("parseTemplate with frontmatter", () => {
    const raw = `---
name: test-template
description: A test template
variables:
  - name: title
    type: string
    required: true
---
# {{title}}

Content here.`;

    const result = parseTemplate(raw);
    expect(result.metadata.name).toBe("test-template");
    expect(result.metadata.description).toBe("A test template");
    expect(result.metadata.variables).toHaveLength(1);
    expect(result.metadata.variables![0].name).toBe("title");
    expect(result.content).toBe("# {{title}}\n\nContent here.");
  });

  test("parseTemplate without frontmatter", () => {
    const raw = "Just some content without frontmatter.";
    const result = parseTemplate(raw);
    expect(result.metadata.name).toBe("");
    expect(result.content).toBe("Just some content without frontmatter.");
  });

  test("serializeTemplate", () => {
    const metadata = {
      name: "my-template",
      description: "Description",
      variables: [{ name: "foo", type: "string" as const }],
    };
    const content = "# Hello {{foo}}";
    const serialized = serializeTemplate(metadata, content);

    expect(serialized).toContain("---");
    expect(serialized).toContain("name: my-template");
    expect(serialized).toContain("# Hello {{foo}}");
  });

  test("hasFrontmatter", () => {
    expect(hasFrontmatter("---\nname: test\n---\nContent")).toBe(true);
    expect(hasFrontmatter("No frontmatter here")).toBe(false);
  });
});

describe("builtins", () => {
  test("formatDate", () => {
    const date = new Date("2026-01-15T10:30:00Z");
    expect(formatDate(date, "YYYY-MM-DD")).toBe("2026-01-15");
    expect(formatDate(date, "DD.MM.YYYY")).toBe("15.01.2026");
  });

  test("getBuiltinVariables", () => {
    const builtins = getBuiltinVariables({
      user: "John Doe",
      space: "TEAM",
      profile: "work",
      dateFormat: "YYYY-MM-DD",
    });

    expect(builtins.user).toBe("John Doe");
    expect(builtins.space).toBe("TEAM");
    expect(builtins.profile).toBe("work");
    expect(builtins.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(builtins.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("validation", () => {
  test("validateVariableValue - string", () => {
    const variable: TemplateVariable = { name: "test", type: "string" };
    expect(validateVariableValue("hello", variable).valid).toBe(true);
    expect(validateVariableValue(123, variable).valid).toBe(true);
  });

  test("validateVariableValue - number", () => {
    const variable: TemplateVariable = { name: "count", type: "number" };
    expect(validateVariableValue("42", variable).valid).toBe(true);
    expect(validateVariableValue("42", variable).coerced).toBe(42);
    expect(validateVariableValue("not-a-number", variable).valid).toBe(false);
  });

  test("validateVariableValue - date", () => {
    const variable: TemplateVariable = { name: "date", type: "date" };
    expect(validateVariableValue("2026-01-15", variable).valid).toBe(true);
    expect(validateVariableValue("today", variable).valid).toBe(true);
    expect(validateVariableValue("invalid-date", variable).valid).toBe(false);
  });

  test("validateVariableValue - boolean", () => {
    const variable: TemplateVariable = { name: "enabled", type: "boolean" };
    expect(validateVariableValue("true", variable).coerced).toBe(true);
    expect(validateVariableValue("yes", variable).coerced).toBe(true);
    expect(validateVariableValue("1", variable).coerced).toBe(true);
    expect(validateVariableValue("false", variable).coerced).toBe(false);
    expect(validateVariableValue("no", variable).coerced).toBe(false);
    expect(validateVariableValue("maybe", variable).valid).toBe(false);
  });

  test("validateVariableValue - select", () => {
    const variable: TemplateVariable = {
      name: "type",
      type: "select",
      options: ["a", "b", "c"],
    };
    expect(validateVariableValue("a", variable).valid).toBe(true);
    expect(validateVariableValue("d", variable).valid).toBe(false);
  });

  test("validateVariableValue - required", () => {
    const variable: TemplateVariable = {
      name: "required",
      type: "string",
      required: true,
    };
    expect(validateVariableValue("", variable).valid).toBe(false);
    expect(validateVariableValue(undefined, variable).valid).toBe(false);
  });

  test("validateVariableValue - required with default", () => {
    const variable: TemplateVariable = {
      name: "withDefault",
      type: "string",
      required: true,
      default: "fallback",
    };
    expect(validateVariableValue("", variable).valid).toBe(true);
    expect(validateVariableValue("", variable).coerced).toBe("fallback");
  });

  test("extractUsedVariables", () => {
    const content = `
# {{title}}
Date: {{@date}}
{{#if showDetails}}
Details: {{details}}
{{/if}}
{{#each items}}...{{/each}}
`;
    const vars = extractUsedVariables(content);
    expect(vars.has("title")).toBe(true);
    expect(vars.has("date")).toBe(true); // @date extracts as "date"
    expect(vars.has("showDetails")).toBe(true);
    expect(vars.has("details")).toBe(true);
    expect(vars.has("items")).toBe(true);
  });

  test("validateTemplate - missing variables", () => {
    const template: Template = {
      metadata: {
        name: "test",
        variables: [
          { name: "declared", type: "string" },
          { name: "unused", type: "string" },
        ],
      },
      content: "{{declared}} {{undeclared}}",
      source: { level: "global", path: "" },
    };

    const result = validateTemplate(template);
    expect(result.warnings.some((w) => w.message.includes("undeclared"))).toBe(true);
    expect(result.warnings.some((w) => w.message.includes("unused"))).toBe(true);
  });

  test("validateTemplate - select without options", () => {
    const template: Template = {
      metadata: {
        name: "test",
        variables: [{ name: "badSelect", type: "select" }],
      },
      content: "{{badSelect}}",
      source: { level: "global", path: "" },
    };

    const result = validateTemplate(template);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("options"))).toBe(true);
  });
});

describe("engine", () => {
  test("render simple template", () => {
    const engine = new TemplateEngine();
    const template: Template = {
      metadata: {
        name: "test",
        variables: [{ name: "title", type: "string" }],
      },
      content: "# {{title}}",
      source: { level: "global", path: "" },
    };

    const result = engine.render(template, {
      variables: { title: "Hello World" },
      builtins: {},
    });

    expect(result.content).toBe("# Hello World");
    expect(result.usedVariables).toContain("title");
  });

  test("render with inline defaults", () => {
    const engine = new TemplateEngine();
    const template: Template = {
      metadata: {
        name: "test",
        variables: [{ name: "name", type: "string" }],
      },
      content: "Hello {{name \"Guest\"}}!",
      source: { level: "global", path: "" },
    };

    // Without providing name
    const result1 = engine.render(template, {
      variables: {},
      builtins: {},
    });
    expect(result1.content).toBe("Hello Guest!");

    // With name provided
    const result2 = engine.render(template, {
      variables: { name: "John" },
      builtins: {},
    });
    expect(result2.content).toBe("Hello John!");
  });

  test("render with built-in @variables", () => {
    const engine = new TemplateEngine();
    const template: Template = {
      metadata: { name: "test" },
      content: "User: {{@user}}, Space: {{@space}}",
      source: { level: "global", path: "" },
    };

    const result = engine.render(template, {
      variables: {},
      builtins: { user: "Alice", space: "TEAM" },
    });

    expect(result.content).toBe("User: Alice, Space: TEAM");
  });

  test("render with helpers", () => {
    const engine = new TemplateEngine();
    const template: Template = {
      metadata: {
        name: "test",
        variables: [{ name: "text", type: "string" }],
      },
      content: "{{lowercase text}} / {{uppercase text}}",
      source: { level: "global", path: "" },
    };

    const result = engine.render(template, {
      variables: { text: "Hello" },
      builtins: {},
    });

    expect(result.content).toBe("hello / HELLO");
  });

  test("render with conditionals", () => {
    const engine = new TemplateEngine();
    const template: Template = {
      metadata: {
        name: "test",
        variables: [
          { name: "showExtra", type: "boolean" },
          { name: "extra", type: "string" },
        ],
      },
      content: "Base{{#if showExtra}} - {{extra}}{{/if}}",
      source: { level: "global", path: "" },
    };

    const result1 = engine.render(template, {
      variables: { showExtra: true, extra: "More" },
      builtins: {},
    });
    expect(result1.content).toBe("Base - More");

    const result2 = engine.render(template, {
      variables: { showExtra: false, extra: "More" },
      builtins: {},
    });
    expect(result2.content).toBe("Base");
  });

  test("validate template with syntax error", () => {
    const engine = new TemplateEngine();
    const template: Template = {
      metadata: { name: "test" },
      content: "{{#if broken}",
      source: { level: "global", path: "" },
    };

    const result = engine.validate(template);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "handlebars")).toBe(true);
  });

  test("validateContent", () => {
    const engine = new TemplateEngine();

    const validResult = engine.validateContent("Hello {{name}}");
    expect(validResult.valid).toBe(true);

    const invalidResult = engine.validateContent("{{#if broken}");
    expect(invalidResult.valid).toBe(false);
  });
});
