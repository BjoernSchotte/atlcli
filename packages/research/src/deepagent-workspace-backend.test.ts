import { describe, expect, test } from "bun:test";
import {
  CompositeBackend,
  StateBackend,
  createFilesystemMiddleware,
} from "deepagents/node";
import {
  RESEARCH_DEEPAGENT_PLAN_PATH_V1,
  ResearchDeepAgentWorkspaceBackendV1,
} from "./deepagent-workspace-backend.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

describe("DeepAgents durable research workspace backend", () => {
  test("exposes only the virtual workspace route while preserving its durable host projection", async () => {
    const workspace = createMemoryResearchWorkspace();
    await workspace.writeFile(RESEARCH_DEEPAGENT_PLAN_PATH_V1, "# Current plan\n");
    await workspace.writeFile("/artifacts/report.md", "# Private report\n");
    await workspace.writeFile("/.atlcli/checkpoints/secret.json", "host-only");
    const backend = new ResearchDeepAgentWorkspaceBackendV1(workspace);

    await expect(backend.ls("/")).resolves.toEqual({
      files: [{ path: "/plan.md", is_dir: false, size: 15, modified_at: "" }],
    });
    await expect(backend.read("/plan.md")).resolves.toEqual({
      content: "# Current plan\n",
      mimeType: "text/plain",
    });
    await expect(backend.read("/../artifacts/report.md")).resolves.toMatchObject({ error: expect.any(String) });

    await expect(backend.write("/scratch/working-notes.md", "temporary\n")).resolves.toMatchObject({
      path: "/scratch/working-notes.md",
      filesUpdate: null,
    });
    await expect(workspace.readFile("/workspace/scratch/working-notes.md")).resolves.toBe("temporary\n");
    await expect(workspace.readFile("/artifacts/report.md")).resolves.toBe("# Private report\n");
  });

  test("supports bounded native filesystem navigation without host filesystem access", async () => {
    const workspace = createMemoryResearchWorkspace();
    await workspace.writeFile("/workspace/scratch/a.md", "needle\nsecond line\n");
    await workspace.writeFile("/workspace/scratch/nested/b.md", "other needle\n");
    const backend = new ResearchDeepAgentWorkspaceBackendV1(workspace);

    await expect(backend.ls("/scratch")).resolves.toEqual({
      files: [
        { path: "/scratch/a.md", is_dir: false, size: 19, modified_at: "" },
        { path: "/scratch/nested/", is_dir: true, size: 0, modified_at: "" },
      ],
    });
    await expect(backend.grep("needle", "/scratch", "**/*.md")).resolves.toEqual({
      matches: [
        { path: "/scratch/a.md", line: 1, text: "needle" },
        { path: "/scratch/nested/b.md", line: 1, text: "other needle" },
      ],
    });
    await expect(backend.glob("**/*.md", "/scratch")).resolves.toMatchObject({
      files: [{ path: "/scratch/a.md" }, { path: "/scratch/nested/b.md" }],
    });
  });

  test("uses the native DeepAgentsJS filesystem middleware with a read-only plan and writable scratch route", async () => {
    const workspace = createMemoryResearchWorkspace();
    const backend = new CompositeBackend(
      new StateBackend(),
      { "/workspace": new ResearchDeepAgentWorkspaceBackendV1(workspace) },
    );
    const middleware = createFilesystemMiddleware({
      backend,
      tools: ["read_file", "ls", "glob", "grep", "write_file", "edit_file"],
      permissions: [
        { operations: ["read"], paths: ["/workspace/**"] },
        { operations: ["write"], paths: ["/workspace/scratch/**"] },
        { operations: ["read", "write"], paths: ["/**"], mode: "deny" },
      ],
    });
    const writeFile = middleware.tools?.find((candidate) => candidate.name === "write_file");
    if (!writeFile) throw new Error("DeepAgentsJS did not expose write_file.");

    expect(middleware.tools?.map((candidate) => candidate.name)).toEqual([
      "ls", "read_file", "write_file", "edit_file", "glob", "grep",
    ]);
    const denied = await writeFile.invoke({ file_path: "/workspace/plan.md", content: "tamper" });
    expect(String((denied as { content?: unknown }).content ?? denied)).toContain("permission denied");
    await expect(writeFile.invoke({
      file_path: "/workspace/scratch/working-notes.md",
      content: "temporary",
    })).resolves.toMatchObject({ content: expect.stringContaining("Successfully wrote") });
    await expect(workspace.readFile("/workspace/scratch/working-notes.md")).resolves.toBe("temporary");
  });
});
