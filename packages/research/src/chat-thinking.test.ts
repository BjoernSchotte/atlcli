import { expect, test } from "bun:test";
import {
  CHAT_THINKING_MODES_V1,
  chatPolicyForThinkingModeV1,
  chatThinkingModeFromPolicyV1,
} from "./contracts.js";

test("chat thinking remains separate from deep-research workflow policy", () => {
  expect(CHAT_THINKING_MODES_V1).toEqual(["auto", "quick", "deep"]);
  expect(CHAT_THINKING_MODES_V1.map((mode) =>
    chatPolicyForThinkingModeV1(mode)
  )).toEqual([
    expect.objectContaining({
      requestedEffort: "auto",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    }),
    expect.objectContaining({
      requestedEffort: "lookup",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    }),
    expect.objectContaining({
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    }),
  ]);
  expect(chatThinkingModeFromPolicyV1({ requestedEffort: "auto" })).toBe("auto");
  expect(chatThinkingModeFromPolicyV1({ requestedEffort: "lookup" })).toBe("quick");
  expect(chatThinkingModeFromPolicyV1({ requestedEffort: "deep" })).toBe("deep");
});
