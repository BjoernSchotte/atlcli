import { renderJinja } from "@atlcli/jinja";
import type {
  Template,
  RenderContext,
  RenderResult,
  ValidationResult,
  ValidationError,
} from "./types.js";
import { getBuiltinVariables, BUILTIN_VARIABLE_NAMES } from "./builtins.js";
import {
  validateTemplate,
  validateVariableValue,
  extractUsedVariables,
} from "./validation.js";

/**
 * Page templates (`wiki template`): Jinja over declared variables (with
 * defaults) and built-ins. Missing values render empty here, as authors expect
 * from a page template; `{{ name | default("…") }}` gives an inline default.
 * Needs `await initJinja()` once before rendering.
 */
export class TemplateEngine {
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

    const { text: content, warnings } = renderJinja(template.content, { ...builtins, ...finalValues }, { tolerant: false, lines: true });
    const failure = warnings.find((w) => w.code === "parse-error" || w.code === "render-error");
    if (failure) throw new Error(`Template render failed: ${failure.message}`);

    const undeclaredVariables = [...extractUsedVariables(template.content)].filter(
      (name) => !(name in finalValues) && !BUILTIN_VARIABLE_NAMES.includes(name as never)
    );

    return {
      content,
      usedVariables,
      missingVariables,
      undeclaredVariables,
    };
  }

  /** Jinja syntax check: the error message, or null when the template parses. */
  private checkSyntax(content: string): string | null {
    const { warnings } = renderJinja(content, {}, { tolerant: false });
    const error = warnings.find((w) => w.code === "parse-error");
    return error ? `Jinja syntax error: ${error.message}${error.line !== undefined ? ` (line ${error.line})` : ""}` : null;
  }

  /**
   * Validate a full template (metadata + content).
   */
  validate(template: Template): ValidationResult {
    const result = validateTemplate(template);

    const syntaxError = this.checkSyntax(template.content);
    if (syntaxError) {
      result.errors.push({
        message: syntaxError,
        type: "syntax",
      });
      result.valid = false;
    }

    return result;
  }

  /**
   * Validate Jinja syntax only (for validating content before creating a template).
   */
  validateContent(content: string): ValidationResult {
    const errors: ValidationError[] = [];

    const syntaxError = this.checkSyntax(content);
    if (syntaxError) {
      errors.push({
        message: syntaxError,
        type: "syntax",
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
