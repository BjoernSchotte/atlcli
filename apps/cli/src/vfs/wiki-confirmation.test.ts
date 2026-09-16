import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { createWikiShell } from "./wiki-shell.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function setup(options: { confirm?: boolean; allowDelete?: boolean; mode?: "ro" | "rw" } = {}) {
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "s1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedSpace({ id: "s2", key: "ATLCLI", name: "Other", homepageId: "200" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Home</p>" })
    .seedPage({ id: "200", title: "Home", spaceKey: "ATLCLI", storage: "<p>Other</p>" })
    .seedPage({ id: "101", title: "Alpha", spaceKey: "DOCSY", parentId: "100", storage: "<p>Fixture</p>" });
  const root = mkdtempSync(join(tmpdir(), "vfs-confirm-"));
  const vfs = await ConfluenceVfsImpl.open({ client, profile: "mayflower", mode: options.mode ?? "rw",
    cacheDir: root, allowDelete: options.allowDelete ?? true, offline: false, coalesceMs: 0 });
  cleanup.push(async () => { await vfs.close(); rmSync(root, { recursive: true, force: true }); });
  const prompts: string[] = [];
  const shell = await createWikiShell({ vfs, spaces: ["DOCSY", "ATLCLI"],
    ...(options.confirm !== undefined ? { confirmMutation: async (message: string) => {
      prompts.push(message); return options.confirm!;
    } } : {}),
  });
  return { shell, client, prompts };
}
function mutations(client: FakeConfluenceClient) {
  return client.calls.filter(({ method }) => /^(create|update|delete|move|copy)/.test(method));
}

describe("terminal mutation confirmation", () => {
  it("declines rm, including force and a dash operand, before writes", async () => {
    const { shell, client, prompts } = await setup({ confirm: false });
    for (const command of ["rm alpha-101.md", "rm -f alpha-101.md", "rm -- -alpha-101.md", "rm -- --help alpha-101.md"]) {
      expect((await shell.exec(command)).exitCode).toBe(1);
    }
    expect(prompts).toHaveLength(4);
    expect(prompts[2]).toContain('"-alpha-101.md"');
    expect(mutations(client)).toEqual([]);
  });

  it("renames within a space without prompting", async () => {
    const { shell, client, prompts } = await setup({ confirm: false });
    expect((await shell.exec("mv alpha-101.md renamed-101.md")).exitCode).toBe(0);
    expect(prompts).toEqual([]);
    expect(mutations(client).length).toBeGreaterThan(0);
  });

  it("declines a cross-space move before copying or deleting", async () => {
    const { shell, client, prompts } = await setup({ confirm: false });
    for (const command of ["mv alpha-101.md /ATLCLI/moved.md", "mv alpha-101.md ../ATLCLI/moved.md"]) {
      const result = await shell.exec(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cancelled");
    }
    expect(prompts).toHaveLength(2);
    expect(mutations(client)).toEqual([]);
  });

  it("keeps noninteractive delete authorization sufficient", async () => {
    const { shell, client } = await setup();
    expect((await shell.exec("rm alpha-101.md")).exitCode).toBe(0);
    expect(client.callsTo("deletePage")).toBe(1);
  });

  it("does not prompt or grant permission when delete is disabled", async () => {
    const { shell, client, prompts } = await setup({ confirm: true, allowDelete: false });
    expect((await shell.exec("rm alpha-101.md")).exitCode).not.toBe(0);
    expect(prompts).toEqual([]);
    expect(mutations(client)).toEqual([]);
  });

  it("does not prompt or write on readonly mounts", async () => {
    const { shell, client, prompts } = await setup({ confirm: true, mode: "ro" });
    expect((await shell.exec("rm alpha-101.md")).exitCode).not.toBe(0);
    expect((await shell.exec("mv alpha-101.md /ATLCLI/moved.md")).exitCode).not.toBe(0);
    expect(prompts).toEqual([]);
    expect(mutations(client)).toEqual([]);
  });
});
