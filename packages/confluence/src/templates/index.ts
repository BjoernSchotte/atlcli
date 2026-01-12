/**
 * Page templates module for atlcli.
 *
 * Provides a Handlebars-style template engine for creating Confluence pages
 * from reusable templates with variables, conditionals, and loops.
 *
 * @example
 * ```ts
 * import { getTemplate, renderTemplate, createBuiltins } from "@atlcli/confluence/templates";
 *
 * const template = getTemplate("meeting-notes", atlcliDir);
 * const builtins = createBuiltins({
 *   title: "Weekly Meeting",
 *   spaceKey: "TEAM",
 *   user: { email: "user@example.com", displayName: "John Doe", accountId: "123" }
 * });
 * const result = renderTemplate(template, {
 *   variables: { attendees: ["Alice", "Bob"] },
 *   builtins,
 *   spaceKey: "TEAM",
 *   title: "Weekly Meeting"
 * });
 * console.log(result.markdown);
 * ```
 */

// Types
export type {
  VariableType,
  ChoiceOption,
  TemplateVariable,
  TemplateTarget,
  TemplateMetadata,
  Template,
  VariableValues,
  BuiltinVariables,
  TemplateContext,
  RenderedTemplate,
  TemplateValidationError,
  TemplateValidationResult,
  ModifierFn,
  ModifierRegistry,
  ModifierCall,
  TemplateNode,
  TextNode,
  VariableNode,
  ConditionalNode,
  LoopNode,
  ParsedTemplate,
} from "./types.js";

// Parser
export { parseTemplate, extractVariableNames, extractModifierNames } from "./parser.js";

// Modifiers
export { defaultModifiers, applyModifierChain } from "./modifiers.js";

// Built-in variables
export { createBuiltins, resolveBuiltin, isBuiltinVariable } from "./builtins.js";

// Rendering engine
export { renderTemplate, previewTemplate, renderString } from "./engine.js";

// Storage
export {
  getGlobalTemplatesDir,
  getLocalTemplatesDir,
  loadTemplate,
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  templateExists,
} from "./storage.js";

// Validation
export {
  validateTemplate,
  validateVariableValues,
  getRequiredVariables,
  getPromptableVariables,
} from "./validator.js";
