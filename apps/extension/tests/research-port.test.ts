/**
 * The Chrome research port's run guard and its shared request helper. Only
 * `chrome.*` is stubbed; the port itself is the real one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  ResearchContractError,
  type ResearchRequestV1,
} from "@atlcli/research";
import { chromeResearchPort } from "../entrypoints/sidepanel/ports/research.js";

const request: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: "Summarize the attached page.",
  scope: {
    siteOrigin: "https://tenant-a.atlassian.net",
    jiraProjectKeys: [],
    confluenceSpaceKeys: ["DOCSY"],
  },
  limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxRunMs: 60_000 },
  wikiProvider: "rest",
};

interface Sent { kind: string; runId?: string; windowId?: number; [key: string]: unknown }

let sent: Sent[];
let getCurrent: () => Promise<{ id?: number }>;
let respond: (message: Sent) => unknown;
const savedChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

beforeEach(() => {
  sent = [];
  getCurrent = async () => ({ id: 7 });
  respond = (message) => ({ kind: `${message.kind}-result`, runId: message.runId, ok: true, report: {} });
  const storage = new Map<string, unknown>();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      windows: { getCurrent: () => getCurrent() },
      runtime: {
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async (message: Sent) => {
          sent.push(message);
          return respond(message);
        },
      },
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storage.get(key) }),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) storage.set(key, value);
          },
        },
      },
    },
  });
});

afterEach(() => {
  if (savedChrome) Object.defineProperty(globalThis, "chrome", savedChrome);
  else delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("chromeResearchPort run guard", () => {
  it("is usable again after the window lookup rejects", async () => {
    const port = chromeResearchPort();
    getCurrent = async () => {
      throw new Error("no window");
    };
    await expect(port.resume!("research-session:a")).rejects.toThrow("no window");
    await expect(port.run(request)).rejects.toThrow("no window");
    getCurrent = async () => ({ id: 7 });
    await port.resume!("research-session:a");
    await port.run(request);
    expect(sent.map((message) => message.kind)).toEqual(["research:resume", "research:run"]);
  });

  it("is usable again after onSessionStart throws", async () => {
    const port = chromeResearchPort();
    await expect(port.run(request, {
      onSessionStart() {
        throw new Error("listener failed");
      },
    })).rejects.toThrow("listener failed");
    await port.run(request);
  });

  it("rejects a second run that starts while the first is still preparing", async () => {
    const port = chromeResearchPort();
    // Chat mode awaits storage before it reaches the host: the old guard was
    // only set after those awaits, so both calls passed it.
    const [first, second] = await Promise.allSettled([
      port.run(request, { mode: "chat" }),
      port.run(request, { mode: "chat" }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason.message).toBe("A research run is already active.");
    expect(sent.filter((message) => message.kind === "research:run")).toHaveLength(1);
  });
});

describe("chromeResearchPort window-scoped requests", () => {
  it("sends the window id and unwraps the paired result", async () => {
    respond = (message) => ({ kind: `${message.kind}-result`, ok: true, sessions: [{ sessionId: "s" }] });
    const sessions = await chromeResearchPort().listResumableSessions!();
    expect(sessions).toEqual([{ sessionId: "s" }] as never);
    expect(sent).toEqual([{ kind: "research:list-resumable-sessions", windowId: 7 }]);
  });

  it("turns a host refusal into its contract error", async () => {
    respond = (message) => ({ kind: `${message.kind}-result`, ok: false, code: "invalid-request", error: "stale review" });
    const failure = await chromeResearchPort().listPlanReviews!().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResearchContractError);
    expect((failure as ResearchContractError).code).toBe("invalid-request");
    expect((failure as Error).message).toBe("stale review");
  });

  it("rejects an uncorrelated or missing response", async () => {
    respond = () => undefined;
    await expect(chromeResearchPort().listPlanReviews!()).rejects.toThrow(
      "The research plan-review host returned no result.",
    );
    respond = () => ({ kind: "pong" });
    await expect(chromeResearchPort().listScopeReviews!()).rejects.toThrow(
      "The research scope-review host returned no result.",
    );
  });

  it("fails without a side panel window", async () => {
    getCurrent = async () => ({});
    await expect(chromeResearchPort().listPlanReviews!()).rejects.toThrow(
      "The side panel window is unavailable.",
    );
    expect(sent).toEqual([]);
  });
});
