import { describe, expect, test } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatPromptCacheMiddlewareV1 } from "./prompt-cache.js";

describe("Chat prompt-cache privacy boundary", () => {
  test("caches only the stable Anthropic system prefix", async () => {
    const [reset, breakpoint] = createChatPromptCacheMiddlewareV1();
    const privateText = "PRIVATE USER AND EVIDENCE BODY";
    const request = {
      messages: [new HumanMessage(privateText)],
      state: {},
      model: { getName: () => "ChatAnthropic" },
      modelSettings: { cache_control: { type: "ephemeral" }, temperature: 0 },
      systemMessage: new SystemMessage("Stable Chat system contract."),
      tools: [],
    } as never;
    const withoutMovingCache = await reset!.wrapModelCall!(
      request,
      async (received) => received as never,
    );
    expect((withoutMovingCache as { modelSettings?: Record<string, unknown> }).modelSettings)
      .toEqual({ temperature: 0 });

    const projected = await breakpoint!.wrapModelCall!(
      withoutMovingCache as never,
      async (received) => received as never,
    );
    const systemContent = (projected as unknown as { systemMessage: SystemMessage })
      .systemMessage.content;
    expect(systemContent).toEqual([{
      type: "text",
      text: "Stable Chat system contract.",
      cache_control: { type: "ephemeral", ttl: "5m" },
    }]);
    expect(JSON.stringify(systemContent)).not.toContain(privateText);
    expect((projected as unknown as { messages: HumanMessage[] }).messages[0]!.text)
      .toBe(privateText);
  });

  test("does not add provider cache controls for a provider-neutral model", async () => {
    const [, breakpoint] = createChatPromptCacheMiddlewareV1();
    const projected = await breakpoint!.wrapModelCall!(
      {
        messages: [],
        state: {},
        model: { getName: () => "SyntheticProvider" },
        systemMessage: new SystemMessage([{
          type: "text",
          text: "Stable Chat contract.",
          cache_control: { type: "ephemeral" },
        }]),
        tools: [],
      } as never,
      async (received) => received as never,
    );
    expect((projected as unknown as { systemMessage: SystemMessage }).systemMessage.content)
      .toEqual([{ type: "text", text: "Stable Chat contract." }]);
  });
});
