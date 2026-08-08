import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("PDF output-standard CLI boundary", () => {
  it("rejects a raw PDF version before config or network access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-pdf-standard-"));
    try {
      const proc = Bun.spawn([
        process.execPath,
        "--conditions=development",
        "run",
        CLI,
        "wiki",
        "export",
        "123",
        "--format",
        "pdf",
        "--output",
        join(dir, "out.pdf"),
        "--pdf-standard",
        "2.0",
        "--json",
      ], {
        cwd: dir,
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          ATLCLI_DISABLE_UPDATE_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(1);
      const report = JSON.parse(stdout);
      expect(report.schema).toBe("atlcli.export-report/1");
      expect(report.issues[0].code).toBe("usage-error");
      expect(report.issues[0].message).toContain("--pdf-standard must be one of");
      expect(report.issues[0].message).toContain('(got "2.0")');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
