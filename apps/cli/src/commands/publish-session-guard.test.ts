/**
 * Regression #308: `wiki publish plan` used a browser-only `session` profile
 * and sent requests with it. Real CLI against a recording stand-in server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../../../../public/examples/publish-starlight.json", import.meta.url));
let server: ReturnType<typeof Bun.serve>;
let home: string;
const requests: string[] = [];

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: (req) => (requests.push(new URL(req.url).pathname), Response.json({})) });
  home = await mkdtemp(join(tmpdir(), "atlcli-publish-session-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({ currentProfile: "browser", profiles: { browser: { name: "browser", baseUrl: server.url.origin, auth: { type: "session" } } } })
  );
  await copyFile(EXAMPLE, join(home, "publish.json"));
});

afterAll(async () => {
  server?.stop(true);
  await rm(home, { recursive: true, force: true });
});

test.each(["plan", "refresh", "run"])("wiki publish %s refuses a session profile before any request", async (operation) => {
  const proc = Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, "wiki", "publish", operation, "--project", "./publish.json", "--workspace", "./ws", "--json"],
    { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_DISABLE_UPDATE_CHECK: "1" }, stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(1);
  const error = JSON.parse(stdout).error;
  expect(error.code).toBe("ATLCLI_ERR_AUTH");
  expect(error.message).toContain('auth type "session" is only supported in browser contexts');
  expect(requests).toEqual([]);
}, 30_000);
