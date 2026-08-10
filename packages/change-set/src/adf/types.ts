/** JSON values accepted inside validated ADF attributes. */
export type AdfJsonValue =
  | null
  | boolean
  | number
  | string
  | AdfJsonValue[]
  | { [key: string]: AdfJsonValue };

export interface AdfMark {
  type: string;
  attrs?: Record<string, AdfJsonValue>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, AdfJsonValue>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
}

export interface AdfDocument extends AdfNode {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export interface AdfParseBudget {
  /** UTF-8 bytes accepted before JSON parsing. */
  maxInputBytes: number;
  /** Root included. */
  maxNodes: number;
  /** Root depth is zero. */
  maxDepth: number;
  /** UTF-8 bytes across node text fields. */
  maxTextBytes: number;
  /** UTF-8 bytes across attribute keys and primitive values. */
  maxAttributeBytes: number;
  /** Marks across the complete document. */
  maxMarks: number;
  /** Attribute containers, arrays, and primitive members. */
  maxAttributeValues: number;
  /** Drift diagnostics retained before a deterministic summary. */
  maxDiagnostics: number;
}

export const DEFAULT_ADF_PARSE_BUDGET: Readonly<AdfParseBudget> = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 128,
  maxTextBytes: 6 * 1024 * 1024,
  maxAttributeBytes: 2 * 1024 * 1024,
  maxMarks: 200_000,
  maxAttributeValues: 500_000,
  maxDiagnostics: 200,
});

export type AdfDiagnosticKind =
  | "unknown-node"
  | "unknown-mark"
  | "unknown-attribute"
  | "diagnostics-truncated";

export interface AdfDiagnostic {
  kind: AdfDiagnosticKind;
  path: string;
  type?: string;
  attribute?: string;
  count?: number;
}

export interface AdfValidationStats {
  inputBytes?: number;
  nodes: number;
  marks: number;
  maxDepth: number;
  textBytes: number;
  attributeBytes: number;
  attributeValues: number;
}

export interface ValidatedAdfDocument {
  document: AdfDocument;
  diagnostics: AdfDiagnostic[];
  stats: AdfValidationStats;
}

export type AdfValidationErrorCode =
  | "input-too-large"
  | "invalid-json"
  | "invalid-root"
  | "unsupported-version"
  | "invalid-node"
  | "invalid-mark"
  | "invalid-attributes"
  | "node-budget-exceeded"
  | "depth-budget-exceeded"
  | "text-budget-exceeded"
  | "attribute-budget-exceeded"
  | "mark-budget-exceeded";

export class AdfValidationError extends Error {
  constructor(
    public readonly code: AdfValidationErrorCode,
    message: string,
    public readonly path: string = "$",
  ) {
    super(message);
    this.name = "AdfValidationError";
  }
}
