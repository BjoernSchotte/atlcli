export const TEMPLATE_INTAKE_MESSAGE_NAMESPACE = "ATLCLI_PDF_TEMPLATE_" as const;

export interface MessageParameterSchemaV1 {
  type: "integer" | "string";
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface TemplateIntakeMessageDefinitionV1 {
  severity: "error" | "info" | "warning";
  parameters: Readonly<Record<string, MessageParameterSchemaV1>>;
  defaultEnglish: string;
}

export const TEMPLATE_INTAKE_MESSAGES_V1 = {
  ATLCLI_PDF_TEMPLATE_IMPORT_REVIEW_REQUIRED: {
    severity: "info",
    parameters: {
      ready: { type: "integer", minimum: 0, maximum: 10_000 },
      review: { type: "integer", minimum: 0, maximum: 10_000 },
      unsupported: { type: "integer", minimum: 0, maximum: 10_000 },
    },
    defaultEnglish:
      "{ready} design choices are ready, {review} need review, and {unsupported} cannot be transferred.",
  },
  ATLCLI_PDF_TEMPLATE_STATUS_RESUMED: {
    severity: "info",
    parameters: {
      project: { type: "string", maxLength: 512 },
    },
    defaultEnglish: "Resumed the template project at {project}.",
  },
  ATLCLI_PDF_TEMPLATE_REVIEW_READY: {
    severity: "info",
    parameters: {
      concept: { type: "string", maxLength: 120 },
    },
    defaultEnglish: "{concept} is ready to apply after your confirmation.",
  },
  ATLCLI_PDF_TEMPLATE_REVIEW_UNCERTAIN: {
    severity: "warning",
    parameters: {
      concept: { type: "string", maxLength: 120 },
    },
    defaultEnglish: "{concept} needs your review before it can be applied.",
  },
  ATLCLI_PDF_TEMPLATE_ASSET_REVIEW_REQUIRED: {
    severity: "warning",
    parameters: {
      assets: { type: "integer", minimum: 0, maximum: 10_000 },
    },
    defaultEnglish: "{assets} visual items need a role and rights confirmation.",
  },
  ATLCLI_PDF_TEMPLATE_SOURCE_CHANGED: {
    severity: "warning",
    parameters: {},
    defaultEnglish: "The Word source changed after the last analysis.",
  },
  ATLCLI_PDF_TEMPLATE_BUILD_BLOCKED: {
    severity: "error",
    parameters: {
      blockers: { type: "integer", minimum: 1, maximum: 10_000 },
    },
    defaultEnglish: "The template cannot be built while {blockers} review items remain open.",
  },
  ATLCLI_PDF_TEMPLATE_PREVIEW_READY: {
    severity: "info",
    parameters: {
      artifacts: { type: "integer", minimum: 1, maximum: 3 },
    },
    defaultEnglish: "{artifacts} review artifacts were rendered.",
  },
  ATLCLI_PDF_TEMPLATE_BUILD_COMPLETE: {
    severity: "info",
    parameters: {
      output: { type: "string", maxLength: 512 },
    },
    defaultEnglish: "Saved the PDF template pack to {output}.",
  },
  ATLCLI_PDF_TEMPLATE_UNDO_COMPLETE: {
    severity: "info",
    parameters: {
      generation: { type: "integer", minimum: 1, maximum: 1_000_000 },
    },
    defaultEnglish: "Created generation {generation} from the previous design.",
  },
} as const satisfies Readonly<Record<string, TemplateIntakeMessageDefinitionV1>>;

export type TemplateIntakeMessageCode = keyof typeof TEMPLATE_INTAKE_MESSAGES_V1;

export type TemplateIntakeMessageCopies = Partial<
  Record<TemplateIntakeMessageCode, string>
>;

export interface RenderedTemplateIntakeMessageV1 {
  code: TemplateIntakeMessageCode;
  severity: TemplateIntakeMessageDefinitionV1["severity"];
  text: string;
}

function assertBoundedParameter(
  code: TemplateIntakeMessageCode,
  name: string,
  schema: MessageParameterSchemaV1,
  value: unknown
): string {
  if (schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    ) {
      throw new Error(`${code}.${name} is outside its bounded integer schema`);
    }
    return String(value);
  }
  if (typeof value !== "string" || value.length > (schema.maxLength ?? 0)) {
    throw new Error(`${code}.${name} is outside its bounded string schema`);
  }
  return value;
}

export function renderTemplateIntakeMessage(
  code: TemplateIntakeMessageCode,
  parameters: Readonly<Record<string, unknown>>,
  copies: TemplateIntakeMessageCopies = Object.fromEntries(
    Object.entries(TEMPLATE_INTAKE_MESSAGES_V1).map(([messageCode, definition]) => [
      messageCode,
      definition.defaultEnglish,
    ])
  ) as TemplateIntakeMessageCopies
): RenderedTemplateIntakeMessageV1 {
  const definition = TEMPLATE_INTAKE_MESSAGES_V1[code];
  const parameterSchemas: Readonly<Record<string, MessageParameterSchemaV1>> =
    definition.parameters;
  const expectedNames = Object.keys(parameterSchemas).sort();
  const actualNames = Object.keys(parameters).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error(`${code} parameters do not match its bounded schema`);
  }

  const safeParameters = Object.fromEntries(
    expectedNames.map((name) => [
      name,
      assertBoundedParameter(code, name, parameterSchemas[name]!, parameters[name]),
    ])
  ) as Record<string, string>;
  const copy = copies[code];
  const text = copy
    ? copy.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
        if (!(name in safeParameters)) throw new Error(`${code} copy uses unknown parameter ${name}`);
        return safeParameters[name]!;
      })
    : `[${code}] ${JSON.stringify(safeParameters)}`;

  return { code, severity: definition.severity, text };
}
