import { describe, expect, test } from "bun:test";
import type { ExportBlock, MacroParameter } from "@atlcli/confluence";
import { diagramMacroRenderer } from "./diagram.js";
import type { AttachmentLookupPort, AttachmentMeta, MacroExportContext } from "./types.js";

function param(name: string, text: string): MacroParameter {
  return { name, text };
}

function lookupPort(available: Set<string>): AttachmentLookupPort {
  return {
    async lookup(_pageId, filename): Promise<AttachmentMeta | undefined> {
      return available.has(filename) ? { filename, version: 1 } : undefined;
    },
  };
}

function ctx(attachments?: AttachmentLookupPort, targetEngine?: "docx" | "pdf" | "web"): MacroExportContext {
  return {
    page: { id: "42" },
    depth: 0,
    visited: new Set(),
    ...(attachments ? { attachments } : {}),
    ...(targetEngine ? { flags: { targetEngine } } : {}),
  };
}

describe("diagramMacroRenderer", () => {
  test("name derivation across macro variants (diagramName / name)", async () => {
    const r = diagramMacroRenderer();
    expect(r.macros).toContain("drawio");
    expect(r.macros).toContain("gliffy");
    const res = await r.render(
      { name: "drawio", params: [param("diagramName", "arch")] },
      ctx(lookupPort(new Set(["arch.png"])), "docx")
    );
    if (res.kind === "blocks") {
      const img = res.blocks[0] as Extract<ExportBlock, { type: "image" }>;
      expect(img.source).toMatchObject({ kind: "attachment", filename: "arch.png", pageId: "42" });
    } else {
      throw new Error("expected blocks");
    }
  });

  test("no name → skip", async () => {
    const res = await diagramMacroRenderer().render({ name: "drawio", params: [] }, ctx(lookupPort(new Set())));
    expect(res.kind).toBe("skip");
  });

  test("no attachments port → skip (never guesses)", async () => {
    const res = await diagramMacroRenderer().render({ name: "drawio", params: [param("name", "x")] }, ctx());
    expect(res.kind).toBe("skip");
  });

  test("missing preview → skip (falls through)", async () => {
    const res = await diagramMacroRenderer().render(
      { name: "drawio", params: [param("name", "x")] },
      ctx(lookupPort(new Set()))
    );
    expect(res.kind).toBe("skip");
  });

  test("PDF prefers SVG when available", async () => {
    const res = await diagramMacroRenderer().render(
      { name: "drawio", params: [param("name", "d")] },
      ctx(lookupPort(new Set(["d.svg", "d.png"])), "pdf")
    );
    if (res.kind === "blocks") {
      const img = res.blocks[0] as Extract<ExportBlock, { type: "image" }>;
      expect((img.source as { filename: string }).filename).toBe("d.svg");
    } else {
      throw new Error("expected blocks");
    }
  });

  test("Web retains the static SVG preview when available", async () => {
    const result = await diagramMacroRenderer().render(
      { name: "drawio", params: [{ name: "name", text: "architecture" }] },
      ctx({
        async lookup(_pageId, filename) {
          return filename === "architecture.svg" ? { filename, version: 1 } : undefined;
        },
      }, "web"),
    );
    expect(result).toMatchObject({
      kind: "blocks",
      blocks: [{ type: "image", source: { kind: "attachment", filename: "architecture.svg" } }],
    });
  });

  test("DOCX stays on PNG even when an SVG preview exists (TODO T1.15)", async () => {
    const res = await diagramMacroRenderer().render(
      { name: "drawio", params: [param("name", "d")] },
      ctx(lookupPort(new Set(["d.svg", "d.png"])), "docx")
    );
    if (res.kind === "blocks") {
      const img = res.blocks[0] as Extract<ExportBlock, { type: "image" }>;
      expect((img.source as { filename: string }).filename).toBe("d.png");
    } else {
      throw new Error("expected blocks");
    }
  });
});
