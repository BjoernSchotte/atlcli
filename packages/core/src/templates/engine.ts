import Handlebars from "handlebars";
import type {
  Template,
  RenderContext,
  RenderResult,
  ValidationResult,
  ValidationError,
} from "./types.js";
import { getBuiltinVariables, formatDate, BUILTIN_VARIABLE_NAMES } from "./builtins.js";
import {
  validateTemplate,
  validateVariableValue,
  extractUsedVariables,
} from "./validation.js";

/**
 * Template engine that wraps Handlebars with custom helpers and built-in variables.
 */
export class TemplateEngine {
  private handlebars: typeof Handlebars;

  constructor() {
    this.handlebars = Handlebars.create();
    this.registerHelpers();
  }

  /**
   * Register custom Handlebars helpers.
   */
  private registerHelpers(): void {
    // formatDate helper: {{formatDate @date "DD.MM.YYYY"}}
    this.handlebars.registerHelper(
      "formatDate",
      (dateStr: string, format: string) => {
        if (typeof dateStr !== "string") return "";
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) return dateStr;
        return formatDate(date, format);
      }
    );

    // lowercase helper: {{lowercase str}}
    this.handlebars.registerHelper("lowercase", (str: unknown) => {
      return typeof str === "string" ? str.toLowerCase() : "";
    });

    // uppercase helper: {{uppercase str}}
    this.handlebars.registerHelper("uppercase", (str: unknown) => {
      return typeof str === "string" ? str.toUpperCase() : "";
    });
  }

  /**
   * Create a helper that provides inline defaults.
   * Usage: {{varName "default value"}}
   *
   * This works by registering a helper for each user-defined variable.
   */
  private createVariableHelpers(
    variables: Record<string, unknown>
  ): Record<string, Handlebars.HelperDelegate> {
    const helpers: Record<string, Handlebars.HelperDelegate> = {};

    for (const [name, value] of Object.entries(variables)) {
      helpers[name] = function (defaultValue?: string) {
        // If value is defined and not empty, use it
        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
        // Otherwise use the default if provided
        if (typeof defaultValue === "string") {
          return defaultValue;
        }
        // Return empty string
        return "";
      };
    }

    return helpers;
  }

  /**
   * Render a template with the given context.
   */
  render(template: Template, context: RenderContext): RenderResult {
    const usedVariables: string[] = [];
    const missingVariables: string[] = [];

    // Get declared variables with their defaults
    const declaredVars = template.metadata.variables ?? [];
    const finalValues: Record<string, unknown> = {};

    // Process each declared variable
    for (const varDef of declaredVars) {
      const provided = context.variables[varDef.name];
      const result = validateVariableValue(provided, varDef);

      if (result.valid) {
        finalValues[varDef.name] = result.coerced;
        if (provided !== undefined) {
          usedVariables.push(varDef.name);
        }
      } else {
        missingVariables.push(varDef.name);
        // Use default or empty
        finalValues[varDef.name] = varDef.default ?? "";
      }
    }

    // Add any extra variables not in metadata
    for (const [key, value] of Object.entries(context.variables)) {
      if (!(key in finalValues)) {
        finalValues[key] = value;
        usedVariables.push(key);
      }
    }

    // Get built-in variables
    const builtins = getBuiltinVariables({
      user: context.builtins.user as string | undefined,
      space: context.builtins.space as string | undefined,
      profile: context.builtins.profile as string | undefined,
      title: context.builtins.title as string | undefined,
      parentId: context.builtins.parentId as string | undefined,
      parentTitle: context.builtins.parentTitle as string | undefined,
      dateFormat: context.dateFormat,
    });

    // Create a fresh Handlebars instance for this render
    const hbs = Handlebars.create();

    // Copy registered helpers
    hbs.registerHelper("formatDate", this.handlebars.helpers.formatDate);
    hbs.registerHelper("lowercase", this.handlebars.helpers.lowercase);
    hbs.registerHelper("uppercase", this.handlebars.helpers.uppercase);

    // Register variable helpers for inline defaults
    const varHelpers = this.createVariableHelpers(finalValues);
    for (const [name, helper] of Object.entries(varHelpers)) {
      hbs.registerHelper(name, helper);
    }

    // Compile and render
    try {
      const compiled = hbs.compile(template.content, { strict: false });
      const content = compiled(finalValues, {
        data: {
          root: finalValues,
          // Built-in @variables
          ...builtins,
        },
      });

      return {
        content,
        usedVariables,
        missingVariables,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Template render failed: ${message}`);
    }
  }

  /**
   * Check Handlebars syntax manually by looking for unmatched blocks.
   * Returns error message if invalid, null if valid.
   */
  private checkHandlebarsSyntax(content: string): string | null {
    // Track block helpers
    const blockStack: string[] = [];

    // Match opening blocks: {{#name ...}}
    const openingBlocks = content.matchAll(/\{\{#(\w+)/g);
    for (const match of openingBlocks) {
      blockStack.push(match[1]);
    }

    // Match closing blocks: {{/name}}
    const closingBlocks = content.matchAll(/\{\{\/(\w+)\}\}/g);
    const closingList: string[] = [];
    for (const match of closingBlocks) {
      closingList.push(match[1]);
    }

    // Check if all opening blocks have closing blocks
    if (blockStack.length !== closingList.length) {
      const unclosed = blockStack.filter((b, i) => closingList[i] !== b);
      if (unclosed.length > 0) {
        return `Unclosed block helper: {{#${unclosed[0]}}}`;
      }
      return "Mismatched block helpers";
    }

    // Try to compile - may catch other errors
    try {
      this.handlebars.compile(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Handlebars syntax error: ${message}`;
    }

    return null;
  }

  /**
   * Validate a full template (metadata + content).
   */
  validate(template: Template): ValidationResult {
    const result = validateTemplate(template);

    // Also check Handlebars syntax
    const syntaxError = this.checkHandlebarsSyntax(template.content);
    if (syntaxError) {
      result.errors.push({
        message: syntaxError,
        type: "handlebars",
      });
      result.valid = false;
    }

    return result;
  }

  /**
   * Validate Handlebars syntax only (for validating content before creating a template).
   */
  validateContent(content: string): ValidationResult {
    const errors: ValidationError[] = [];

    const syntaxError = this.checkHandlebarsSyntax(content);
    if (syntaxError) {
      errors.push({
        message: syntaxError,
        type: "handlebars",
      });
    }

    // Extract variables for informational purposes
    const usedVars = extractUsedVariables(content);
    const userVars = [...usedVars].filter(
      (v) => !BUILTIN_VARIABLE_NAMES.includes(v as never)
    );

    return {
      valid: errors.length === 0,
      errors,
      warnings: userVars.length > 0
        ? [
            {
              message: `Template uses variables: ${userVars.join(", ")}. Ensure these are declared in frontmatter.`,
              type: "undeclared-variable",
            },
          ]
        : [],
    };
  }
}
