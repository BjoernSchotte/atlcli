import { describe, expect, test } from "bun:test";
import {
  ACTION_IDS,
  isStructuredCloneSafeV1,
  type ActionExecutionRequestV1,
  type ActionResultV1,
} from "@atlcli/action-registry";
import {
  createActionPaletteBackgroundHostV1,
  createExtensionActionPaletteExecutorsV1,
  type ActionPaletteExecutorEntryV1,
} from "../utils/action-palette/background-host.js";
import {
  EXTENSION_ACTION_CAPABILITIES_V1,
  EXTENSION_ACTION_MODULES_V1,
  EXTENSION_CONTRIBUTION_INTENT_KINDS_V1,
  SYNTHETIC_EXTENSION_ACTION_MODULE_V1,
} from "../utils/action-palette/catalog.js";
import type { ActionPaletteSenderV1, ActionPaletteTabV1 } from "../utils/action-palette/context.js";

const syntheticId = "atlcli.test.synthetic-action";
const sender: ActionPaletteSenderV1 = {
  tabId: 4,
  documentId: "doc-1",
  frameId: 0,
  origin: "https://fixture.atlassian.net",
  url: "https://fixture.atlassian.net/wiki/spaces/DOC/pages/77/Fixture",
};

function syntheticExecutor(
  execute: ActionPaletteExecutorEntryV1["execute"] = async () => ({ status: "completed", messageKey: "atlcli.test.done" }),
  overrides: Partial<ActionPaletteExecutorEntryV1> = {},
): ActionPaletteExecutorEntryV1 {
  return {
    actionId: syntheticId,
    capability: EXTENSION_ACTION_CAPABILITIES_V1.synthetic,
    effect: "read",
    intentKind: "contribution.extension-test",
    execute,
    ...overrides,
  };
}

function harness(executors: readonly ActionPaletteExecutorEntryV1[] = [syntheticExecutor()]) {
  let now = Date.parse("2026-08-11T12:00:00.000Z");
  let tab: ActionPaletteTabV1 | undefined = { id: 4, url: sender.url };
  let revision = 0;
  const host = createActionPaletteBackgroundHostV1({
    getTab: async () => tab,
    executors,
    modules: [...EXTENSION_ACTION_MODULES_V1, SYNTHETIC_EXTENSION_ACTION_MODULE_V1],
    allowedContributionIntentKinds: EXTENSION_CONTRIBUTION_INTENT_KINDS_V1,
    now: () => now,
    randomId: () => `revision:${++revision}`,
    leaseMs: 500,
  });
  const catalog = (requestId = "catalog:1", messageSender = sender) => host.handle({
    kind: "action-palette:catalog", requestId, locale: "en-US",
  }, messageSender);
  const execute = (catalogRevision: string, requestId = "execute:1", messageSender = sender) => host.handle({
    kind: "action-palette:execute", requestId, catalogRevision,
    actionId: syntheticId, locale: "en-US", input: { fixture: "yes" },
  }, messageSender);
  return {
    host, catalog, execute,
    setTab(value: ActionPaletteTabV1 | undefined) { tab = value; },
    advance(ms: number) { now += ms; },
  };
}

function revisionOf(response: Awaited<ReturnType<ReturnType<typeof harness>["catalog"]>>): string {
  if (response.kind !== "action-palette:catalog-result") throw new Error(response.kind);
  return response.catalog.revision;
}

describe("authoritative action palette background host", () => {
  test("keeps the production executor allowlist exhaustive and adapter-backed", () => {
    const exportRunner = async (): Promise<ActionResultV1> => ({
      status: "completed", messageKey: "atlcli.test.done",
    });
    const entries = createExtensionActionPaletteExecutorsV1({
      queueSurface: async () => undefined,
      exportPdf: exportRunner,
      exportDocx: exportRunner,
      quickAsk: exportRunner,
    });
    expect(entries.map((entry) => entry.actionId).sort()).toEqual(Object.values(ACTION_IDS).sort());
    expect(new Set(entries.map((entry) => entry.capability))).toEqual(new Set([
      EXTENSION_ACTION_CAPABILITIES_V1.pdf,
      EXTENSION_ACTION_CAPABILITIES_V1.docx,
      EXTENSION_ACTION_CAPABILITIES_V1.surface,
      EXTENSION_ACTION_CAPABILITIES_V1.ai,
    ]));
    expect(entries.some((entry) => entry.actionId === syntheticId)).toBe(false);
    expect(EXTENSION_ACTION_MODULES_V1.flatMap((module) => module.actions)
      .some((action) => action.id === syntheticId)).toBe(false);
  });

  test("derives capabilities from registered adapters and executes the synthetic module normally", async () => {
    const calls: ActionExecutionRequestV1[] = [];
    const h = harness([syntheticExecutor(async (request) => {
      calls.push(request);
      return { status: "completed", messageKey: "atlcli.test.done" };
    })]);
    expect(h.host.capabilities).toEqual([EXTENSION_ACTION_CAPABILITIES_V1.synthetic]);
    const listed = await h.catalog();
    expect(listed.kind).toBe("action-palette:catalog-result");
    if (listed.kind !== "action-palette:catalog-result") return;
    const synthetic = listed.catalog.modules.flatMap((module) => module.actions).find((action) => action.id === syntheticId);
    expect(synthetic?.intent.kind).toBe("contribution.extension-test");
    const result = await h.execute(listed.catalog.revision);
    expect(result).toMatchObject({ kind: "action-palette:execute-result", result: { status: "completed" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actionId: syntheticId,
      context: { siteOrigin: "https://fixture.atlassian.net", product: "confluence" },
      input: { fixture: "yes" },
    });
    expect(isStructuredCloneSafeV1(result)).toBe(true);
  });

  test("missing capabilities, unknown actions, unknown intents, and effect mismatches fail closed", async () => {
    const noExecutor = harness([]);
    const list = await noExecutor.catalog();
    const revision = revisionOf(list);
    expect(await noExecutor.execute(revision)).toMatchObject({ kind: "action-palette:error", code: "unknown-action" });

    const wrongIntent = harness([syntheticExecutor(undefined, { intentKind: "surface.open" })]);
    expect(await wrongIntent.execute(revisionOf(await wrongIntent.catalog()))).toMatchObject({
      kind: "action-palette:error", code: "unknown-action",
    });
    const wrongEffect = harness([syntheticExecutor(undefined, { effect: "write" })]);
    expect(await wrongEffect.execute(revisionOf(await wrongEffect.catalog()))).toMatchObject({
      kind: "action-palette:error", code: "effect-denied",
    });
  });

  test("rejects navigation, tab switch, document replacement, stale origins, and expired catalogs", async () => {
    const h = harness();
    const revision = revisionOf(await h.catalog());
    h.setTab({ id: 4, url: "https://fixture.atlassian.net/wiki/spaces/DOC/pages/88/Other" });
    expect(await h.execute(revision)).toMatchObject({ kind: "action-palette:error", code: "stale-context" });
    h.setTab({ id: 4, url: sender.url });
    expect(await h.execute(revision, "execute:2", { ...sender, documentId: "doc-2" })).toMatchObject({
      kind: "action-palette:error", code: "stale-context",
    });
    expect(await h.execute(revision, "execute:3", { ...sender, tabId: 9 })).toMatchObject({
      kind: "action-palette:error", code: "unsupported-context",
    });
    expect(await h.execute(revision, "execute:4", { ...sender, origin: "https://evil.atlassian.net" })).toMatchObject({
      kind: "action-palette:error", code: "stale-context",
    });
    h.advance(501);
    expect(await h.execute(revision, "execute:5")).toMatchObject({
      kind: "action-palette:error", code: "catalog-expired",
    });
  });

  test("lets a slow executor revalidate the sender binding immediately before commit", async () => {
    let navigate = (): void => undefined;
    const h = harness([syntheticExecutor(async (_request, _signal, assertContextCurrent) => {
      navigate();
      await assertContextCurrent();
      return { status: "completed", messageKey: "atlcli.test.done" };
    })]);
    navigate = () => h.setTab({
      id: 4,
      url: "https://fixture.atlassian.net/wiki/spaces/DOC/pages/88/Other",
    });
    expect(await h.execute(revisionOf(await h.catalog()))).toMatchObject({
      kind: "action-palette:error",
      code: "stale-context",
      retryable: true,
    });
  });

  test("spoofed authority fields are rejected before any executor is reached", async () => {
    let calls = 0;
    const h = harness([syntheticExecutor(async () => {
      calls += 1;
      return { status: "completed", messageKey: "atlcli.test.done" };
    })]);
    const revision = revisionOf(await h.catalog());
    const result = await h.host.handle({
      kind: "action-palette:execute", requestId: "spoof:1", catalogRevision: revision,
      actionId: syntheticId, locale: "en-US", siteOrigin: "https://evil.atlassian.net",
    }, sender);
    expect(result).toMatchObject({ kind: "action-palette:error", code: "invalid-request" });
    expect(calls).toBe(0);
  });

  test("revalidates action input and strips malformed executor results", async () => {
    let calls = 0;
    const h = harness([syntheticExecutor(async () => {
      calls += 1;
      return {
        status: "completed",
        messageKey: "atlcli.test.done",
        rawTenant: "must-not-cross",
      } as unknown as ActionResultV1;
    })]);
    const revision = revisionOf(await h.catalog());
    const invalidInput = await h.host.handle({
      kind: "action-palette:execute", requestId: "invalid-input", catalogRevision: revision,
      actionId: syntheticId, locale: "en-US", input: { fixture: "no" },
    }, sender);
    expect(invalidInput).toMatchObject({ kind: "action-palette:error", code: "invalid-request" });
    expect(calls).toBe(0);
    const malformedResult = await h.execute(revision, "malformed-result");
    expect(malformedResult).toMatchObject({ kind: "action-palette:error", code: "execution-failed" });
    expect(JSON.stringify(malformedResult)).not.toContain("must-not-cross");
  });

  test("propagates abort/control to an in-flight executor", async () => {
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([syntheticExecutor(async (_request, signal) => {
      observedSignal = signal;
      await pending;
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { status: "completed", messageKey: "atlcli.test.done" };
    })]);
    const revision = revisionOf(await h.catalog());
    const execution = h.execute(revision, "execute:abort");
    await Promise.resolve();
    await Promise.resolve();
    const control = await h.host.handle({
      kind: "action-palette:stream-control", requestId: "control:1",
      executionId: "execute:abort", command: "abort",
    }, sender);
    expect(control).toMatchObject({ kind: "action-palette:stream-control-result", accepted: true });
    expect(observedSignal?.aborted).toBe(true);
    release?.();
    expect(await execution).toMatchObject({ kind: "action-palette:error", code: "execution-failed" });
  });
});
