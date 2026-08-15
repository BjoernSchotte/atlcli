import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
const EXPORT_BENCHMARK_TIMEOUT_MS = 120_000;
const script = fileURLToPath(
  new URL("./run-export-job-baseline.ts", import.meta.url),
);

afterAll(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("POST-QUEUE Node export benchmark", () => {
  it("records real durable 50-page TypeScript DOCX and Typst PDF jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-job-bench-test-"));
    roots.push(root);
    const out = join(root, "result.json");
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        script,
        "--pages",
        "50",
        "--formats",
        "docx,pdf",
        "--repeat",
        "1",
        "--seed",
        "2654435769",
        "--out",
        out,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain(`Wrote ${out}`);

    const report = JSON.parse(await readFile(out, "utf8"));
    expect(report).toMatchObject({
      schema: "atlcli.post-queue-export-baseline/1",
      shape: "node-cli",
      state: "post-queue",
      configuration: {
        pages: [50],
        formats: ["docx", "pdf"],
        repeat: 1,
        seed: 2654435769,
      },
    });
    expect(report.results).toHaveLength(2);
    expect(report.results.map((result: { format: string }) => result.format))
      .toEqual(["docx", "pdf"]);
    for (const result of report.results) {
      expect(result.artifactBytes).toBeGreaterThan(0);
      expect(result.durableRequestBytes).toBeGreaterThan(0);
      expect(result.spool.sourceBytes).toBeGreaterThan(0);
      expect(result.spool.assetBytes).toBeGreaterThan(0);
      expect(result.spool.preparedBytes).toBeGreaterThan(0);
      expect(result.physicalStateBytes).toBeGreaterThan(result.artifactBytes);
      expect(result).toMatchObject({
        pages: 50,
        state: "succeeded",
        counts: { pages: 50, imageAssets: 10, diagramAssets: 5 },
      });
    }
  }, EXPORT_BENCHMARK_TIMEOUT_MS);
});
