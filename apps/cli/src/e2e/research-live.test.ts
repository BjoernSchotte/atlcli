import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildResearchLiveCliCommand,
  captureAndForwardResearchStream,
  normalizeResearchLiveOutputPath,
  parseResearchLiveCliArguments,
  verifyResearchLiveDelivery,
} from "./research-live.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("research public CLI live harness", () => {
  test("builds source and built public-command invocations with explicit safe scopes", () => {
    const root = "/tmp/atlcli-repository";
    const source = parseResearchLiveCliArguments([
      "--output", "/tmp/research-source.md",
      "--project", "ATLCLI,SECOND",
      "--space", "DOCSY",
      "--max-run-minutes", "7",
    ]);
    const sourceCommand = buildResearchLiveCliCommand(source, root);
    expect(sourceCommand).toContain("--conditions=development");
    expect(sourceCommand).toContain("src/index.ts");
    expect(sourceCommand.filter((value) => value === "--project")).toHaveLength(2);
    expect(sourceCommand).toContain("7");

    const built = parseResearchLiveCliArguments([
      "--mode", "built",
      "--output", "/tmp/research-built.md",
    ]);
    expect(buildResearchLiveCliCommand(built, root)).toContain(
      "/tmp/atlcli-repository/dist/index.js",
    );
  });

  test("requires an external absolute Markdown output", () => {
    expect(() => parseResearchLiveCliArguments([])).toThrow("--output must be an absolute path");
    expect(() => normalizeResearchLiveOutputPath("relative.md")).toThrow("absolute");
    expect(() => normalizeResearchLiveOutputPath("/tmp/report.txt")).toThrow(".md");
    expect(() => normalizeResearchLiveOutputPath(
      "/repo/private-report.md",
      "/repo",
    )).toThrow("outside the repository");
  });

  test("verifies exact stdout/file bytes and complete Markdown shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-live-test-"));
    roots.push(root);
    const output = join(root, "nested", "report.md");
    await mkdir(join(root, "nested"));
    const markdown = "# Synthetic report\n\n## Sources\n\n1. Synthetic\n";
    await writeFile(output, markdown);
    await expect(verifyResearchLiveDelivery(markdown, output)).resolves.toBeUndefined();
    await expect(verifyResearchLiveDelivery(`${markdown}\n`, output)).rejects.toThrow("bytes differ");
  });

  test("forwards diagnostics incrementally while retaining exact UTF-8 bytes", async () => {
    const encoded = new TextEncoder().encode("phase=researching\n✓ complete\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 20));
        controller.enqueue(encoded.slice(20, 23));
        controller.enqueue(encoded.slice(23));
        controller.close();
      },
    });
    const forwarded: string[] = [];
    const captured = await captureAndForwardResearchStream(stream, (chunk) => forwarded.push(chunk));
    expect(captured).toBe("phase=researching\n✓ complete\n");
    expect(forwarded.join("")).toBe(captured);
    expect(forwarded.length).toBeGreaterThan(1);
  });
});
