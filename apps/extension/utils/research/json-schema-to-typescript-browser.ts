type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
};

function literal(value: unknown): string {
  return JSON.stringify(value) ?? "unknown";
}

function schemaType(schema: JsonSchema | undefined): string {
  if (!schema) return "unknown";
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(" | ") || "never";

  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return variants.map(schemaType).join(" | ") || "never";

  if (Array.isArray(schema.type)) {
    return schema.type
      .map((type) => schemaType({ ...schema, type }))
      .join(" | ");
  }

  switch (schema.type) {
    case "array":
      return `Array<${schemaType(schema.items)}>`;
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "null":
      return "null";
    case "object": {
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {}).map(
        ([name, value]) =>
          `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(value)};`
      );
      if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        fields.push(
          `[key: string]: ${schemaType(schema.additionalProperties)};`
        );
      }
      return `{ ${fields.join(" ")} }`;
    }
    case "string":
      return "string";
    default:
      return "unknown";
  }
}

/**
 * Browser-sized implementation of the single json-schema-to-typescript API
 * used by @langchain/quickjs to describe PTC tool arguments in its prompt.
 * The upstream package's Node formatter/compiler graph is not needed here.
 */
export async function compile(
  schema: JsonSchema,
  interfaceName: string
): Promise<string> {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    return `export type ${interfaceName} = ${variants
      .map(schemaType)
      .join(" | ")};`;
  }
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(
    ([name, value]) =>
      `  ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(value)};`
  );
  return `export interface ${interfaceName} {\n${fields.join("\n")}\n}`;
}
