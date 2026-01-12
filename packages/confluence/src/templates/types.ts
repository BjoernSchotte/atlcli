/**
 * Template system types for atlcli page templates.
 */

/** Supported variable types */
export type VariableType =
  | "string"
  | "date"
  | "datetime"
  | "number"
  | "boolean"
  | "list"
  | "choice";

/** Choice option for choice-type variables */
export interface ChoiceOption {
  value: string;
  label: string;
}

/** Variable definition in template metadata */
export interface TemplateVariable {
  /** Variable name (used in {{name}} syntax) */
  name: string;
  /** Prompt text shown to user */
  prompt: string;
  /** Extended description/help text */
  description?: string;
  /** Variable type */
  type: VariableType;
  /** Default value (can include variable references) */
  default?: string | number | boolean;
  /** Whether variable is required */
  required?: boolean;
  /** For list type: separator character */
  separator?: string;
  /** For choice type: available options */
  choices?: ChoiceOption[];
  /** Validation regex pattern */
  pattern?: string;
  /** Minimum value (for number) or length (for string/list) */
  min?: number;
  /** Maximum value (for number) or length (for string/list) */
  max?: number;
}

/** Target configuration for template */
export interface TemplateTarget {
  /** Default space key */
  space?: string;
  /** Default parent page ID */
  parent?: string;
  /** Default parent page title (alternative to ID) */
  parentTitle?: string;
  /** Labels to add to created pages */
  labels?: string[];
}

/** Template metadata */
export interface TemplateMetadata {
  /** Unique template name/identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** Template version (semver) */
  version?: string;
  /** Template author */
  author?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Target page configuration */
  target?: TemplateTarget;
  /** Variable definitions */
  variables?: TemplateVariable[];
}

/** Complete template definition */
export interface Template {
  /** Template metadata */
  metadata: TemplateMetadata;
  /** Template content (markdown with variables) */
  content: string;
  /** Source location (file path) */
  location: string;
  /** Whether this is a local template */
  isLocal: boolean;
}

/** Resolved variable values for rendering */
export type VariableValues = Record<string, unknown>;

/** Built-in variable values */
export interface BuiltinVariables {
  NOW: string;
  TODAY: string;
  YEAR: string;
  MONTH: string;
  DAY: string;
  TIME: string;
  WEEKDAY: string;
  USER: {
    email: string;
    displayName: string;
    accountId: string;
  };
  SPACE: {
    key: string;
    name: string;
  };
  PARENT: {
    id: string | null;
    title: string | null;
  };
  TITLE: string;
  UUID: string;
  ENV: Record<string, string>;
}

/** Context for template rendering */
export interface TemplateContext {
  /** User-provided variable values */
  variables: VariableValues;
  /** Built-in variables */
  builtins: BuiltinVariables;
  /** Target space key */
  spaceKey: string;
  /** Target parent page ID */
  parentId?: string;
  /** Page title */
  title: string;
}

/** Result of template rendering */
export interface RenderedTemplate {
  /** Rendered markdown content */
  markdown: string;
  /** Page title (may have been templated) */
  title: string;
  /** Target space key */
  spaceKey: string;
  /** Target parent page ID */
  parentId?: string;
  /** Labels to apply */
  labels?: string[];
}

/** Template validation error */
export interface TemplateValidationError {
  /** Error type */
  type: "syntax" | "variable" | "metadata" | "modifier";
  /** Error message */
  message: string;
  /** Line number (if applicable) */
  line?: number;
  /** Column number (if applicable) */
  column?: number;
  /** Variable name (for variable errors) */
  variable?: string;
  /** Field name (for metadata errors) */
  field?: string;
}

/** Alias for TemplateValidationError */
export type ValidationError = TemplateValidationError;

/** Template validation result */
export interface TemplateValidationResult {
  /** Whether template is valid */
  valid: boolean;
  /** Validation errors */
  errors: TemplateValidationError[];
  /** Validation warnings */
  warnings?: TemplateValidationError[];
}

/** Alias for TemplateValidationResult */
export type ValidationResult = TemplateValidationResult;

/** Modifier function signature */
export type ModifierFn = (value: unknown, ...args: string[]) => unknown;

/** Registry of available modifiers */
export type ModifierRegistry = Record<string, ModifierFn>;

/** Parsed modifier call */
export interface ModifierCall {
  name: string;
  args: string[];
}

/** AST node types */
export type TemplateNode =
  | TextNode
  | VariableNode
  | ConditionalNode
  | LoopNode;

export interface TextNode {
  type: "text";
  content: string;
}

export interface VariableNode {
  type: "variable";
  name: string;
  modifiers: ModifierCall[];
  raw: string;
}

export interface ConditionalNode {
  type: "conditional";
  condition: VariableNode;
  inverse: boolean; // for #unless
  consequent: TemplateNode[];
  alternate?: TemplateNode[]; // for else/else if
}

export interface LoopNode {
  type: "loop";
  iterable: string;
  itemName: string;
  body: TemplateNode[];
  empty?: TemplateNode[]; // for {{else}} in loops
}

/** Parsed template structure */
export interface ParsedTemplate {
  /** AST nodes */
  nodes: TemplateNode[];
  /** All variable references found */
  variables: Set<string>;
  /** All modifiers used */
  modifiers: Set<string>;
}
