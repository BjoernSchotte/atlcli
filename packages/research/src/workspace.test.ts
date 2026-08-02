import { afterEach, describe, expect, test } from "bun:test";
import { access, symlink } from "node:fs/promises";
import { createMemoryResearchWorkspace, normalizeResearchWorkspacePath } from "./workspace.js";
import { FileSystemResearchWorkspace } from "./filesystem-workspace.js";

let filesystem: FileSystemResearchWorkspace | undefined;

afterEach(async () => {
  await filesystem?.dispose();
  filesystem = undefined;
});

describe("research workspace paths", () => {
  test("normalizes virtual paths and rejects traversal", () => {
    expect(normalizeResearchWorkspacePath("/artifacts/./report.md")).toBe("/artifacts/report.md");
    expect(() => normalizeResearchWorkspacePath("relative.txt")).toThrow();
    expect(() => normalizeResearchWorkspacePath("/artifacts/../session.json")).toThrow();
  });

  test("memory and filesystem workspaces share the same bounded file contract", async () => {
    const memory = createMemoryResearchWorkspace();
    filesystem = await FileSystemResearchWorkspace.createTemporary("atlcli-research-test-");
    for (const workspace of [memory, filesystem]) {
      await workspace.writeFile("/artifacts/report.md", "# Report\n");
      expect(await workspace.readFile("/artifacts/report.md")).toBe("# Report\n");
      expect(await workspace.list("/artifacts")).toEqual(["/artifacts/report.md"]);
      expect(await workspace.list()).toEqual(["/artifacts/report.md"]);
      await workspace.remove("/artifacts");
      expect(await workspace.readFile("/artifacts/report.md")).toBeUndefined();
    }
  });

  test("filesystem workspace rejects a symlink escape", async () => {
    filesystem = await FileSystemResearchWorkspace.createTemporary("atlcli-research-test-");
    const outside = await FileSystemResearchWorkspace.createTemporary("atlcli-research-outside-");
    try {
      await symlink(outside.root, `${filesystem.root}/escape`);
      await expect(filesystem.writeFile("/escape/secret.txt", "nope")).rejects.toThrow("symlink escape");
      await expect(filesystem.writeFile("/escape/new/secret.txt", "nope")).rejects.toThrow("symlink escape");
      await expect(access(`${outside.root}/new`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await outside.dispose();
    }
  });
});
