import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { fakeModel } from "@langchain/core/testing";
import {
  DEFAULT_EXECUTION_TIMEOUT,
  DEFAULT_MAX_PTC_CALLS,
  DEFAULT_MAX_STACK_SIZE,
  DEFAULT_MEMORY_LIMIT,
  ReplSession,
  createCodeInterpreterMiddleware,
  formatReplResult,
} from "@langchain/quickjs";
import * as browserRuntime from "deepagents/browser";
import * as nodeRuntime from "deepagents/node";
import { createMiddleware, type AgentMiddleware } from "langchain";
import { z } from "zod/v4";
import type { ResearchAgentRuntimeBindings } from "./agent-runtime-core.js";

const DEEPAGENTS_INTEGRITY =
  "sha512-XAqdzNeI/yvm0XNhVBFG5CytnLJ4WziYWbBwrtAzMPub9S2tnLBXiwRpaqieNm/BDvA6IcI4j70ioXwJEb4jvQ==";
const QUICKJS_INTEGRITY =
  "sha512-QdNWVK8Ydi3+knzO6FfX/2WRoPd5ClJIuyGxNwvGiSUmPshQA1XQ9tXvWIQmZ2VLuxpkM2GqEeGWYq/KENJIpA==";

type InspectableDeepAgent = {
  options: {
    middleware: AgentMiddleware[];
  };
};

function inspectable(value: unknown): InspectableDeepAgent {
  return value as InspectableDeepAgent;
}

function runtimeBindings(
  runtime: typeof nodeRuntime | typeof browserRuntime,
): ResearchAgentRuntimeBindings {
  return {
    CompositeBackend: runtime.CompositeBackend,
    StateBackend: runtime.StateBackend,
    createDeepAgent: runtime.createDeepAgent,
    createFilesystemMiddleware: runtime.createFilesystemMiddleware,
    createSubAgentMiddleware: runtime.createSubAgentMiddleware,
    createSummarizationMiddleware: runtime.createSummarizationMiddleware,
    registerHarnessProfile: runtime.registerHarnessProfile,
  };
}

async function packageJsonFor(specifier: string): Promise<Record<string, unknown>> {
  const entry = import.meta.resolve(specifier);
  return Bun.file(new URL("../package.json", entry)).json() as Promise<
    Record<string, unknown>
  >;
}

function middlewareNames(agent: InspectableDeepAgent): string[] {
  return agent.options.middleware.map((middleware) => middleware.name);
}

describe("pinned DeepAgentsJS and QuickJS runtime contract", () => {
  test("locks durable registry versions, installed versions, and generated lock identities", async () => {
    const researchPackage = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as { dependencies?: Record<string, string> };
    const rootPackage = (await Bun.file(
      new URL("../../../package.json", import.meta.url),
    ).json()) as {
      overrides?: Record<string, string>;
      patchedDependencies?: Record<string, string>;
    };
    const lockfile = await Bun.file(
      new URL("../../../bun.lock", import.meta.url),
    ).text();
    const deepagentsPackage = await packageJsonFor("deepagents/node");
    const quickjsPackage = await packageJsonFor("@langchain/quickjs");

    expect(researchPackage.dependencies?.deepagents).toBe("1.12.1");
    expect(researchPackage.dependencies?.["@langchain/quickjs"]).toBe("1.0.0");
    expect(rootPackage.overrides?.deepagents).toBe("1.12.1");
    expect(rootPackage.patchedDependencies?.["deepagents@1.12.1"]).toBe(
      "patches/deepagents@1.12.1.patch",
    );
    expect(deepagentsPackage.version).toBe("1.12.1");
    expect(quickjsPackage.version).toBe("1.0.0");
    expect(lockfile).not.toContain("pkg.pr.new");
    expect(lockfile).toContain('"deepagents": ["deepagents@1.12.1"');
    expect(lockfile).toContain(DEEPAGENTS_INTEGRITY);
    expect(lockfile).toContain(
      '"deepagents@1.12.1": "patches/deepagents@1.12.1.patch"',
    );
    expect(lockfile).toContain('"@langchain/quickjs": ["@langchain/quickjs@1.0.0"');
    expect(lockfile).toContain(QUICKJS_INTEGRITY);
  });

  test("keeps the upstream browser config-forwarding fix pinned locally", async () => {
    const patch = await Bun.file(
      new URL("../../../patches/deepagents@1.12.1.patch", import.meta.url),
    ).text();

    expect(patch).toContain("getCurrentTaskInput(config)");
    expect(patch).toContain("getCurrentTaskInput)(config)");
    expect(patch).not.toContain("pkg.pr.new");
  });

  test("keeps the Node and browser entry points on the same typed runtime surface", () => {
    for (const runtime of [nodeRuntime, browserRuntime]) {
      const bindings = runtimeBindings(runtime);
      expect(Object.values(bindings).every((entry) => typeof entry === "function"))
        .toBe(true);
    }
    expect(Object.keys(runtimeBindings(nodeRuntime))).toEqual(
      Object.keys(runtimeBindings(browserRuntime)),
    );
  });

  test("replaces built-in middleware by name without duplicate task or context middleware", () => {
    for (const runtime of [nodeRuntime, browserRuntime]) {
      const replacementTask = tool(async () => "replacement task", {
        name: "task",
        description: "Pinned replacement task.",
        schema: z.object({
          description: z.string(),
          subagent_type: z.string(),
        }),
      });
      const replacement = createMiddleware({
        name: "subAgentMiddleware",
        tools: [replacementTask],
      });
      const agent = inspectable(
        runtime.createDeepAgent({
          model: fakeModel(),
          tools: [],
          middleware: [replacement],
          skills: ["/skills"],
          memory: ["/memory.md"],
        }),
      );
      const names = middlewareNames(agent);

      expect(names).toEqual([
        "SkillsMiddleware",
        "FilesystemMiddleware",
        "subAgentMiddleware",
        "SummarizationMiddleware",
        "patchToolCallsMiddleware",
        "MemoryMiddleware",
      ]);
      expect(new Set(names).size).toBe(names.length);
      expect(agent.options.middleware[2]).toBe(replacement);
      expect(
        agent.options.middleware.flatMap((middleware) => middleware.tools ?? [])
          .filter((candidate) => candidate.name === "task"),
      ).toEqual([replacementTask]);
    }
  });

  test("injects one static prompt and one skills/memory middleware per root", async () => {
    const marker = "PINNED_STATIC_PROMPT_MARKER";
    const model = fakeModel().respond(new AIMessage("prompt accepted"));
    const agent = inspectable(
      nodeRuntime.createDeepAgent({
        model,
        tools: [],
        systemPrompt: marker,
        skills: ["/skills"],
        memory: ["/memory.md"],
      }),
    );
    const names = middlewareNames(agent);
    expect(names.filter((name) => name === "SkillsMiddleware")).toHaveLength(1);
    expect(names.filter((name) => name === "MemoryMiddleware")).toHaveLength(1);

    // Use a prompt-only root for invocation: the middleware inventory above is
    // construction-time proof, while this call avoids reading synthetic paths.
    const promptModel = fakeModel().respond(new AIMessage("prompt accepted"));
    const promptAgent = nodeRuntime.createDeepAgent({
      model: promptModel,
      tools: [],
      systemPrompt: marker,
    });
    await promptAgent.invoke({ messages: [new HumanMessage("Inspect prompt.")] });
    const visiblePrompt = promptModel.calls[0]?.messages
      .map((message) => message.text)
      .join("\n") ?? "";
    expect(visiblePrompt.match(new RegExp(marker, "g"))).toHaveLength(1);
  });

  test("captures the built-in subagent registry and rejects a later unknown type", async () => {
    const subagents = [
      {
        name: "reader",
        description: "Read one synthetic source.",
        systemPrompt: "Return a bounded synthetic result.",
        tools: [],
        model: fakeModel().respond(new AIMessage("reader result")),
      },
    ];
    const middleware = nodeRuntime.createSubAgentMiddleware({
      defaultModel: fakeModel(),
      subagents,
      generalPurposeAgent: false,
    });
    expect(middleware.name).toBe("subAgentMiddleware");
    expect(nodeRuntime.REQUIRED_MIDDLEWARE_NAMES).toContain("SubAgentMiddleware");
    expect(nodeRuntime.REQUIRED_MIDDLEWARE_NAMES).not.toContain(
      "subAgentMiddleware",
    );
    subagents.push({
      name: "late-reader",
      description: "Mutation after construction.",
      systemPrompt: "This profile must not become visible.",
      tools: [],
      model: fakeModel().respond(new AIMessage("late result")),
    });
    const taskTool = middleware.tools?.find((candidate) => candidate.name === "task");
    if (!taskTool) throw new Error("Pinned subagent middleware did not expose task.");

    await expect(
      taskTool.invoke({
        description: "Try an unregistered profile.",
        subagent_type: "late-reader",
      }),
    ).rejects.toThrow("the only allowed types are `reader`");
  });

  test("dispatches QuickJS task directly, outside ToolNode wrappers and interruptOn", async () => {
    let childCalls = 0;
    let wrappedTaskCalls = 0;
    const taskTool = tool(
      async (input: { description: string; subagent_type: string }) => {
        childCalls += 1;
        return `${input.subagent_type}:${input.description}`;
      },
      {
        name: "task",
        description: "Synthetic task bridge.",
        schema: z.object({
          description: z.string(),
          subagent_type: z.string(),
        }),
      },
    );
    const taskOwner = createMiddleware({
      name: "subAgentMiddleware",
      tools: [taskTool],
    });
    const wrapper = createMiddleware({
      name: "taskWrapperSentinel",
      wrapToolCall: async (request, handler) => {
        if (request.toolCall.name === "task") wrappedTaskCalls += 1;
        return handler(request);
      },
    });
    const interpreter = createCodeInterpreterMiddleware({
      subagents: true,
      executionTimeoutMs: 1_000,
      captureConsole: false,
    });
    const model = fakeModel()
      .respond(
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "eval:one",
              name: "eval",
              args: {
                code: 'await task({ subagentType: "reader", description: "bounded" })',
              },
              type: "tool_call",
            },
          ],
        }),
      )
      .respond(new AIMessage("finished"));
    const agent = nodeRuntime.createDeepAgent({
      model,
      tools: [],
      middleware: [taskOwner, wrapper, interpreter],
      interruptOn: { task: true },
    });

    const output = await agent.invoke({
      messages: [new HumanMessage("Run one bridged task.")],
    });

    expect(output.messages.at(-1)?.content).toBe("finished");
    expect(childCalls).toBe(1);
    expect(wrappedTaskCalls).toBe(0);
  });

  test("locks interpreter timeout, memory, PTC, and projection behavior", async () => {
    expect(DEFAULT_EXECUTION_TIMEOUT).toBe(5_000);
    expect(DEFAULT_MEMORY_LIMIT).toBe(64 * 1024 * 1024);
    expect(DEFAULT_MAX_STACK_SIZE).toBe(320 * 1024);
    expect(DEFAULT_MAX_PTC_CALLS).toBe(256);

    const session = new ReplSession("pinned-runtime-bounds", {
      memoryLimitBytes: 4 * 1024 * 1024,
      maxResultChars: 32,
      captureConsole: true,
    });
    try {
      const timedOut = await session.eval("while (true) {}", 20);
      expect(timedOut).toMatchObject({
        ok: false,
        error: { name: "InternalError", message: "interrupted" },
      });

      const boundedConsole = formatReplResult(
        await session.eval('console.log("y".repeat(1_000)); 1', 100),
      );
      expect(boundedConsole).toContain("y".repeat(32));
      expect(boundedConsole).toContain("[truncated 969 chars]");

      // The pin does not bound the final expression with maxResultChars. This
      // characterization prevents us from mistaking the interpreter option for
      // a packet-security boundary; the host dispatcher must bound task/results.
      const unboundedExpression = formatReplResult(
        await session.eval('"x".repeat(1_000)', 100),
      );
      expect(unboundedExpression.length).toBeGreaterThan(1_000);

      const outOfMemory = await session.eval(
        'new Array(1_000_000).fill("abcdefgh")',
        200,
      );
      expect(outOfMemory).toMatchObject({
        ok: false,
        error: { name: "InternalError", message: "out of memory" },
      });
    } finally {
      session.dispose();
    }
  });

  test("deletes QuickJS guest state after the agent turn", async () => {
    const threadId = "pinned-runtime-cleanup";
    const model = fakeModel()
      .respond(
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "eval:cleanup",
              name: "eval",
              args: { code: "globalThis.privateTurnValue = 42; privateTurnValue" },
              type: "tool_call",
            },
          ],
        }),
      )
      .respond(new AIMessage("turn complete"));
    const agent = nodeRuntime.createDeepAgent({
      model,
      tools: [],
      middleware: [
        createCodeInterpreterMiddleware({
          subagents: false,
          executionTimeoutMs: 1_000,
          captureConsole: false,
        }),
      ],
    });

    await agent.invoke(
      { messages: [new HumanMessage("Create disposable guest state.")] },
      { configurable: { thread_id: threadId } },
    );

    expect(ReplSession.hasAnyForThread(threadId)).toBe(false);
  });

  test("keeps the v3 event projection available in Node and browser conditions", async () => {
    for (const runtime of [nodeRuntime, browserRuntime]) {
      const agent = runtime.createDeepAgent({
        model: fakeModel().respond(new AIMessage("streamed answer")),
        tools: [],
      });
      const run = await agent.streamEvents(
        { messages: [new HumanMessage("Stream one answer.")] },
        { version: "v3" },
      );
      const projectedMessages: string[] = [];
      for await (const message of run.messages) {
        let text = "";
        for await (const chunk of message.text) text += chunk;
        projectedMessages.push(text);
      }

      expect(projectedMessages).toEqual(["streamed answer"]);
      expect((await run.output).messages.at(-1)?.content).toBe("streamed answer");
      expect(run.toolCalls[Symbol.asyncIterator]).toBeTypeOf("function");
      expect(run.subagents[Symbol.asyncIterator]).toBeTypeOf("function");
    }
  });
});
