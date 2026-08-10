import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatPromptCacheMiddlewareV1 } from "./prompt-cache.js";

describe("Chat prompt-cache privacy boundary", () => {
  test("caches only the stable prefix when the provider binding grants it", async () => {
    const [reset, breakpoint] = createChatPromptCacheMiddlewareV1({
      enabled: true,
      ttl: "5m",
    });
    const privateText = "PRIVATE USER AND EVIDENCE BODY";
    const request = {
      messages: [new HumanMessage(privateText)],
      state: {},
      model: { getName: () => "ProviderChosenByBinding" },
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

  test("keeps user, tenant, conversation, scope, and steering text outside a shared prefix", async () => {
    const [, breakpoint] = createChatPromptCacheMiddlewareV1({
      enabled: true,
      ttl: "5m",
    });
    const privateMessages = [
      "USER_A TENANT_A CONVERSATION_A SCOPE_A STEERING_A",
      "USER_B TENANT_B CONVERSATION_B SCOPE_B STEERING_B",
    ];
    const projected = await Promise.all(privateMessages.map((privateText) =>
      breakpoint!.wrapModelCall!(
        {
          messages: [new HumanMessage(privateText)],
          state: {},
          model: { getName: () => "ProviderChosenByBinding" },
          systemMessage: new SystemMessage("Stable child profile and tool contract."),
          tools: [],
        } as never,
        async (received) => received as never,
      )
    ));
    const systemContents = projected.map((entry) =>
      (entry as unknown as { systemMessage: SystemMessage }).systemMessage.content
    );
    expect(systemContents[0]).toEqual(systemContents[1]);
    for (const privateText of privateMessages) {
      expect(JSON.stringify(systemContents)).not.toContain(privateText);
    }
    expect(projected.map((entry) =>
      (entry as unknown as { messages: HumanMessage[] }).messages[0]!.text
    )).toEqual(privateMessages);
  });

  test("does not add provider cache controls for a provider-neutral model", async () => {
    const [, breakpoint] = createChatPromptCacheMiddlewareV1({ enabled: false });
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

  test("does not alter the accepted model response on cached or uncached paths", async () => {
    const acceptedPacket = new AIMessage({
      content: "",
      additional_kwargs: {
        structured_response: {
          schema: "atlcli.chat-agent-analysis/v1",
          summary: "Accepted structured result.",
        },
      },
    });
    const run = async (enabled: boolean) => {
      const [, breakpoint] = createChatPromptCacheMiddlewareV1({
        enabled,
        ttl: "5m",
      });
      const request = {
        messages: [new HumanMessage("Dynamic request")],
        state: {},
        model: { getName: () => enabled ? "CacheCapable" : "Portable" },
        modelSettings: {},
        systemMessage: new SystemMessage("Stable system contract."),
        tools: [],
      } as never;
      return breakpoint!.wrapModelCall!(request, async () => acceptedPacket);
    };

    expect(await run(true)).toBe(acceptedPacket);
    expect(await run(false)).toBe(acceptedPacket);
  });
});
