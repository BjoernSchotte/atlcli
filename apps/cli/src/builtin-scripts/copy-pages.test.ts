/**
 * The built-in copy-pages script, planned in the real sandbox against a small
 * in-memory Confluence. Apply is the generic plan/apply engine.
 */
import { describe, expect, it } from "bun:test";
import { planScript, type ScriptPort } from "@atlcli/script-runtime";
import source from "./copy-pages.script" with { type: "text" };
import { createTemplateRenderer } from "../commands/template-flags.js";

const script = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);

interface FakePage {
  id: string;
  title: string;
  storage: string;
  children: string[];
  parentId?: string;
  properties?: Record<string, unknown>;
}

function port(extra: FakePage[] = []): ScriptPort {
  const pages = new Map<string, FakePage>(
    [
      { id: "1", title: "Retro template", storage: "<p>Sprint {{sprint}}</p>", children: ["2"], parentId: "9" },
      { id: "2", title: "Actions ({{sprint}})", storage: "<p>Parent: {{parent.title}}</p>", children: [] },
      ...extra,
    ].map((p) => [p.id, p]),
  );
  const write = async (): Promise<never> => {
    throw new Error("planning must never write");
  };
  return {
    render: createTemplateRenderer(),
    confluenceGetPageStorage: async (id: string) => {
      const p = pages.get(id)!;
      return { id, title: p.title, spaceKey: "DOCSY", version: 3, storage: p.storage, properties: p.properties ?? {}, ...(p.parentId ? { parentId: p.parentId } : {}) };
    },
    confluenceGetPage: async (id: string) => ({ id, title: pages.get(id)?.title ?? "x", spaceKey: "DOCSY", version: 1, markdown: "" }),
    confluenceChildren: async (id: string) => pages.get(id)!.children.map((c) => ({ id: c, title: pages.get(c)!.title, spaceKey: "DOCSY" })),
    confluenceAttachments: async (id: string) => (id === "1" ? [{ id: "a1", name: "board.png", mediaType: "image/png", size: 10, version: 1 }] : []),
    confluenceSearch: async (cql: string) => {
      const title = /title = "((?:[^"\\]|\\.)*)"/.exec(cql)![1]!.replace(/\\(.)/g, "$1");
      return { results: [...pages.values()].filter((p) => p.title === title).map((p) => ({ id: p.id, title: p.title, spaceKey: "DOCSY" })) };
    },
    confluenceFindPage: async () => null,
    confluenceCreatePage: write,
    confluenceCopyAttachment: write,
  } as unknown as ScriptPort;
}

const params = { id: "1", space: "", parent: "", title: "Retro {{sprint}}", attachments: true };
const templating = { vars: { sprint: 42 }, now: "2026-10-25T00:00:00.000Z", strict: false };
const plan = (p: ScriptPort, overrides: Partial<typeof params> = {}) => planScript(script, { port: p, params: { ...params, ...overrides }, templating });

describe("copy-pages", () => {
  it("renders titles and bodies, parents first, with parent.title", async () => {
    const run = await plan(port());
    const creates = run.operations.filter((o) => o.verb === "confluence.createPage");
    expect(creates.map((o) => o.args.title)).toEqual(["Retro 42", "Actions (42)"]);
    expect(creates[0]!.args).toMatchObject({ spaceKey: "DOCSY", storage: "<p>Sprint 42</p>", parentId: "9", properties: { "atlcli.copiedFrom": { id: "1", version: 3 } } });
    expect(creates[1]!.args).toMatchObject({ storage: "<p>Parent: Retro 42</p>", parentId: "plan:1" });
    expect(run.operations.filter((o) => o.verb === "confluence.copyAttachment").map((o) => o.args)).toEqual([
      { attachmentId: "a1", sourcePageId: "1", toPageId: "plan:1", name: "board.png", size: 10 },
    ]);
    expect(run.value).toMatchObject({ pages: 2, resumed: 0, attachments: 1 });
  });

  it("goes to the top level of another space without --parent", async () => {
    const run = await plan(port(), { space: "OTHER" });
    expect(run.operations[0]!.args).not.toHaveProperty("parentId");
  });

  it("fails on a title collision with an unrelated page", async () => {
    const error = await plan(port([{ id: "99", title: "Retro 42", storage: "", children: [] }])).catch((e: unknown) => e);
    expect(String(error)).toContain('A page titled "Retro 42" already exists');
  });

  it("resumes: an existing copy of the same source is reused", async () => {
    const run = await plan(port([{ id: "50", title: "Retro 42", storage: "", children: [], properties: { "atlcli.copiedFrom": { id: "1" } } }]));
    expect(run.operations.filter((o) => o.verb === "confluence.createPage").map((o) => o.args.title)).toEqual(["Actions (42)"]);
    expect(run.operations.find((o) => o.verb === "confluence.createPage")!.args.parentId).toBe("50");
    expect(run.value).toMatchObject({ pages: 1, resumed: 1 });
  });

  it("fails when two copies would share a title", async () => {
    const p = port();
    const error = await plan(p, { title: "Actions ({{sprint}})" }).catch((e: unknown) => e);
    expect(String(error)).toContain("Two copies would be titled");
  });
});
