import { describe, expect, test } from "bun:test";
import type { ExportBlock, ExportNote, StorageToBlocksResult } from "@atlcli/confluence";
import { resolveMacroBlocks } from "./resolve.js";
import { createRegistry } from "./registry.js";
import { portError } from "./types.js";
import type {
  JiraIssuePort,
  JiraIssueRef,
  MacroExportContext,
  MacroRenderer,
} from "./types.js";

function unknownBlock(macroName: string, extra: Partial<Extract<ExportBlock, { type: "unknown" }>> = {}): ExportBlock {
  return { type: "unknown", macroName, ...extra };
}

function walkerNote(macroName: string, code = "unknown-macro"): ExportNote {
  return { level: "warning", code, message: `${macroName} placeholder`, macroName };
}

function ctx(overrides: Partial<MacroExportContext> = {}): MacroExportContext {
  return { page: { id: "1" }, depth: 0, visited: new Set(), ...overrides };
}

/** A renderer that always returns a single paragraph for the named macro. */
function paraRenderer(id: string, macro: string, text: string): MacroRenderer {
  return {
    id,
    macros: [macro],
    requiresLivePort: false,
    async render() {
      return {
        kind: "blocks",
        blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
      };
    },
  };
}

function skipRenderer(id: string, macro: string, note?: ExportNote): MacroRenderer {
  return {
    id,
    macros: [macro],
    requiresLivePort: false,
    async render() {
      return { kind: "skip", ...(note ? { notes: [note] } : {}) };
    },
  };
}

describe("resolveMacroBlocks — fallback chain", () => {
  test("first matching renderer wins", async () => {
    const registry = createRegistry([
      paraRenderer("first", "widget", "FIRST"),
      paraRenderer("second-catchall", "*", "SECOND"),
    ]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("widget")],
      notes: [walkerNote("widget")],
    };
    const out = await resolveMacroBlocks(input, registry, ctx());
    expect(out.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "FIRST" }] }]);
  });

  test("skip falls through to the catch-all", async () => {
    const registry = createRegistry([
      skipRenderer("specific", "widget"),
      paraRenderer("catchall", "*", "CATCH"),
    ]);
    const input: StorageToBlocksResult = { blocks: [unknownBlock("widget")], notes: [walkerNote("widget")] };
    const out = await resolveMacroBlocks(input, registry, ctx());
    expect(out.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "CATCH" }] }]);
  });

  test("skip all the way falls through to placeholder floor (block kept)", async () => {
    const registry = createRegistry([skipRenderer("specific", "widget")]);
    const block = unknownBlock("widget");
    const input: StorageToBlocksResult = { blocks: [block], notes: [walkerNote("widget")] };
    const out = await resolveMacroBlocks(input, registry, ctx());
    expect(out.blocks).toEqual([block]);
    expect(out.notes.some((n) => n.code === "macro-degraded")).toBe(true);
    // Walker's original note is replaced (outcome ownership), not duplicated.
    expect(out.notes.some((n) => n.code === "unknown-macro")).toBe(false);
  });

  test("nested-container traversal: unknown inside a table cell and a callout", async () => {
    const registry = createRegistry([paraRenderer("w", "widget", "OK")]);
    const input: StorageToBlocksResult = {
      blocks: [
        {
          type: "table",
          rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [unknownBlock("widget")] }] }],
        },
        { type: "callout", kind: "info", content: [unknownBlock("widget")] },
      ],
      notes: [walkerNote("widget"), walkerNote("widget")],
    };
    const out = await resolveMacroBlocks(input, registry, ctx());
    const table = out.blocks[0] as Extract<ExportBlock, { type: "table" }>;
    expect(table.rows[0].cells[0].content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "OK" }],
    });
    const callout = out.blocks[1] as Extract<ExportBlock, { type: "callout" }>;
    expect(callout.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "OK" }] });
  });

  test("no unknown blocks → notes/blocks pass through unchanged", async () => {
    const registry = createRegistry([paraRenderer("w", "widget", "x")]);
    const input: StorageToBlocksResult = {
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      notes: [{ level: "info", code: "other", message: "keep" }],
    };
    const out = await resolveMacroBlocks(input, registry, ctx());
    expect(out.blocks).toEqual(input.blocks);
    expect(out.notes).toEqual(input.notes);
  });
});

describe("resolveMacroBlocks — outcome ownership / positional note matching", () => {
  test("two same-named macros, only one resolves → two distinct notes, interleaved unrelated note preserved", async () => {
    // widget#1 resolves (specific renderer), widget#2 also matches specific but
    // we use a renderer that resolves ALL widgets — so distinguish by content
    // via a stateful renderer: first call renders, second skips.
    let calls = 0;
    const flaky: MacroRenderer = {
      id: "flaky",
      macros: ["widget"],
      requiresLivePort: false,
      async render() {
        calls += 1;
        if (calls === 1) return { kind: "blocks", blocks: [{ type: "paragraph", content: [{ type: "text", text: "R" }] }] };
        return { kind: "skip" };
      },
    };
    const registry = createRegistry([flaky]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("widget"), unknownBlock("widget")],
      notes: [
        walkerNote("widget"),
        { level: "info", code: "image-unresolved", message: "unrelated" },
        walkerNote("widget"),
      ],
    };
    const out = await resolveMacroBlocks(input, registry, ctx({ budget: { concurrency: 1 } }));
    // The unrelated note survives in place.
    expect(out.notes.some((n) => n.code === "image-unresolved")).toBe(true);
    // First macro rendered, second degraded — exactly one of each, no leftover walker note.
    expect(out.notes.filter((n) => n.code === "macro-rendered-via").length).toBe(1);
    expect(out.notes.filter((n) => n.code === "macro-degraded").length).toBe(1);
    expect(out.notes.some((n) => n.code === "unknown-macro")).toBe(false);
  });
});

describe("resolveMacroBlocks — concurrency & ordering", () => {
  test("a slow first macro never pushes a fast second out of document order", async () => {
    const slow: MacroRenderer = {
      id: "slow",
      macros: ["slow"],
      requiresLivePort: false,
      async render() {
        await new Promise((r) => setTimeout(r, 30));
        return { kind: "blocks", blocks: [{ type: "paragraph", content: [{ type: "text", text: "SLOW" }] }] };
      },
    };
    const fast = paraRenderer("fast", "fast", "FAST");
    const registry = createRegistry([slow, fast]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("slow"), unknownBlock("fast")],
      notes: [walkerNote("slow"), walkerNote("fast")],
    };
    const out = await resolveMacroBlocks(input, registry, ctx({ budget: { concurrency: 4 } }));
    expect((out.blocks[0] as { content: { text: string }[] }).content[0].text).toBe("SLOW");
    expect((out.blocks[1] as { content: { text: string }[] }).content[0].text).toBe("FAST");
  });
});

describe("resolveMacroBlocks — dedup", () => {
  function jiraPort(counter: { n: number }): JiraIssuePort {
    return {
      async getIssue(key): Promise<JiraIssueRef> {
        counter.n += 1;
        return { key, summary: "s", status: "Done", statusColor: "green", url: `/browse/${key}` };
      },
      async searchJql(_jql, opts): Promise<JiraIssueRef[]> {
        counter.n += 1;
        return Array.from({ length: opts.maximumIssues }, (_v, i) => ({
          key: `K-${i}`,
          summary: "s",
          status: "Done",
          statusColor: "green",
          url: `/browse/K-${i}`,
        }));
      },
    };
  }

  const jiraCaller = (id: string): MacroRenderer => ({
    id,
    macros: [id],
    requiresLivePort: true,
    async render(_m, c) {
      const issues = await c.jira!.searchJql("project = X", { columns: ["key"], maximumIssues: 2 });
      return { kind: "blocks", blocks: [{ type: "paragraph", content: [{ type: "text", text: `${issues.length}` }] }] };
    },
  });

  test("identical port calls count once", async () => {
    const counter = { n: 0 };
    const registry = createRegistry([jiraCaller("a"), jiraCaller("b")]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("a"), unknownBlock("b")],
      notes: [walkerNote("a"), walkerNote("b")],
    };
    await resolveMacroBlocks(input, registry, ctx({ jira: jiraPort(counter) }));
    expect(counter.n).toBe(1);
  });

  test("identical jql with different columns count as two", async () => {
    const counter = { n: 0 };
    const renderer = (id: string, cols: string[]): MacroRenderer => ({
      id,
      macros: [id],
      requiresLivePort: true,
      async render(_m, c) {
        await c.jira!.searchJql("project = X", { columns: cols, maximumIssues: 2 });
        return { kind: "blocks", blocks: [] };
      },
    });
    const registry = createRegistry([renderer("a", ["key"]), renderer("b", ["key", "status"])]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("a"), unknownBlock("b")],
      notes: [walkerNote("a"), walkerNote("b")],
    };
    await resolveMacroBlocks(input, registry, ctx({ jira: jiraPort(counter) }));
    expect(counter.n).toBe(2);
  });
});

describe("resolveMacroBlocks — circuit breaker", () => {
  test("a rate-limited error stops further calls to the same service", async () => {
    let calls = 0;
    const jira: JiraIssuePort = {
      async getIssue(key): Promise<JiraIssueRef> {
        calls += 1;
        throw portError("rate-limited", "429", { service: "jira", retryAfterMs: 1000 });
      },
      async searchJql(): Promise<JiraIssueRef[]> {
        calls += 1;
        throw portError("rate-limited", "429", { service: "jira" });
      },
    };
    const caller = (id: string): MacroRenderer => ({
      id,
      macros: [id],
      requiresLivePort: true,
      async render(_m, c) {
        try {
          await c.jira!.getIssue(`${id}-1`);
          return { kind: "blocks", blocks: [] };
        } catch {
          return { kind: "skip" };
        }
      },
    });
    const registry = createRegistry([caller("a"), caller("b"), caller("c")]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("a"), unknownBlock("b"), unknownBlock("c")],
      notes: [walkerNote("a"), walkerNote("b"), walkerNote("c")],
    };
    // concurrency 1 so the breaker opens before the later instances run.
    await resolveMacroBlocks(input, registry, ctx({ jira, budget: { concurrency: 1 } }));
    // Only the first instance actually hits the port; the rest short-circuit.
    expect(calls).toBe(1);
  });

  test("breaker is keyed by service+siteId — a rate-limited site A never short-circuits site B", async () => {
    const calls: string[] = [];
    const jiraFor = (site: string): JiraIssuePort => ({
      async getIssue(): Promise<JiraIssueRef> {
        calls.push(site);
        if (site === "site-a") throw portError("rate-limited", "429", { service: "jira" });
        return { key: "B-1", summary: "s", status: "Done", statusColor: "green", url: "/browse/B-1" };
      },
      async searchJql(): Promise<JiraIssueRef[]> {
        return [];
      },
    });
    const caller: MacroRenderer = {
      id: "j",
      macros: ["j"],
      requiresLivePort: true,
      async render(_m, c) {
        try {
          await c.jira!.getIssue("X");
          return { kind: "blocks", blocks: [] };
        } catch {
          return { kind: "skip" };
        }
      },
    };
    const registry = createRegistry([caller]);
    const input: StorageToBlocksResult = {
      blocks: [
        unknownBlock("j", { sourcePage: { id: "a1" } }),
        unknownBlock("j", { sourcePage: { id: "b1" } }),
      ],
      notes: [walkerNote("j"), walkerNote("j")],
    };
    await resolveMacroBlocks(input, registry, ctx({ budget: { concurrency: 1 } }), {
      contextFor: (page) =>
        page?.id === "a1"
          ? { ...ctx({ jira: jiraFor("site-a") }), siteId: "site-a" }
          : { ...ctx({ jira: jiraFor("site-b") }), siteId: "site-b" },
    });
    // Site B's port is still called even though site A's breaker is open.
    expect(calls).toEqual(["site-a", "site-b"]);
  });
});

describe("resolveMacroBlocks — abort & guards", () => {
  test("an already-aborted signal stops the whole pass", async () => {
    const registry = createRegistry([paraRenderer("w", "widget", "x")]);
    const controller = new AbortController();
    controller.abort();
    const input: StorageToBlocksResult = { blocks: [unknownBlock("widget")], notes: [walkerNote("widget")] };
    await expect(resolveMacroBlocks(input, registry, ctx({ signal: controller.signal }))).rejects.toThrow();
  });

  test("deadline degrades unresolved instances to skipped-by-config", async () => {
    let clock = 0;
    const registry = createRegistry([paraRenderer("w", "widget", "x")]);
    const input: StorageToBlocksResult = { blocks: [unknownBlock("widget")], notes: [walkerNote("widget")] };
    const out = await resolveMacroBlocks(
      input,
      registry,
      ctx({ budget: { deadlineMs: 10, now: () => (clock += 100) } })
    );
    expect(out.notes.some((n) => n.code === "macro-skipped-by-config")).toBe(true);
  });
});

describe("resolveMacroBlocks — determinism switch", () => {
  test("live=false suppresses requiresLivePort renderers but runs pure ones", async () => {
    const livePure = paraRenderer("pure", "puremacro", "PURE"); // requiresLivePort false
    const liveRenderer: MacroRenderer = {
      id: "live",
      macros: ["livemacro"],
      requiresLivePort: true,
      async render() {
        return { kind: "blocks", blocks: [{ type: "paragraph", content: [{ type: "text", text: "LIVE" }] }] };
      },
    };
    const registry = createRegistry([livePure, liveRenderer]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("puremacro"), unknownBlock("livemacro")],
      notes: [walkerNote("puremacro"), walkerNote("livemacro")],
    };
    const out = await resolveMacroBlocks(input, registry, ctx(), { live: false });
    // pure macro rendered
    expect((out.blocks[0] as { content: { text: string }[] }).content[0].text).toBe("PURE");
    // live macro skipped to placeholder floor (kept as unknown)
    expect(out.blocks[1].type).toBe("unknown");
    expect(out.notes.some((n) => n.code === "macro-skipped-by-config")).toBe(true);
  });
});

describe("resolveMacroBlocks — bodyNotes promotion (001 deferral)", () => {
  const bodyNote: ExportNote = { level: "warning", code: "image-unresolved", message: "in body" };

  test("placeholder floor surfaces bodyNotes", async () => {
    const registry = createRegistry([skipRenderer("s", "widget")]);
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("widget", { bodyNotes: [bodyNote] })],
      notes: [walkerNote("widget")],
    };
    const out = await resolveMacroBlocks(input, registry, ctx());
    expect(out.notes.some((n) => n.message === "in body")).toBe(true);
  });

  test("a transparent-body renderer (bodyConsumed) promotes bodyNotes", async () => {
    const passthrough: MacroRenderer = {
      id: "pass",
      macros: ["widget"],
      requiresLivePort: false,
      async render(m) {
        return { kind: "blocks", blocks: m.body ?? [], bodyConsumed: true };
      },
    };
    const registry = createRegistry([passthrough]);
    const input: StorageToBlocksResult = {
      blocks: [
        unknownBlock("widget", {
          body: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
          bodyNotes: [bodyNote],
        }),
      ],
      notes: [walkerNote("widget")],
    };
    const out = await resolveMacroBlocks(input, registry, ctx());
    expect(out.notes.some((n) => n.message === "in body")).toBe(true);
  });

  test("a port-backed renderer that supersedes the body drops bodyNotes", async () => {
    const registry = createRegistry([paraRenderer("w", "widget", "PORT")]); // no bodyConsumed
    const input: StorageToBlocksResult = {
      blocks: [unknownBlock("widget", { bodyNotes: [bodyNote] })],
      notes: [walkerNote("widget")],
    };
    const out = await resolveMacroBlocks(input, registry, ctx());
    expect(out.notes.some((n) => n.message === "in body")).toBe(false);
  });
});
