import { ReplSession, validateResponseSchema } from "@langchain/quickjs";
import {
  PRODUCTION_RESPONSE_SCHEMA_FIXTURES,
  responseSchemaMetrics,
  type ResponseSchemaMetrics,
} from "./production-response-schema-fixtures.js";

export interface ProductionResponseSchemaCharacterization {
  metrics: Record<string, ResponseSchemaMetrics>;
  admittedRoles: string[];
}

export async function characterizeProductionResponseSchemas(
  sessionId: string,
): Promise<ProductionResponseSchemaCharacterization> {
  const admittedRoles: string[] = [];
  for (const fixture of PRODUCTION_RESPONSE_SCHEMA_FIXTURES) {
    validateResponseSchema(fixture.schema);
  }
  const session = new ReplSession(sessionId, {
    captureConsole: false,
    subagentBridge: {
      maxConcurrency: 6,
      async dispatch(input) {
        admittedRoles.push(input.subagentType);
        return { admittedRole: input.subagentType };
      },
    },
  });
  try {
    const calls = PRODUCTION_RESPONSE_SCHEMA_FIXTURES.flatMap((fixture) =>
      fixture.roles.map((role) =>
        `task({ description: ${JSON.stringify(`Validate ${fixture.id} for ${role}.`)}, subagentType: ${JSON.stringify(role)}, responseSchema: ${JSON.stringify(fixture.schema)} })`
      )
    );
    const result = await session.eval(`await Promise.all([${calls.join(",")}])`, 10_000);
    if (!result.ok) {
      throw new Error(
        `Production response schema admission failed: ${result.error?.name ?? "Error"}: ${result.error?.message ?? "unknown"}`,
      );
    }
  } finally {
    session.dispose();
  }

  return {
    metrics: Object.fromEntries(
      PRODUCTION_RESPONSE_SCHEMA_FIXTURES.map((fixture) => [
        fixture.id,
        responseSchemaMetrics(fixture.schema),
      ]),
    ),
    admittedRoles: [...new Set(admittedRoles)].sort(),
  };
}
