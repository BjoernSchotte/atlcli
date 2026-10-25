// Browser-safe template engine: exported from both index.ts and index.browser.ts.
export { createTemplateHandlebars, dateAdd, TEMPLATE_HELPER_NAMES } from "./helpers.js";
export {
  childScope,
  createTemplateScope,
  evaluateExpression,
  finish,
  RenderBudget,
  RenderError,
  renderSegments,
  renderText,
} from "./render.js";
export type { RenderOptions, RenderWarning, RenderWarningCode, Segment, TemplateScope } from "./render.js";
export { checkFieldValue, renderJiraFieldValue, renderTextField } from "./adapters/text.js";
export type { FieldKind } from "./adapters/text.js";
export { renderAdf } from "./adapters/adf.js";
export type { AdfMark, AdfNode } from "./adapters/adf.js";
export { renderStorage } from "./adapters/storage.js";
export { renderWikiMarkup } from "./adapters/wikimarkup.js";
export { collectVariables, renderBody } from "./adapters/index.js";
export type { BodyFormat, VariableUse } from "./adapters/index.js";
export { BUILTIN_VARIABLE_NAMES, formatDate, getBuiltinVariables } from "./builtins.js";
export type { BuiltinContext, BuiltinVariableName } from "./builtins.js";
export { parseVarsFile, resolveTemplateValues, unusedVariables } from "./vars-file.js";
export type { VarsFile } from "./vars-file.js";
