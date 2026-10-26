import type { ScriptPort } from "./port.js";

/**
 * Port calls a script test answers from a fixture: every host operation
 * except the pure ones the test host provides itself (template rendering,
 * Markdown normalisation, secrets).
 */
const LOCAL = new Set(["render", "confluenceNormalizeMarkdown", "secret"]);

/** One recorded host operation: its arguments (without abort signals) and what it returned or threw. */
export interface FixtureCall {
  method: string;
  args: unknown[];
  result?: unknown;
  error?: string;
}

/** Secret values a fixture must not hold, mapped to their references. */
export type SecretValues = ReadonlyMap<string, string>;

/** Arguments as recorded: abort signals dropped, secret values replaced by references, canonical key order. */
function normalize(value: unknown, secrets: SecretValues): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [secret, name] of secrets) out = out.split(secret).join(`{secret:${name}}`);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, secrets));
  if (value && typeof value === "object") {
    if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) return undefined;
    const entries = Object.entries(value)
      .filter(([k, v]) => k !== "signal" && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // An options object that only carried the abort signal carries nothing.
    if (entries.length === 0 && "signal" in value) return undefined;
    return Object.fromEntries(entries.map(([k, v]) => [k, normalize(v, secrets)]));
  }
  return value;
}

const keyOf = (method: string, args: unknown[]) => JSON.stringify([method, args]);

/** Trailing undefined arguments carry nothing, so a call keys the same with or without them. */
function argsOf(args: unknown[], secrets: SecretValues): unknown[] {
  const out = args.map((a) => normalize(a, secrets));
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

/**
 * Wraps a live port and records every host operation the script makes.
 * Used for `script test --record`: planning only, so only reads happen.
 */
export function recordingPort(live: ScriptPort, secrets: SecretValues = new Map()): { port: ScriptPort; calls: FixtureCall[] } {
  const calls: FixtureCall[] = [];
  const port = new Proxy(live, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function" || LOCAL.has(prop)) return value;
      return async (...args: unknown[]) => {
        const call: FixtureCall = { method: prop, args: argsOf(args, secrets) };
        calls.push(call);
        try {
          const result = await value.apply(target, args);
          call.result = normalize(result ?? null, secrets);
          return result;
        } catch (error) {
          call.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
    },
  });
  return { port, calls };
}

/** A host operation the fixture has no answer for. */
export class FixtureMissError extends Error {
  constructor(readonly method: string, readonly args: unknown[]) {
    super(`The fixture has no answer for ${method}(${JSON.stringify(args).slice(1, -1)}); record the case again or add the call`);
    this.name = "FixtureMissError";
  }
}

/**
 * Answers host operations from recorded calls, in order per identical call
 * (the last answer repeats). `local` supplies the pure operations; secrets
 * resolve to stand-in values that the fixture sees as references.
 */
export function replayPort(calls: readonly FixtureCall[], local: Pick<ScriptPort, "render" | "confluenceNormalizeMarkdown">): {
  port: ScriptPort;
  misses: FixtureMissError[];
} {
  const answers = new Map<string, FixtureCall[]>();
  for (const call of calls) {
    const key = keyOf(call.method, call.args);
    answers.set(key, [...(answers.get(key) ?? []), call]);
  }
  const used = new Map<string, number>();
  const stand = (name: string) => `test-secret-${name}`;
  const secrets = new Map<string, string>();
  const misses: FixtureMissError[] = [];
  const port = new Proxy({} as ScriptPort, {
    get(_target, prop) {
      if (prop === "then" || typeof prop !== "string") return undefined;
      if (prop === "render") return local.render;
      if (prop === "confluenceNormalizeMarkdown") return local.confluenceNormalizeMarkdown;
      if (prop === "secret") {
        return (name: string) => {
          secrets.set(stand(name), name);
          return stand(name);
        };
      }
      return async (...args: unknown[]) => {
        const normalized = argsOf(args, secrets);
        const key = keyOf(prop, normalized);
        const list = answers.get(key);
        if (!list) {
          const miss = new FixtureMissError(prop, normalized);
          misses.push(miss);
          throw miss;
        }
        const n = used.get(key) ?? 0;
        used.set(key, n + 1);
        const call = list[Math.min(n, list.length - 1)]!;
        if (call.error !== undefined) throw new Error(call.error);
        return structuredClone(call.result);
      };
    },
  });
  return { port, misses };
}
