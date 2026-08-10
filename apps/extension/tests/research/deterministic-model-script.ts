export const DETERMINISTIC_RESEARCH_MODEL_SCRIPT_SCHEMA_V1 =
  "atlcli.deterministic-research-model-script/v1" as const;

export interface DeterministicResearchModelScriptV1 {
  schema: typeof DETERMINISTIC_RESEARCH_MODEL_SCRIPT_SCHEMA_V1;
  id: "parallel-cross-product-acquisition";
  code: string;
  codeBytes: number;
  taskIds: readonly ["deep-jira", "deep-wiki"];
}

/**
 * A customer-free, deterministic fake-supervisor output.
 *
 * The fake LangChain model returns this exact program as its `eval` tool call.
 * The same module is imported by the Bun characterization and bundled into the
 * packed MV3 worker, so host parity is about the real executable model output,
 * not two look-alike test implementations.
 */
export function createDeterministicResearchModelScriptV1(input: {
  jiraDescription: string;
  wikiDescription: string;
  responseSchema: Record<string, unknown>;
}): DeterministicResearchModelScriptV1 {
  const code = `await Promise.all([
    task({ description: ${JSON.stringify(input.jiraDescription)}, subagentType: "focused-researcher", responseSchema: ${JSON.stringify(input.responseSchema)} }),
    task({ description: ${JSON.stringify(input.wikiDescription)}, subagentType: "focused-researcher", responseSchema: ${JSON.stringify(input.responseSchema)} })
  ])`;

  return {
    schema: DETERMINISTIC_RESEARCH_MODEL_SCRIPT_SCHEMA_V1,
    id: "parallel-cross-product-acquisition",
    code,
    codeBytes: new TextEncoder().encode(code).byteLength,
    taskIds: ["deep-jira", "deep-wiki"],
  };
}
