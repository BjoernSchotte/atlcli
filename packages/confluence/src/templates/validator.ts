/**
 * Template validation utilities.
 */

import type {
  Template,
  TemplateMetadata,
  TemplateVariable,
  ValidationResult,
  ValidationError,
} from "./types.js";
import { parseTemplate, extractModifierNames } from "./parser.js";
import { defaultModifiers } from "./modifiers.js";
import { isBuiltinVariable } from "./builtins.js";

/**
 * Validate a template for correctness.
 */
export function validateTemplate(template: Template): ValidationResult {
  const errors: ValidationError[] = [];

  // Validate metadata
  validateMetadata(template.metadata, errors);

  // Validate variables
  if (template.metadata.variables) {
    validateVariableDefinitions(template.metadata.variables, errors);
  }

  // Validate content syntax
  validateContent(template.content, template.metadata.variables ?? [], errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate template metadata.
 */
function validateMetadata(metadata: TemplateMetadata, errors: ValidationError[]): void {
  // Name is required
  if (!metadata.name || metadata.name.trim() === "") {
    errors.push({
      type: "metadata",
      message: "Template name is required",
      field: "name",
    });
  } else if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(metadata.name)) {
    errors.push({
      type: "metadata",
      message:
        "Template name must start with a letter and contain only letters, numbers, underscores, and hyphens",
      field: "name",
    });
  }

  // Description is required
  if (!metadata.description || metadata.description.trim() === "") {
    errors.push({
      type: "metadata",
      message: "Template description is required",
      field: "description",
    });
  }

  // Validate version if provided
  if (metadata.version && !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(metadata.version)) {
    errors.push({
      type: "metadata",
      message: "Template version must be a valid semver (e.g., 1.0.0)",
      field: "version",
    });
  }

  // Validate target if provided
  if (metadata.target) {
    if (metadata.target.space && !/^[A-Z][A-Z0-9]*$/.test(metadata.target.space)) {
      errors.push({
        type: "metadata",
        message: "Target space key must be uppercase letters and numbers",
        field: "target.space",
      });
    }

    if (metadata.target.labels) {
      for (const label of metadata.target.labels) {
        if (!/^[a-zA-Z0-9_-]+$/.test(label) && !label.includes("{{")) {
          errors.push({
            type: "metadata",
            message: `Invalid label format: "${label}"`,
            field: "target.labels",
          });
        }
      }
    }
  }
}

/**
 * Validate variable definitions.
 */
function validateVariableDefinitions(
  variables: TemplateVariable[],
  errors: ValidationError[]
): void {
  const seen = new Set<string>();

  for (const variable of variables) {
    // Check for duplicate names
    if (seen.has(variable.name)) {
      errors.push({
        type: "variable",
        message: `Duplicate variable name: "${variable.name}"`,
        variable: variable.name,
      });
    }
    seen.add(variable.name);

    // Validate name format
    if (!variable.name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(variable.name)) {
      errors.push({
        type: "variable",
        message: `Invalid variable name: "${variable.name}"`,
        variable: variable.name,
      });
    }

    // Check for reserved names (builtins)
    if (isBuiltinVariable(variable.name)) {
      errors.push({
        type: "variable",
        message: `Variable name "${variable.name}" conflicts with a built-in variable`,
        variable: variable.name,
      });
    }

    // Validate prompt
    if (!variable.prompt || variable.prompt.trim() === "") {
      errors.push({
        type: "variable",
        message: `Variable "${variable.name}" must have a prompt`,
        variable: variable.name,
      });
    }

    // Validate type-specific rules
    validateVariableType(variable, errors);
  }
}

/**
 * Validate type-specific variable rules.
 */
function validateVariableType(variable: TemplateVariable, errors: ValidationError[]): void {
  switch (variable.type) {
    case "choice":
      if (!variable.choices || variable.choices.length === 0) {
        errors.push({
          type: "variable",
          message: `Choice variable "${variable.name}" must have at least one choice`,
          variable: variable.name,
        });
      } else {
        const values = new Set<string>();
        for (const choice of variable.choices) {
          if (!choice.value) {
            errors.push({
              type: "variable",
              message: `Choice in "${variable.name}" must have a value`,
              variable: variable.name,
            });
          }
          if (values.has(choice.value)) {
            errors.push({
              type: "variable",
              message: `Duplicate choice value "${choice.value}" in "${variable.name}"`,
              variable: variable.name,
            });
          }
          values.add(choice.value);
        }

        // Validate default is one of the choices
        if (variable.default !== undefined) {
          const validValues = variable.choices.map((c) => c.value);
          if (!validValues.includes(String(variable.default))) {
            errors.push({
              type: "variable",
              message: `Default value "${variable.default}" is not a valid choice for "${variable.name}"`,
              variable: variable.name,
            });
          }
        }
      }
      break;

    case "number":
      if (variable.min !== undefined && variable.max !== undefined && variable.min > variable.max) {
        errors.push({
          type: "variable",
          message: `Variable "${variable.name}" has min > max`,
          variable: variable.name,
        });
      }
      if (variable.default !== undefined) {
        const defaultNum = Number(variable.default);
        if (isNaN(defaultNum)) {
          errors.push({
            type: "variable",
            message: `Default value for number variable "${variable.name}" must be a number`,
            variable: variable.name,
          });
        } else {
          if (variable.min !== undefined && defaultNum < variable.min) {
            errors.push({
              type: "variable",
              message: `Default value ${defaultNum} is below minimum ${variable.min} for "${variable.name}"`,
              variable: variable.name,
            });
          }
          if (variable.max !== undefined && defaultNum > variable.max) {
            errors.push({
              type: "variable",
              message: `Default value ${defaultNum} is above maximum ${variable.max} for "${variable.name}"`,
              variable: variable.name,
            });
          }
        }
      }
      break;

    case "boolean":
      if (
        variable.default !== undefined &&
        typeof variable.default !== "boolean" &&
        variable.default !== "true" &&
        variable.default !== "false"
      ) {
        errors.push({
          type: "variable",
          message: `Default value for boolean variable "${variable.name}" must be true or false`,
          variable: variable.name,
        });
      }
      break;

    case "string":
    case "list":
      if (variable.pattern) {
        try {
          new RegExp(variable.pattern);
        } catch {
          errors.push({
            type: "variable",
            message: `Invalid regex pattern for "${variable.name}": ${variable.pattern}`,
            variable: variable.name,
          });
        }
      }
      if (variable.min !== undefined && variable.min < 0) {
        errors.push({
          type: "variable",
          message: `Min length for "${variable.name}" cannot be negative`,
          variable: variable.name,
        });
      }
      break;
  }
}

/**
 * Validate template content syntax.
 */
function validateContent(
  content: string,
  variables: TemplateVariable[],
  errors: ValidationError[]
): void {
  // Parse the template
  let parsed;
  try {
    parsed = parseTemplate(content);
  } catch (e) {
    errors.push({
      type: "syntax",
      message: `Failed to parse template: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  // Check for undefined variables
  const definedVars = new Set(variables.map((v) => v.name));
  for (const usedVar of parsed.variables) {
    // Skip built-in variables and loop context
    if (isBuiltinVariable(usedVar) || usedVar === "this" || usedVar.startsWith("@")) {
      continue;
    }

    if (!definedVars.has(usedVar)) {
      errors.push({
        type: "syntax",
        message: `Undefined variable: "${usedVar}"`,
        variable: usedVar,
      });
    }
  }

  // Check for undefined modifiers
  const modifierNames = extractModifierNames(content);
  for (const modifier of modifierNames) {
    if (!(modifier in defaultModifiers)) {
      errors.push({
        type: "syntax",
        message: `Unknown modifier: "${modifier}"`,
      });
    }
  }

  // Check for unclosed blocks
  const unclosedBlocks = findUnclosedBlocks(content);
  for (const block of unclosedBlocks) {
    errors.push({
      type: "syntax",
      message: `Unclosed block: ${block.tag}`,
      line: block.line,
    });
  }
}

/**
 * Find unclosed block tags.
 */
function findUnclosedBlocks(content: string): { tag: string; line: number }[] {
  const unclosed: { tag: string; line: number }[] = [];
  const stack: { type: string; line: number }[] = [];
  const lines = content.split("\n");

  const blockOpenPattern = /\{\{#(\w+)\s/g;
  const blockClosePattern = /\{\{\/(\w+)\}\}/g;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    // Find opens
    let match;
    while ((match = blockOpenPattern.exec(line)) !== null) {
      stack.push({ type: match[1], line: lineNum + 1 });
    }

    // Find closes
    while ((match = blockClosePattern.exec(line)) !== null) {
      const closeType = match[1];
      // Find matching open
      let found = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].type === closeType) {
          stack.splice(i, 1);
          found = true;
          break;
        }
      }
      if (!found) {
        unclosed.push({ tag: `{{/${closeType}}}`, line: lineNum + 1 });
      }
    }
  }

  // Remaining opens are unclosed
  for (const item of stack) {
    unclosed.push({ tag: `{{#${item.type}}}`, line: item.line });
  }

  return unclosed;
}

/**
 * Validate variable values against their definitions.
 */
export function validateVariableValues(
  values: Record<string, unknown>,
  definitions: TemplateVariable[]
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const def of definitions) {
    const value = values[def.name];

    // Check required
    if (def.required && (value === undefined || value === null || value === "")) {
      errors.push({
        type: "variable",
        message: `Required variable "${def.name}" is missing`,
        variable: def.name,
      });
      continue;
    }

    // Skip validation if no value provided
    if (value === undefined || value === null) {
      continue;
    }

    // Type-specific validation
    switch (def.type) {
      case "number": {
        const num = Number(value);
        if (isNaN(num)) {
          errors.push({
            type: "variable",
            message: `Variable "${def.name}" must be a number`,
            variable: def.name,
          });
        } else {
          if (def.min !== undefined && num < def.min) {
            errors.push({
              type: "variable",
              message: `Variable "${def.name}" must be at least ${def.min}`,
              variable: def.name,
            });
          }
          if (def.max !== undefined && num > def.max) {
            errors.push({
              type: "variable",
              message: `Variable "${def.name}" must be at most ${def.max}`,
              variable: def.name,
            });
          }
        }
        break;
      }

      case "boolean": {
        if (typeof value !== "boolean" && value !== "true" && value !== "false") {
          errors.push({
            type: "variable",
            message: `Variable "${def.name}" must be a boolean`,
            variable: def.name,
          });
        }
        break;
      }

      case "choice": {
        if (def.choices) {
          const validValues = def.choices.map((c) => c.value);
          if (!validValues.includes(String(value))) {
            errors.push({
              type: "variable",
              message: `Variable "${def.name}" must be one of: ${validValues.join(", ")}`,
              variable: def.name,
            });
          }
        }
        break;
      }

      case "string": {
        const str = String(value);
        if (def.min !== undefined && str.length < def.min) {
          errors.push({
            type: "variable",
            message: `Variable "${def.name}" must be at least ${def.min} characters`,
            variable: def.name,
          });
        }
        if (def.max !== undefined && str.length > def.max) {
          errors.push({
            type: "variable",
            message: `Variable "${def.name}" must be at most ${def.max} characters`,
            variable: def.name,
          });
        }
        if (def.pattern) {
          const regex = new RegExp(def.pattern);
          if (!regex.test(str)) {
            errors.push({
              type: "variable",
              message: `Variable "${def.name}" does not match pattern: ${def.pattern}`,
              variable: def.name,
            });
          }
        }
        break;
      }

      case "list": {
        let items: unknown[];
        if (Array.isArray(value)) {
          items = value;
        } else if (typeof value === "string") {
          const separator = def.separator ?? ",";
          items = value.split(separator).map((s) => s.trim());
        } else {
          items = [value];
        }

        if (def.min !== undefined && items.length < def.min) {
          errors.push({
            type: "variable",
            message: `Variable "${def.name}" must have at least ${def.min} items`,
            variable: def.name,
          });
        }
        if (def.max !== undefined && items.length > def.max) {
          errors.push({
            type: "variable",
            message: `Variable "${def.name}" must have at most ${def.max} items`,
            variable: def.name,
          });
        }
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get a summary of required variables that need values.
 */
export function getRequiredVariables(template: Template): TemplateVariable[] {
  return (template.metadata.variables ?? []).filter(
    (v) => v.required && v.default === undefined
  );
}

/**
 * Get all variables that need prompting (required without defaults, or optional without values).
 */
export function getPromptableVariables(
  template: Template,
  providedValues: Record<string, unknown>
): TemplateVariable[] {
  return (template.metadata.variables ?? []).filter((v) => {
    // Skip if already provided
    if (v.name in providedValues) {
      return false;
    }
    // Include if required, or if no default
    return v.required || v.default === undefined;
  });
}
