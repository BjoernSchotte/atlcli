/** Variable types supported in templates */
export type VariableType = "string" | "number" | "date" | "boolean" | "select";

/** Template variable definition */
export interface TemplateVariable {
  name: string;
  type: VariableType;
  required?: boolean;
  default?: string;
  description?: string;
  options?: string[]; // For select type
}

/** Target configuration for page creation from template */
export interface TemplateTarget {
  space?: string; // Default space key
  parent?: string; // Default parent page ID
  parentTitle?: string; // Default parent page title (alternative to ID)
}

/** Template metadata from frontmatter */
export interface TemplateMetadata {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
  category?: string;
  variables?: TemplateVariable[];
  target?: TemplateTarget; // Target page configuration
  labels?: string[]; // Labels to add to created pages
  // Source tracking (set by import, used by update)
  _source?: string; // URL template was imported from
  _source_version?: string; // Version at time of import
}

/** Full template with metadata, content, and source info */
export interface Template {
  metadata: TemplateMetadata;
  content: string;
  source: TemplateSource;
}

/** Where a template came from */
export interface TemplateSource {
  level: "global" | "profile" | "space";
  profile?: string;
  space?: string;
  path: string;
}

/** Manifest for template packs (import/export) */
export interface TemplatePackManifest {
  name: string;
  version: string;
  author?: string;
  description?: string;
  exported_at?: string;
  templates: {
    global?: string[];
    profiles?: Record<string, string[]>;
    spaces?: Record<string, string[]>;
  };
}

/** Context for rendering a template */
export interface RenderContext {
  variables: Record<string, unknown>;
  builtins: Record<string, unknown>;
  dateFormat?: string;
}

/** Result of rendering a template */
export interface RenderResult {
  content: string;
  usedVariables: string[];
  missingVariables: string[];
}

/** Filter options for listing templates */
export interface TemplateFilter {
  level?: "global" | "profile" | "space";
  profile?: string;
  space?: string;
  tags?: string[];
  search?: string;
  includeOverridden?: boolean; // For --all flag: include shadowed templates
}

/** Summary info for template listing */
export interface TemplateSummary {
  name: string;
  description?: string;
  level: "global" | "profile" | "space";
  profile?: string;
  space?: string;
  tags?: string[];
  overrides?: TemplateSource; // If this shadows another template
}

/** Result of template validation */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/** Validation error */
export interface ValidationError {
  line?: number;
  column?: number;
  message: string;
  type: "syntax" | "variable" | "handlebars";
}

/** Validation warning */
export interface ValidationWarning {
  line?: number;
  message: string;
  type: "unused-variable" | "undeclared-variable" | "deprecated";
}
