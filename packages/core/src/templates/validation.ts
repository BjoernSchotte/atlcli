import type {
  Template,
  TemplateVariable,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from "./types.js";
import { BUILTIN_VARIABLE_NAMES } from "./builtins.js";

/**
 * Result of validating a single variable value.
 */
export interface VariableValidationResult {
  valid: boolean;
  error?: string;
  coerced?: unknown; // The value coerced to the correct type
}

/**
 * Validate a variable value against its type definition.
 */
export function validateVariableValue(
  value: unknown,
  variable: TemplateVariable
): VariableValidationResult {
  // Handle undefined/null
  if (value === undefined || value === null || value === "") {
    if (variable.required && variable.default === undefined) {
      return { valid: false, error: `Required variable '${variable.name}' is missing` };
    }
    return { valid: true, coerced: variable.default ?? "" };
  }

  const strValue = String(value);

  switch (variable.type) {
    case "string":
      return { valid: true, coerced: strValue };

    case "number": {
      const num = Number(strValue);
      if (Number.isNaN(num)) {
        return {
          valid: false,
          error: `Variable '${variable.name}' expects a number, got '${strValue}'`,
        };
      }
      return { valid: true, coerced: num };
    }

    case "date": {
      // Accept ISO 8601 dates or relative dates
      const relativeDates: Record<string, () => string> = {
        today: () => new Date().toISOString().split("T")[0],
        yesterday: () => {
          const d = new Date();
          d.setDate(d.getDate() - 1);
          return d.toISOString().split("T")[0];
        },
        tomorrow: () => {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          return d.toISOString().split("T")[0];
        },
      };

      const lower = strValue.toLowerCase();
      if (relativeDates[lower]) {
        return { valid: true, coerced: relativeDates[lower]() };
      }

      // Try parsing as ISO date
      const parsed = Date.parse(strValue);
      if (Number.isNaN(parsed)) {
        return {
          valid: false,
          error: `Variable '${variable.name}' expects a date (ISO 8601 or today/yesterday/tomorrow), got '${strValue}'`,
        };
      }
      return { valid: true, coerced: strValue };
    }

    case "boolean": {
      const lower = strValue.toLowerCase();
      const trueValues = ["true", "yes", "1", "on"];
      const falseValues = ["false", "no", "0", "off"];

      if (trueValues.includes(lower)) {
        return { valid: true, coerced: true };
      }
      if (falseValues.includes(lower)) {
        return { valid: true, coerced: false };
      }
      return {
        valid: false,
        error: `Variable '${variable.name}' expects a boolean (true/false, yes/no, 1/0), got '${strValue}'`,
      };
    }

    case "select": {
      const options = variable.options ?? [];
      if (!options.includes(strValue)) {
        return {
          valid: false,
          error: `Variable '${variable.name}' must be one of: ${options.join(", ")}. Got '${strValue}'`,
        };
      }
      return { valid: true, coerced: strValue };
    }

    default:
      return { valid: true, coerced: strValue };
  }
}

/**
 * Extract variable names used in a Handlebars template.
 * Matches {{varName}}, {{varName "default"}}, {{#if varName}}, etc.
 */
export function extractUsedVariables(content: string): Set<string> {
  const used = new Set<string>();

  // Match simple variables: {{varName}}
  // Match variables with defaults: {{varName "default"}}
  // Match block helpers: {{#if varName}}, {{#unless varName}}, {{#each varName}}, {{#with varName}}
  // Match @builtins: {{@date}}

  const patterns = [
    // Simple variable or variable with default: {{name}} or {{name "default"}}
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:"[^"]*")?\s*\}\}/g,
    // Block helpers: {{#if name}}, {{#unless name}}, {{#each name}}, {{#with name}}
    /\{\{#(?:if|unless|each|with)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
    // Builtin @variables: {{@name}}
    /\{\{\s*@([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      used.add(match[1]);
    }
  }

  return used;
}

/**
 * Validate a full template (metadata + content).
 */
export function validateTemplate(template: Template): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Get declared variables from metadata
  const declaredVars = new Set(
    (template.metadata.variables ?? []).map((v) => v.name)
  );

  // Get used variables from content
  const usedVars = extractUsedVariables(template.content);

  // Check for undeclared variables (excluding builtins)
  for (const used of usedVars) {
    if (!declaredVars.has(used) && !BUILTIN_VARIABLE_NAMES.includes(used as never)) {
      warnings.push({
        message: `Variable '${used}' is used but not declared in frontmatter`,
        type: "undeclared-variable",
      });
    }
  }

  // Check for unused declared variables
  for (const declared of declaredVars) {
    if (!usedVars.has(declared)) {
      warnings.push({
        message: `Variable '${declared}' is declared but never used`,
        type: "unused-variable",
      });
    }
  }

  // Validate variable definitions
  for (const variable of template.metadata.variables ?? []) {
    // Check select type has options
    if (variable.type === "select" && (!variable.options || variable.options.length === 0)) {
      errors.push({
        message: `Select variable '${variable.name}' must have options defined`,
        type: "variable",
      });
    }

    // Check variable name is valid
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variable.name)) {
      errors.push({
        message: `Invalid variable name '${variable.name}'. Must start with letter or underscore, contain only alphanumeric and underscore.`,
        type: "variable",
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate all provided variable values against their definitions.
 */
export function validateVariableValues(
  values: Record<string, unknown>,
  variables: TemplateVariable[]
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  for (const variable of variables) {
    const result = validateVariableValue(values[variable.name], variable);
    if (!result.valid && result.error) {
      errors.push({
        message: result.error,
        type: "variable",
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
