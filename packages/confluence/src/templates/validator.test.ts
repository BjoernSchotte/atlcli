import { describe, test, expect } from "bun:test";
import {
  validateTemplate,
  validateVariableValues,
  getRequiredVariables,
  getPromptableVariables,
} from "./validator.js";
import type { Template, TemplateVariable } from "./types.js";

function createTestTemplate(
  content: string,
  options: {
    name?: string;
    description?: string;
    variables?: TemplateVariable[];
    version?: string;
    target?: Template["metadata"]["target"];
  } = {}
): Template {
  return {
    metadata: {
      name: options.name ?? "test-template",
      description: options.description ?? "Test description",
      version: options.version,
      variables: options.variables,
      target: options.target,
    },
    content,
    location: "/test/path",
    isLocal: true,
  };
}

describe("validateTemplate", () => {
  describe("metadata validation", () => {
    test("valid template passes", () => {
      const template = createTestTemplate("Hello {{name}}", {
        name: "valid-template",
        description: "A valid template",
        variables: [{ name: "name", prompt: "Enter name", type: "string" }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("requires template name", () => {
      const template = createTestTemplate("content", { name: "" });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "name")).toBe(true);
    });

    test("validates template name format", () => {
      const template = createTestTemplate("content", { name: "123-invalid" });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "name")).toBe(true);
    });

    test("requires template description", () => {
      const template = createTestTemplate("content", { description: "" });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "description")).toBe(true);
    });

    test("validates semver version format", () => {
      const template = createTestTemplate("content", { version: "invalid" });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "version")).toBe(true);
    });

    test("accepts valid semver", () => {
      const template = createTestTemplate("content", { version: "1.0.0" });
      const result = validateTemplate(template);
      expect(result.errors.filter((e) => e.field === "version")).toHaveLength(0);
    });

    test("validates space key format", () => {
      const template = createTestTemplate("content", {
        target: { space: "invalid-space" },
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "target.space")).toBe(true);
    });

    test("validates label format", () => {
      const template = createTestTemplate("content", {
        target: { labels: ["valid", "has spaces"] },
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === "target.labels")).toBe(true);
    });

    test("allows labels with variables", () => {
      const template = createTestTemplate("content", {
        target: { labels: ["valid", "{{type}}-doc"] },
      });
      const result = validateTemplate(template);
      expect(result.errors.filter((e) => e.field === "target.labels")).toHaveLength(0);
    });
  });

  describe("variable definition validation", () => {
    test("detects duplicate variable names", () => {
      const template = createTestTemplate("{{name}}", {
        variables: [
          { name: "name", prompt: "First", type: "string" },
          { name: "name", prompt: "Second", type: "string" },
        ],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
    });

    test("validates variable name format", () => {
      const template = createTestTemplate("{{123}}", {
        variables: [{ name: "123", prompt: "Invalid", type: "string" }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Invalid variable name"))).toBe(true);
    });

    test("prevents builtin name conflicts", () => {
      const template = createTestTemplate("{{NOW}}", {
        variables: [{ name: "NOW", prompt: "Time", type: "string" }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("built-in"))).toBe(true);
    });

    test("requires variable prompt", () => {
      const template = createTestTemplate("{{name}}", {
        variables: [{ name: "name", prompt: "", type: "string" }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("prompt"))).toBe(true);
    });

    test("validates choice variables have choices", () => {
      const template = createTestTemplate("{{opt}}", {
        variables: [{ name: "opt", prompt: "Choice", type: "choice" }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("at least one choice"))).toBe(true);
    });

    test("validates choice default is valid option", () => {
      const template = createTestTemplate("{{opt}}", {
        variables: [
          {
            name: "opt",
            prompt: "Choice",
            type: "choice",
            choices: [{ value: "a", label: "A" }],
            default: "invalid",
          },
        ],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("not a valid choice"))).toBe(true);
    });

    test("validates number min/max", () => {
      const template = createTestTemplate("{{num}}", {
        variables: [{ name: "num", prompt: "Number", type: "number", min: 10, max: 5 }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("min > max"))).toBe(true);
    });

    test("validates number default in range", () => {
      const template = createTestTemplate("{{num}}", {
        variables: [{ name: "num", prompt: "Number", type: "number", min: 1, max: 10, default: 20 }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("above maximum"))).toBe(true);
    });

    test("validates regex pattern", () => {
      const template = createTestTemplate("{{text}}", {
        variables: [{ name: "text", prompt: "Text", type: "string", pattern: "[invalid" }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Invalid regex"))).toBe(true);
    });
  });

  describe("content validation", () => {
    test("detects undefined variables", () => {
      const template = createTestTemplate("Hello {{undefined_var}}");
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Undefined variable"))).toBe(true);
    });

    test("allows builtin variables without definition", () => {
      const template = createTestTemplate("Date: {{TODAY}}");
      const result = validateTemplate(template);
      expect(result.errors.filter((e) => e.type === "syntax")).toHaveLength(0);
    });

    test("allows this and loop context", () => {
      const template = createTestTemplate("{{#each items}}{{this}} {{@index}}{{/each}}", {
        variables: [{ name: "items", prompt: "Items", type: "list" }],
      });
      const result = validateTemplate(template);
      expect(result.errors.filter((e) => e.type === "syntax")).toHaveLength(0);
    });

    test("detects unknown modifiers", () => {
      const template = createTestTemplate("{{name | unknownModifier}}", {
        variables: [{ name: "name", prompt: "Name", type: "string" }],
      });
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Unknown modifier"))).toBe(true);
    });

    test("detects unclosed blocks", () => {
      const template = createTestTemplate("{{#if show}}content");
      const result = validateTemplate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Unclosed block"))).toBe(true);
    });
  });
});

describe("validateVariableValues", () => {
  test("validates required variables", () => {
    const definitions: TemplateVariable[] = [
      { name: "required_var", prompt: "Required", type: "string", required: true },
    ];
    const result = validateVariableValues({}, definitions);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("missing"))).toBe(true);
  });

  test("allows missing optional variables", () => {
    const definitions: TemplateVariable[] = [
      { name: "optional_var", prompt: "Optional", type: "string" },
    ];
    const result = validateVariableValues({}, definitions);
    expect(result.valid).toBe(true);
  });

  test("validates number type", () => {
    const definitions: TemplateVariable[] = [
      { name: "num", prompt: "Number", type: "number" },
    ];
    const result = validateVariableValues({ num: "not a number" }, definitions);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("must be a number"))).toBe(true);
  });

  test("validates number range", () => {
    const definitions: TemplateVariable[] = [
      { name: "num", prompt: "Number", type: "number", min: 1, max: 10 },
    ];

    const tooLow = validateVariableValues({ num: 0 }, definitions);
    expect(tooLow.valid).toBe(false);
    expect(tooLow.errors.some((e) => e.message.includes("at least 1"))).toBe(true);

    const tooHigh = validateVariableValues({ num: 20 }, definitions);
    expect(tooHigh.valid).toBe(false);
    expect(tooHigh.errors.some((e) => e.message.includes("at most 10"))).toBe(true);

    const valid = validateVariableValues({ num: 5 }, definitions);
    expect(valid.valid).toBe(true);
  });

  test("validates boolean type", () => {
    const definitions: TemplateVariable[] = [
      { name: "flag", prompt: "Flag", type: "boolean" },
    ];
    const result = validateVariableValues({ flag: "invalid" }, definitions);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("must be a boolean"))).toBe(true);
  });

  test("validates choice values", () => {
    const definitions: TemplateVariable[] = [
      {
        name: "choice",
        prompt: "Choice",
        type: "choice",
        choices: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
    ];

    const invalid = validateVariableValues({ choice: "c" }, definitions);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((e) => e.message.includes("must be one of"))).toBe(true);

    const valid = validateVariableValues({ choice: "a" }, definitions);
    expect(valid.valid).toBe(true);
  });

  test("validates string length", () => {
    const definitions: TemplateVariable[] = [
      { name: "text", prompt: "Text", type: "string", min: 3, max: 10 },
    ];

    const tooShort = validateVariableValues({ text: "ab" }, definitions);
    expect(tooShort.valid).toBe(false);
    expect(tooShort.errors.some((e) => e.message.includes("at least 3 characters"))).toBe(true);

    const tooLong = validateVariableValues({ text: "12345678901" }, definitions);
    expect(tooLong.valid).toBe(false);
    expect(tooLong.errors.some((e) => e.message.includes("at most 10 characters"))).toBe(true);
  });

  test("validates string pattern", () => {
    const definitions: TemplateVariable[] = [
      { name: "code", prompt: "Code", type: "string", pattern: "^[A-Z]{3}$" },
    ];

    const invalid = validateVariableValues({ code: "abc" }, definitions);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((e) => e.message.includes("does not match pattern"))).toBe(true);

    const valid = validateVariableValues({ code: "ABC" }, definitions);
    expect(valid.valid).toBe(true);
  });

  test("validates list length", () => {
    const definitions: TemplateVariable[] = [
      { name: "items", prompt: "Items", type: "list", min: 1, max: 3 },
    ];

    const tooFew = validateVariableValues({ items: [] }, definitions);
    expect(tooFew.valid).toBe(false);
    expect(tooFew.errors.some((e) => e.message.includes("at least 1 items"))).toBe(true);

    const tooMany = validateVariableValues({ items: ["a", "b", "c", "d"] }, definitions);
    expect(tooMany.valid).toBe(false);
    expect(tooMany.errors.some((e) => e.message.includes("at most 3 items"))).toBe(true);
  });

  test("parses string as list with separator", () => {
    const definitions: TemplateVariable[] = [
      { name: "items", prompt: "Items", type: "list", separator: ",", min: 2 },
    ];

    const valid = validateVariableValues({ items: "a, b, c" }, definitions);
    expect(valid.valid).toBe(true);

    const tooFew = validateVariableValues({ items: "a" }, definitions);
    expect(tooFew.valid).toBe(false);
  });
});

describe("getRequiredVariables", () => {
  test("returns required variables without defaults", () => {
    const template = createTestTemplate("content", {
      variables: [
        { name: "required", prompt: "Required", type: "string", required: true },
        { name: "required_with_default", prompt: "Default", type: "string", required: true, default: "value" },
        { name: "optional", prompt: "Optional", type: "string" },
      ],
    });
    const required = getRequiredVariables(template);
    expect(required).toHaveLength(1);
    expect(required[0].name).toBe("required");
  });

  test("returns empty for template without variables", () => {
    const template = createTestTemplate("content");
    const required = getRequiredVariables(template);
    expect(required).toHaveLength(0);
  });
});

describe("getPromptableVariables", () => {
  test("returns variables needing prompting", () => {
    const template = createTestTemplate("content", {
      variables: [
        { name: "required", prompt: "Required", type: "string", required: true },
        { name: "optional_no_default", prompt: "Optional", type: "string" },
        { name: "with_default", prompt: "Default", type: "string", default: "value" },
      ],
    });

    const promptable = getPromptableVariables(template, {});
    expect(promptable).toHaveLength(2);
    expect(promptable.map((v) => v.name)).toContain("required");
    expect(promptable.map((v) => v.name)).toContain("optional_no_default");
  });

  test("excludes already provided values", () => {
    const template = createTestTemplate("content", {
      variables: [
        { name: "a", prompt: "A", type: "string", required: true },
        { name: "b", prompt: "B", type: "string", required: true },
      ],
    });

    const promptable = getPromptableVariables(template, { a: "provided" });
    expect(promptable).toHaveLength(1);
    expect(promptable[0].name).toBe("b");
  });
});
