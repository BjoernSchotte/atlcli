// Types
export * from "./types.js";

// Parser
export { parseTemplate, serializeTemplate, hasFrontmatter } from "./parser.js";
export type { ParsedTemplate } from "./parser.js";

// Render engine and built-in variables (browser-safe; also in index.browser.ts)
export * from "./render-exports.js";

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

// Importer (import/export)
export {
  exportToDirectory,
  exportSingleTemplate,
  importFromDirectory,
  importFromGitUrl,
  importFromUrl,
  detectImportSourceType,
  getTrackedTemplates,
} from "./importer.js";
export type { ImportOptions, ImportResult } from "./importer.js";
