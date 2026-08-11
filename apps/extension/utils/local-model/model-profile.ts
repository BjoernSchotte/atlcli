/**
 * Operational browser envelope for the pinned Gemma 4 E4B WebGPU build.
 *
 * This is deliberately separate from provider usage accounting: local
 * inference is unmetered, while one WebGPU invocation still needs bounded
 * context, generation, and interpreter-result sizes to avoid exhausting the
 * browser process.
 */
export const LOCAL_GEMMA_OPERATIONAL_PROFILE_V1 = Object.freeze({
  harnessKey: "atlcli-local:gemma-4-e4b",
  maxInputTokens: 8_192,
  maxOutputTokens: 4_096,
  maxInterpreterResultChars: 4_000,
});

export type LocalGemmaThinkingModeV1 = "disabled" | "low" | "enabled";

export function localGemmaThinkingModeV1(
  preference: "fast" | "balanced" | "thorough",
): LocalGemmaThinkingModeV1 {
  switch (preference) {
    case "fast": return "disabled";
    case "balanced": return "low";
    case "thorough": return "enabled";
  }
}

export function localGemmaContextOverflowMessageV1(
  inputTokens: number,
): string | undefined {
  if (inputTokens <= LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxInputTokens) {
    return undefined;
  }
  return [
    `Local Gemma input has ${inputTokens} tokens and exceeds the`,
    `${LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxInputTokens}-token browser inference envelope.`,
  ].join(" ");
}

export const LOCAL_GEMMA_HARNESS_PROFILE_V1 = Object.freeze({
  systemPromptSuffix: [
    "Use only the tools declared for the current model call.",
    "The direct tool named `eval` executes JavaScript. `tools` is not a direct tool: the `tools.<name>(...)` namespace exists only inside the JavaScript `code` argument passed to `eval`.",
    "When host instructions show `tools.someCapability(...)`, call `eval` and place that expression in its `code`; never emit a model tool call named `tools` or `tools.someCapability`.",
    "After a tool result, continue the same tool-calling turn and finish through the declared structured-answer tool when instructed.",
  ].join(" "),
  toolDescriptionOverrides: {
    eval: [
      "Execute JavaScript in the host's bounded QuickJS interpreter.",
      "Pass one object with a `code` string. Host capabilities are available only inside that string as `tools.<name>(...)`.",
      "Never call `tools` or `tools.<name>` as a direct model tool.",
    ].join(" "),
  },
});
