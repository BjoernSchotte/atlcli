// Types
export * from "./types.js";

// Parser
export { parseTemplate, serializeTemplate, hasFrontmatter } from "./parser.js";
export type { ParsedTemplate } from "./parser.js";

// Built-in variables
export {
  getBuiltinVariables,
  formatDate,
  BUILTIN_VARIABLE_NAMES,
} from "./builtins.js";
export type { BuiltinContext, BuiltinVariableName } from "./builtins.js";

// Validation
export {
  validateVariableValue,
  validateTemplate,
  validateVariableValues,
  extractUsedVariables,
} from "./validation.js";
export type { VariableValidationResult } from "./validation.js";

// Engine
export { TemplateEngine } from "./engine.js";

// Storage
export {
  getTemplatesBaseDir,
  GlobalTemplateStorage,
  ProfileTemplateStorage,
  SpaceTemplateStorage,
} from "./storage.js";
export type { TemplateStorage } from "./storage.js";

// Resolver
export { TemplateResolver } from "./resolver.js";
