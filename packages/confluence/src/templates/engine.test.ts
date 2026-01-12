import { describe, test, expect } from "bun:test";
import { renderTemplate, previewTemplate, renderString } from "./engine.js";
import { createBuiltins } from "./builtins.js";
import type { Template, TemplateContext, BuiltinVariables } from "./types.js";

function createTestTemplate(content: string, metadata: Partial<Template["metadata"]> = {}): Template {
  return {
    metadata: {
      name: "test",
      description: "Test template",
      ...metadata,
    },
    content,
    location: "/test/path",
    isLocal: true,
  };
}

function createTestContext(
  variables: Record<string, unknown> = {},
  builtinOverrides: Partial<BuiltinVariables> = {}
): TemplateContext {
  const builtins: BuiltinVariables = {
    NOW: "2025-01-12T10:30:00Z",
    TODAY: "2025-01-12",
    YEAR: "2025",
    MONTH: "01",
    DAY: "12",
    TIME: "10:30",
    WEEKDAY: "Sunday",
    USER: {
      email: "test@example.com",
      displayName: "Test User",
      accountId: "123",
    },
    SPACE: {
      key: "TEST",
      name: "Test Space",
    },
    PARENT: {
      id: "456",
      title: "Parent Page",
    },
    TITLE: "Test Page",
    UUID: "test-uuid-123",
    ENV: {},
    ...builtinOverrides,
  };

  return {
    variables,
    builtins,
    spaceKey: builtins.SPACE.key,
    parentId: builtins.PARENT.id ?? undefined,
    title: builtins.TITLE,
  };
}

describe("renderTemplate", () => {
  describe("basic rendering", () => {
    test("renders plain text unchanged", () => {
      const template = createTestTemplate("Hello, world!");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Hello, world!");
    });

    test("renders simple variable", () => {
      const template = createTestTemplate("Hello, {{name}}!");
      const context = createTestContext({ name: "Alice" });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Hello, Alice!");
    });

    test("renders multiple variables", () => {
      const template = createTestTemplate("{{greeting}}, {{name}}!");
      const context = createTestContext({ greeting: "Hi", name: "Bob" });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Hi, Bob!");
    });

    test("renders nested property access", () => {
      const template = createTestTemplate("{{user.name}} ({{user.email}})");
      const context = createTestContext({
        user: { name: "Alice", email: "alice@example.com" },
      });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Alice (alice@example.com)");
    });

    test("renders undefined variable as empty", () => {
      const template = createTestTemplate("Hello, {{name}}!");
      const context = createTestContext({});
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Hello, !");
    });
  });

  describe("built-in variables", () => {
    test("renders NOW", () => {
      const template = createTestTemplate("Time: {{NOW}}");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Time: 2025-01-12T10:30:00Z");
    });

    test("renders TODAY", () => {
      const template = createTestTemplate("Date: {{TODAY}}");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Date: 2025-01-12");
    });

    test("renders USER properties", () => {
      const template = createTestTemplate("By: {{USER.displayName}}");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("By: Test User");
    });

    test("renders SPACE properties", () => {
      const template = createTestTemplate("Space: {{SPACE.key}} - {{SPACE.name}}");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Space: TEST - Test Space");
    });

    test("renders PARENT properties", () => {
      const template = createTestTemplate("Parent: {{PARENT.title}}");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Parent: Parent Page");
    });

    test("renders TITLE", () => {
      const template = createTestTemplate("# {{TITLE}}");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("# Test Page");
    });
  });

  describe("modifiers", () => {
    test("applies upper modifier", () => {
      const template = createTestTemplate("{{name | upper}}");
      const context = createTestContext({ name: "hello" });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("HELLO");
    });

    test("chains multiple modifiers", () => {
      const template = createTestTemplate("{{name | trim | upper}}");
      const context = createTestContext({ name: "  hello  " });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("HELLO");
    });

    test("applies modifier with argument", () => {
      const template = createTestTemplate("{{text | truncate:10}}");
      const context = createTestContext({ text: "Hello, this is a long text" });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Hello, ...");
    });

    test("applies date modifier", () => {
      const template = createTestTemplate("{{TODAY | date:'MMMM D, YYYY'}}");
      const context = createTestContext();
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("January 12, 2025");
    });

    test("applies array modifiers", () => {
      const template = createTestTemplate("{{items | join:', '}}");
      const context = createTestContext({ items: ["a", "b", "c"] });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("a, b, c");
    });
  });

  describe("conditionals", () => {
    test("renders if block when truthy", () => {
      const template = createTestTemplate("{{#if show}}visible{{/if}}");
      const context = createTestContext({ show: true });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("visible");
    });

    test("does not render if block when falsy", () => {
      const template = createTestTemplate("{{#if show}}visible{{/if}}");
      const context = createTestContext({ show: false });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("");
    });

    test("renders else branch when falsy", () => {
      const template = createTestTemplate("{{#if show}}yes{{else}}no{{/if}}");
      const context = createTestContext({ show: false });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("no");
    });

    test("treats empty string as falsy", () => {
      const template = createTestTemplate("{{#if value}}has{{else}}empty{{/if}}");
      const context = createTestContext({ value: "" });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("empty");
    });

    test("treats empty array as falsy", () => {
      const template = createTestTemplate("{{#if items}}has{{else}}empty{{/if}}");
      const context = createTestContext({ items: [] });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("empty");
    });

    test("unless inverts condition", () => {
      const template = createTestTemplate("{{#unless hidden}}visible{{/if}}");
      const context = createTestContext({ hidden: false });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("visible");
    });

    test("condition with modifier", () => {
      const template = createTestTemplate("{{#if status | eq:'active'}}active{{/if}}");
      const context = createTestContext({ status: "active" });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("active");
    });

    test("nested conditionals", () => {
      const template = createTestTemplate("{{#if a}}{{#if b}}both{{/if}}{{/if}}");
      const context = createTestContext({ a: true, b: true });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("both");
    });
  });

  describe("loops", () => {
    test("renders each item", () => {
      const template = createTestTemplate("{{#each items}}- {{this}}\n{{/each}}");
      const context = createTestContext({ items: ["a", "b", "c"] });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("- a\n- b\n- c\n");
    });

    test("provides @index", () => {
      const template = createTestTemplate("{{#each items}}{{@index}}: {{this}}\n{{/each}}");
      const context = createTestContext({ items: ["a", "b"] });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("0: a\n1: b\n");
    });

    test("provides @number", () => {
      const template = createTestTemplate("{{#each items}}{{@number}}. {{this}}\n{{/each}}");
      const context = createTestContext({ items: ["a", "b"] });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("1. a\n2. b\n");
    });

    test("provides @first and @last", () => {
      const template = createTestTemplate(
        "{{#each items}}{{#if @first}}[{{/if}}{{this}}{{#if @last}}]{{/if}}{{/each}}"
      );
      const context = createTestContext({ items: ["a", "b", "c"] });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("[abc]");
    });

    test("accesses object properties with this", () => {
      const template = createTestTemplate("{{#each users}}{{this.name}}: {{this.email}}\n{{/each}}");
      const context = createTestContext({
        users: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
      });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("Alice: alice@example.com\nBob: bob@example.com\n");
    });

    test("renders else for empty array", () => {
      const template = createTestTemplate("{{#each items}}{{this}}{{else}}No items{{/each}}");
      const context = createTestContext({ items: [] });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("No items");
    });

    test("splits string into array", () => {
      const template = createTestTemplate("{{#each tags}}- {{this}}\n{{/each}}");
      const context = createTestContext({ tags: "a,b,c" });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("- a\n- b\n- c\n");
    });

    test("nested loops", () => {
      const template = createTestTemplate(
        "{{#each groups}}## {{this.name}}\n{{#each this.items}}- {{this}}\n{{/each}}{{/each}}"
      );
      const context = createTestContext({
        groups: [
          { name: "A", items: ["a1", "a2"] },
          { name: "B", items: ["b1"] },
        ],
      });
      const result = renderTemplate(template, context);
      expect(result.markdown).toBe("## A\n- a1\n- a2\n## B\n- b1\n");
    });
  });

  describe("complex templates", () => {
    test("renders meeting notes template", () => {
      const template = createTestTemplate(`# {{TITLE}}

**Date:** {{meeting_date | date:'MMMM D, YYYY'}}
**Attendees:**
{{#each attendees}}
- {{this}}
{{/each}}

## Notes
{{notes}}`);
      const context = createTestContext({
        meeting_date: "2025-01-12",
        attendees: ["Alice", "Bob", "Charlie"],
        notes: "Discussed roadmap",
      });
      const result = renderTemplate(template, context);

      expect(result.markdown).toContain("# Test Page");
      expect(result.markdown).toContain("January 12, 2025");
      expect(result.markdown).toContain("- Alice");
      expect(result.markdown).toContain("- Bob");
      expect(result.markdown).toContain("- Charlie");
      expect(result.markdown).toContain("Discussed roadmap");
    });
  });

  describe("metadata", () => {
    test("returns context values", () => {
      const template = createTestTemplate("content");
      const context = createTestContext();
      const result = renderTemplate(template, context);

      expect(result.title).toBe("Test Page");
      expect(result.spaceKey).toBe("TEST");
      expect(result.parentId).toBe("456");
    });

    test("renders labels with variables", () => {
      const template = createTestTemplate("content", {
        target: {
          labels: ["static", "{{type}}-doc"],
        },
      });
      const context = createTestContext({ type: "api" });
      const result = renderTemplate(template, context);

      expect(result.labels).toEqual(["static", "api-doc"]);
    });
  });
});

describe("previewTemplate", () => {
  test("renders template with provided values", () => {
    const template = createTestTemplate("Hello, {{name}}!");
    const builtins = createBuiltins({
      title: "Preview Page",
      spaceKey: "PREV",
    });
    const result = previewTemplate(template, { name: "Preview" }, builtins);

    expect(result.markdown).toBe("Hello, Preview!");
    expect(result.title).toBe("Preview Page");
    expect(result.spaceKey).toBe("PREV");
  });
});

describe("renderString", () => {
  test("renders simple string with variables", () => {
    const context = createTestContext({ name: "Test" });
    const result = renderString("Hello, {{name}}!", context);
    expect(result).toBe("Hello, Test!");
  });

  test("returns unchanged string without variables", () => {
    const context = createTestContext();
    const result = renderString("Hello, world!", context);
    expect(result).toBe("Hello, world!");
  });

  test("applies modifiers", () => {
    const context = createTestContext({ name: "test" });
    const result = renderString("{{name | upper}}", context);
    expect(result).toBe("TEST");
  });
});
