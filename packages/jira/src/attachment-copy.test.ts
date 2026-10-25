import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "@atlcli/core";
import { copyAttachment } from "./attachment-copy.js";
import { JiraClient } from "./client.js";

// 12 MB: above the script sandbox's 10 MB inline cap, which this path avoids.
const bytes = new Uint8Array(12 * 1024 * 1024).map((_, i) => (i * 31) % 251);
let server: ReturnType<typeof Bun.serve>;
let uploads: Array<{ issue: string; name: string; data: Uint8Array }>;
let reportedSize: number;
let tempRoot: string;

const client = () =>
  new JiraClient({ name: "t", baseUrl: `http://127.0.0.1:${server.port}`, auth: { type: "apiToken", email: "e@x", token: "t" } } as Profile);

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/attachment/10")) {
        return Response.json({ id: "10", filename: "evidence.bin", size: reportedSize, mimeType: "application/octet-stream", content: `${url.origin}/content/10` });
      }
      if (url.pathname === "/content/10") return new Response(bytes);
      const upload = url.pathname.match(/\/issue\/([^/]+)\/attachments$/);
      if (upload && req.method === "POST") {
        const file = (await req.formData()).get("file") as File;
        uploads.push({ issue: upload[1], name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
        return Response.json([{ id: "99", filename: file.name, size: file.size }]);
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  uploads = [];
  reportedSize = bytes.length;
  tempRoot = mkdtempSync(join(tmpdir(), "atlcli-copy-test-"));
});

describe("copyAttachment", () => {
  test("copies the bytes through a temp file and removes it", async () => {
    const result = await copyAttachment(client(), "10", "NEW-1", { tempRoot });
    expect(result.id).toBe("99");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].issue).toBe("NEW-1");
    expect(uploads[0].name).toBe("evidence.bin");
    expect(Bun.hash(uploads[0].data)).toBe(Bun.hash(bytes));
    expect(readdirSync(tempRoot)).toEqual([]);
    rmSync(tempRoot, { recursive: true });
  });

  test("a size mismatch uploads nothing and still cleans up", async () => {
    reportedSize = bytes.length + 1;
    await expect(copyAttachment(client(), "10", "NEW-1", { tempRoot })).rejects.toThrow(/expected .*nothing uploaded/);
    expect(uploads).toEqual([]);
    expect(readdirSync(tempRoot)).toEqual([]);
    rmSync(tempRoot, { recursive: true });
  });

  test("an aborted copy uploads nothing and cleans up", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(copyAttachment(client(), "10", "NEW-1", { tempRoot, signal: controller.signal })).rejects.toThrow();
    expect(uploads).toEqual([]);
    expect(readdirSync(tempRoot)).toEqual([]);
    rmSync(tempRoot, { recursive: true });
  });
});
