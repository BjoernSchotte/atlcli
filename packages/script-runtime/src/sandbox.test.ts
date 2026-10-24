import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { runScript, ScriptError, type HostFunction, type RunScriptOptions } from "./sandbox.js";

// The debug build asserts on leaked handles when the runtime is disposed, so
// every test below doubles as a lifetime/leak check.
const run = (js: string, options: RunScriptOptions = {}) =>
  runScript(js, { variant: DEBUG_VARIANT, ...options });

async function scriptError(promise: Promise<unknown>): Promise<ScriptError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ScriptError);
    return error as ScriptError;
  }
  throw new Error("expected the script to fail");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runScript", () => {
  it("returns the default export's JSON value and passes params", async () => {
    const result = await run(`export default (p) => ({ doubled: p.n * 2, tags: ["a"] })`, {
      params: { n: 21 },
    });
    expect(result.value).toEqual({ doubled: 42, tags: ["a"] });
  });

  it("maps undefined to null", async () => {
    expect((await run(`export default () => {}`)).value).toBeNull();
  });

  it("runs on the release build too", async () => {
    expect((await runScript(`export default () => 1 + 1`)).value).toBe(2);
  });

  it("calls namespaced host functions with JSON-copied arguments", async () => {
    const seen: unknown[][] = [];
    const get: HostFunction = async (args) => {
      seen.push(args);
      return { key: args[0], fields: { summary: "Hello" } };
    };
    const result = await run(
      `export default async () => (await atlcli.jira.get("ATLCLI-1", { expand: ["x"] })).fields.summary`,
      { host: { "jira.get": get } },
    );
    expect(result).toEqual({ value: "Hello", hostCalls: 1 });
    expect(seen).toEqual([["ATLCLI-1", { expand: ["x"] }]]);
  });

  it("runs Promise.all host calls concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: HostFunction = async ([n]) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await delay(20);
      inFlight--;
      return n;
    };
    const result = await run(
      `export default () => Promise.all([...Array(10).keys()].map((n) => atlcli.slow(n)))`,
      { host: { slow } },
    );
    expect(result.value).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(maxInFlight).toBe(10);
  });

  // Regression: consuming the stack of a host error once tripped the debug
  // build's leak assertion (lazy stack of an error created in a promise job).
  it("surfaces host errors as catchable guest errors without host stacks", async () => {
    const fail: HostFunction = async () => {
      throw new TypeError("boom");
    };
    const result = await run(
      `export default async () => { try { await atlcli.fail(); } catch (e) { return [e.name, e.message, String(e.stack ?? "").includes("sandbox.test")]; } }`,
      { host: { fail } },
    );
    expect(result.value).toEqual(["TypeError", "boom", false]);
  });

  it("reports guest exceptions", async () => {
    const error = await scriptError(run(`export default () => { throw new RangeError("nope"); }`));
    expect(error.kind).toBe("guest");
    expect(error.message).toBe("RangeError: nope");
  });

  it("interrupts CPU-bound loops at the deadline", async () => {
    const error = await scriptError(run(`export default () => { for (;;) {} }`, { limits: { deadlineMs: 100 } }));
    expect(error.kind).toBe("interrupted");
  });

  it("stops scripts that never settle at the wall-clock deadline", async () => {
    const error = await scriptError(
      run(`export default () => new Promise(() => {})`, { limits: { deadlineMs: 100 } }),
    );
    expect(error.kind).toBe("deadline");
  });

  it("enforces the memory limit", async () => {
    const error = await scriptError(
      run(`export default () => { const a = []; for (;;) a.push("x".repeat(1024)); }`, {
        limits: { memoryBytes: 8 * 1024 * 1024 },
      }),
    );
    expect(error.kind).toBe("memory");
    // The poisoned WASM instance is dropped; the next run gets a fresh one.
    expect((await run(`export default () => "fresh"`)).value).toBe("fresh");
  });

  it("times out hanging host calls and aborts their signal", async () => {
    let aborted = false;
    const hang: HostFunction = (_args, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(null);
        });
      });
    const result = await run(
      `export default async () => { try { await atlcli.hang(); } catch (e) { return e.message; } }`,
      { host: { hang }, limits: { hostCallTimeoutMs: 50 } },
    );
    expect(result.value).toBe("Host call timed out after 50 ms");
    expect(aborted).toBe(true);
  });

  it("ends the run at the host call limit even if the guest catches", async () => {
    const ok: HostFunction = async () => 1;
    const error = await scriptError(
      run(
        `export default async () => { for (let i = 0; i < 10; i++) { try { await atlcli.ok(); } catch {} } return "done"; }`,
        { host: { ok }, limits: { maxHostCalls: 3 } },
      ),
    );
    expect(error.kind).toBe("host-call-limit");
  });

  it("exposes no ambient capabilities", async () => {
    const result = await run(
      `export default () => [typeof fetch, typeof require, typeof process, typeof __atlcliHost, typeof __atlcliLog, typeof std, typeof os]`,
    );
    expect(result.value).toEqual(Array(7).fill("undefined"));
  });

  it("freezes the atlcli namespace", async () => {
    const ok: HostFunction = async () => "real";
    const result = await run(
      `export default async () => {
        "use strict";
        const attempts = [
          () => { atlcli.jira.get = () => "fake"; },
          () => { globalThis.atlcli = {}; },
          () => { delete atlcli.jira; },
        ];
        const blocked = attempts.map((f) => { try { f(); return false; } catch { return true; } });
        return [blocked, await atlcli.jira.get()];
      }`,
      { host: { "jira.get": ok } },
    );
    expect(result.value).toEqual([[true, true, true], "real"]);
  });

  it("keeps atlcli working when the script overrides JSON", async () => {
    const echo: HostFunction = async ([v]) => v;
    const result = await run(
      `export default async () => { JSON.parse = () => "hijacked"; JSON.stringify = () => "{}"; return (await atlcli.echo({ a: 1 })).a; }`,
      { host: { echo } },
    );
    expect(result.value).toBe(1);
  });

  it("rejects imports", async () => {
    for (const specifier of ["./helper.js", "node:fs", "https://example.com/x.js"]) {
      const error = await scriptError(run(`import x from ${JSON.stringify(specifier)}; export default () => x`));
      expect(error.kind).toBe("invalid-script");
    }
  });

  it("requires a default export function", async () => {
    const error = await scriptError(run(`export const x = 1;`));
    expect(error.kind).toBe("invalid-script");
  });

  it("forwards console output to onLog", async () => {
    const logs: string[] = [];
    await run(`export default () => { console.log("n =", 1, { a: 2 }); console.warn("careful"); }`, {
      onLog: (level, message) => logs.push(`${level}:${message}`),
    });
    expect(logs).toEqual(['info:n = 1 {"a":2}', "warn:careful"]);
  });

  it("supports top-level await in the script module", async () => {
    const one: HostFunction = async () => 1;
    const result = await run(`const base = await atlcli.one(); export default () => base + 1`, {
      host: { one },
    });
    expect(result.value).toBe(2);
  });

  it("rejects invalid host function names", async () => {
    await expect(run(`export default () => 1`, { host: { "bad name": async () => 1 } })).rejects.toThrow(
      "Invalid host function name",
    );
  });

  it("leaves no pending work behind when a host call outlives the run", async () => {
    const late: HostFunction = () => delay(80).then(() => "late");
    const error = await scriptError(
      run(`export default () => { atlcli.late(); return new Promise(() => {}); }`, {
        host: { late },
        limits: { deadlineMs: 30 },
      }),
    );
    expect(error.kind).toBe("deadline");
    await delay(100); // the late settle must not touch the disposed context
  });
});
