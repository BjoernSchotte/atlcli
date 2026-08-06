import { describe, expect, test } from "bun:test";
import type { ChatAgentPortV1 } from "./port.js";
import { defineChatAgentPortV1 } from "./port.js";

function fixturePort(): ChatAgentPortV1 {
  return {
    async startTurn() { throw new Error("not used"); },
    async answerQuestion() { throw new Error("not used"); },
    async resumeTurn() { throw new Error("not used"); },
    async getPendingQuestion() { return null; },
    async getInteraction() { return null; },
    async control() { throw new Error("not used"); },
    async stop() { return "stopped"; },
    async listHistory() { return []; },
    async replay() { return null; },
    async artifact() { return null; },
    async sources() { return null; },
    async resetConversation() {},
  };
}

describe("host-neutral ChatAgentPortV1", () => {
  test("exposes the complete cross-shape product surface and no provider configuration", () => {
    const port = defineChatAgentPortV1(fixturePort());
    expect(Object.keys(port).sort()).toEqual([
      "answerQuestion",
      "artifact",
      "control",
      "getInteraction",
      "getPendingQuestion",
      "listHistory",
      "replay",
      "resetConversation",
      "resumeTurn",
      "sources",
      "startTurn",
      "stop",
    ]);
    expect(port).not.toHaveProperty("apiKey");
    expect(port).not.toHaveProperty("provider");
    expect(port).not.toHaveProperty("workflow");
    expect(port).not.toHaveProperty("scope");
    expect(Object.isFrozen(port)).toBe(true);
  });

  test("binds host methods so an ordinary-browser presenter cannot replace authority", async () => {
    const host = fixturePort();
    let calls = 0;
    host.listHistory = async function () {
      expect(this).toBe(host);
      calls += 1;
      return [];
    };
    const port = defineChatAgentPortV1(host);
    await port.listHistory("https://example.atlassian.net");
    expect(calls).toBe(1);
    expect(() => Object.assign(port, { workflow: "forged" })).toThrow();
  });
});
