/** Test helpers: a command context without a terminal, and stub clients. */
import type { ConfluenceClient } from "@atlcli/confluence";
import type { JiraClient, JiraIssue } from "@atlcli/jira";
import type { TuiOptions } from "../index.js";
import { allCommands, createCtx } from "./app.js";
import type { Ctx } from "./keymap.js";
import { initialState, type AppState } from "./state.js";
import { createStore } from "./store.js";

export type Call = { method: string; args: unknown[] };

/** A client whose methods record their calls and answer from `impl` (missing ones throw). */
export function stubClient<T>(impl: Record<string, (...args: never[]) => unknown>, calls: Call[] = []): T {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "isCloudSite") return impl.isCloudSite === undefined ? true : (impl.isCloudSite as unknown as () => boolean)();
        if (prop === "siteUrl") return "https://example.atlassian.net";
        if (prop === "then") return undefined;
        return async (...args: unknown[]) => {
          calls.push({ method: prop, args });
          const fn = impl[prop];
          if (!fn) throw new Error(`stub: no ${prop}`);
          return (fn as (...a: unknown[]) => unknown)(...args);
        };
      },
    }
  ) as T;
}

export function issue(key: string, fields: Partial<JiraIssue["fields"]> = {}): JiraIssue {
  return {
    id: key,
    key,
    self: "",
    fields: { summary: `Summary of ${key}`, status: { id: "1", name: "To Do" }, issuetype: { id: "1", name: "Task" }, labels: [], ...fields },
  } as unknown as JiraIssue;
}

export interface TestSetup {
  ctx: Ctx;
  calls: Call[];
  toasts: () => AppState["toasts"];
  /** Lets pending promises (loaders, writes) settle. */
  settle: () => Promise<void>;
}

export function setup(jira: Record<string, (...args: never[]) => unknown> = {}, opts: Partial<TuiOptions> = {}, confluence: Record<string, (...args: never[]) => unknown> = {}): TestSetup {
  const calls: Call[] = [];
  const store = createStore(initialState(opts.area ?? "jira"));
  const options: TuiOptions = {
    profile: "test",
    siteUrl: "https://example.atlassian.net",
    jira: stubClient<JiraClient>(jira, calls),
    confluence: stubClient<ConfluenceClient>(confluence, calls),
    openUrl: async () => {},
    editText: async (text) => text,
    ...opts,
  };
  const ctx = createCtx(store, options, undefined, () => {});
  return {
    ctx,
    calls,
    toasts: () => store.get().toasts,
    settle: async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

export const commands = () => allCommands();
