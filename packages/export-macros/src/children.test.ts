import { describe, expect, test } from "bun:test";
import type { ExportBlock, MacroParameter } from "@atlcli/confluence";
import { childrenRenderer } from "./children.js";
import type { ConfluenceContentPort, MacroExportContext } from "./types.js";

function param(name: string, text: string): MacroParameter {
  return { name, text };
}

function ctx(confluence: ConfluenceContentPort): MacroExportContext {
  return { page: { id: "root" }, depth: 0, visited: new Set(), confluence };
}

function port(children: { id: string; title: string }[]): ConfluenceContentPort {
  return {
    async getPageStorage() {
      return undefined;
    },
    async getChildren(_id, opts) {
      const limit = opts?.limit ?? children.length;
      return children.slice(0, limit);
    },
    async searchCql() {
      return [];
    },
  };
}

describe("childrenRenderer", () => {
  test("empty children → empty list (not skip)", async () => {
    const res = await childrenRenderer().render({ name: "children", params: [] }, ctx(port([])));
    expect(res.kind).toBe("blocks");
    if (res.kind === "blocks") {
      expect(res.blocks[0]).toEqual({ type: "list", ordered: false, items: [] });
    }
  });

  test("deterministic title sort regardless of port order", async () => {
    const res = await childrenRenderer().render(
      { name: "children", params: [] },
      ctx(port([
        { id: "3", title: "Charlie" },
        { id: "1", title: "Alpha" },
        { id: "2", title: "Bravo" },
      ]))
    );
    if (res.kind === "blocks") {
      const list = res.blocks[0] as Extract<ExportBlock, { type: "list" }>;
      const titles = list.items.map((i) => {
        const para = i.content[0] as Extract<ExportBlock, { type: "paragraph" }>;
        const link = para.content[0] as { content: { text: string }[] };
        return link.content[0].text;
      });
      expect(titles).toEqual(["Alpha", "Bravo", "Charlie"]);
    }
  });

  test("cap truncates with a degraded note", async () => {
    const many = Array.from({ length: 60 }, (_v, i) => ({ id: `${i}`, title: `P${String(i).padStart(3, "0")}` }));
    const res = await childrenRenderer().render({ name: "children", params: [] }, ctx(port(many)));
    if (res.kind === "blocks") {
      const list = res.blocks[0] as Extract<ExportBlock, { type: "list" }>;
      expect(list.items.length).toBe(50);
      expect(res.notes?.some((n) => n.code === "macro-degraded")).toBe(true);
    } else {
      throw new Error("expected blocks");
    }
  });

  test("unsupported sort param → note + title order fallback", async () => {
    const res = await childrenRenderer().render(
      { name: "children", params: [param("sort", "modified")] },
      ctx(port([{ id: "1", title: "A" }]))
    );
    if (res.kind === "blocks") {
      expect(res.notes?.some((n) => /unsupported sort/.test(n.message))).toBe(true);
    }
  });
});
