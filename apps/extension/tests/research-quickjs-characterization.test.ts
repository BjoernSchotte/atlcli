import { afterEach, describe, expect, it } from "bun:test";
import { tool } from "@langchain/core/tools";
import { ReplSession } from "@langchain/quickjs";
import { z } from "zod/v4";
import { fileURLToPath } from "node:url";

const PROCESS_PROBE = fileURLToPath(
  new URL("./research/quickjs-process-probe.ts", import.meta.url),
);

function onePtcTool() {
  return tool(async ({ value }) => value, {
    name: "one_ptc_tool",
    description: "Return one synthetic value.",
    schema: z.object({ value: z.string() }).strict(),
  });
}

async function runProcessProbe(): Promise<unknown> {
  const child = Bun.spawn(
    [process.execPath, "--conditions=development", PROCESS_PROBE],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`QuickJS process probe failed (${exitCode}): ${stderr}`);
  }
  return JSON.parse(stdout);
}

afterEach(() => {
  ReplSession.clearCache();
  ReplSession.resetSharedModule();
});

describe("@langchain/quickjs 1.0.0 pinned behavior", () => {
  it("does not count native task dispatches against maxPtcCalls", async () => {
    const dispatches: string[] = [];
    const session = new ReplSession("task-count-characterization", {
      tools: [onePtcTool()],
      maxPtcCalls: 1,
      captureConsole: false,
      subagentBridge: {
        maxConcurrency: 2,
        async dispatch(input) {
          dispatches.push(input.description);
          return { description: input.description };
        },
      },
    });
    try {
      const result = await session.eval(
        `const ptc = await tools.onePtcTool({ value: "one" });
         const tasks = await Promise.all([
           task({ description: "first", subagentType: "fixture", responseSchema: { type: "object", properties: { description: { type: "string" } } } }),
           task({ description: "second", subagentType: "fixture", responseSchema: { type: "object", properties: { description: { type: "string" } } } })
         ]);
         ({ ptc, tasks });`,
        5_000,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          ptc: "one",
          tasks: [{ description: "first" }, { description: "second" }],
        },
      });
      expect(dispatches).toEqual(["first", "second"]);

      const overBudget = await session.eval(
        `await tools.onePtcTool({ value: "one" });
         await tools.onePtcTool({ value: "two" });`,
        5_000,
      );
      expect(overBudget.ok).toBe(false);
      expect(overBudget.error?.message).toContain("PTC call budget exceeded");
    } finally {
      session.dispose();
    }
  });

  it("does not apply maxResultChars to task values", async () => {
    const session = new ReplSession("result-size-characterization", {
      maxResultChars: 32,
      captureConsole: false,
      subagentBridge: {
        maxConcurrency: 1,
        async dispatch() {
          return { payload: "x".repeat(2_000) };
        },
      },
    });
    try {
      const result = await session.eval(
        `const value = await task({ description: "large", subagentType: "fixture" });
         ({ length: value.payload.length, suffix: value.payload.slice(-4) });`,
        5_000,
      );
      expect(result).toMatchObject({
        ok: true,
        value: { length: 2_000, suffix: "xxxx" },
      });
    } finally {
      session.dispose();
    }
  });

  it("times out the interpreter without cancelling a running host dispatch", async () => {
    let dispatchCompleted = false;
    const session = new ReplSession("timeout-characterization", {
      captureConsole: false,
      subagentBridge: {
        maxConcurrency: 1,
        async dispatch() {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          dispatchCompleted = true;
          return "late-result";
        },
      },
    });
    try {
      const result = await session.eval(
        `await task({ description: "slow", subagentType: "fixture" });`,
        2,
      );
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(dispatchCompleted).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it("persists guest globals across evals but not across processes", async () => {
    const session = new ReplSession("cross-eval-characterization", {
      captureConsole: false,
    });
    try {
      expect(
        await session.eval(
          "globalThis.evalCounter = (globalThis.evalCounter ?? 0) + 1; evalCounter",
          5_000,
        ),
      ).toMatchObject({ ok: true, value: 1 });
      expect(
        await session.eval(
          "globalThis.evalCounter = (globalThis.evalCounter ?? 0) + 1; evalCounter",
          5_000,
        ),
      ).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }

    const [firstProcess, secondProcess] = await Promise.all([
      runProcessProbe(),
      runProcessProbe(),
    ]);
    expect(firstProcess).toMatchObject({ ok: true, value: 1 });
    expect(secondProcess).toMatchObject({ ok: true, value: 1 });
  });

  it("exposes nondeterministic guest clock and randomness", async () => {
    const session = new ReplSession("guest-nondeterminism-characterization", {
      captureConsole: false,
    });
    try {
      const result = await session.eval(
        `({
          clockType: typeof Date.now,
          clock: Date.now(),
          randomType: typeof Math.random,
          random: Math.random()
        })`,
        5_000,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          clockType: "function",
          randomType: "function",
        },
      });
      const value = result.value as { clock: number; random: number };
      expect(Number.isFinite(value.clock)).toBe(true);
      expect(value.random).toBeGreaterThanOrEqual(0);
      expect(value.random).toBeLessThan(1);
    } finally {
      session.dispose();
    }
  });

  it("returns explicit child data but does not merge it into guest globals", async () => {
    const session = new ReplSession("child-state-characterization", {
      captureConsole: false,
      subagentBridge: {
        maxConcurrency: 1,
        async dispatch() {
          return {
            packet: { answer: "bounded" },
            childState: { privateScratch: "not-parent-state" },
          };
        },
      },
    });
    try {
      const result = await session.eval(
        `const returned = await task({ description: "child", subagentType: "fixture" });
         ({ returned, implicitChildState: typeof childState, implicitPrivateScratch: typeof privateScratch });`,
        5_000,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          returned: {
            packet: { answer: "bounded" },
            childState: { privateScratch: "not-parent-state" },
          },
          implicitChildState: "undefined",
          implicitPrivateScratch: "undefined",
        },
      });
    } finally {
      session.dispose();
    }
  });
});
