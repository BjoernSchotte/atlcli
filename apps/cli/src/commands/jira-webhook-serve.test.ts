/**
 * `jira webhook serve` used to listen on every interface, took its secret only
 * from `--secret`, and ran without one silently. Each test drives the real CLI.
 */
import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const SECRET = "fixture-secret";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function serve(args: string[], env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "atlcli-jira-webhook-"));
  const proc = Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, "jira", "webhook", "serve", ...args],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_DISABLE_UPDATE_CHECK: "1", ATLCLI_WEBHOOK_SECRET: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc[stream] as AsyncIterable<Uint8Array>) output[stream] += decoder.decode(chunk);
      } catch {
        // Stream closes when the server is killed.
      }
    })();
  }
  cleanup = async () => {
    proc.kill("SIGKILL");
    await proc.exited;
    await rm(home, { recursive: true, force: true });
  };
  return { proc, output };
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await Bun.sleep(50);
  return predicate();
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

const EVENT = JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: 0, issue: { key: "AB-1", fields: { summary: "s" } } });
const post = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: "POST", body: EVENT, headers: { "Content-Type": "application/json", ...headers } });

test("refuses a non-loopback interface without a secret", async () => {
  const { proc, output } = await serve(["--port", "3998", "--host", "0.0.0.0"]);
  expect(await proc.exited).toBe(1);
  expect(await waitFor(() => output.stderr.includes("--host 0.0.0.0 needs a webhook secret"), 5_000)).toBe(true);
}, 60_000);

test("binds loopback and warns when no secret is set", async () => {
  const port = await freePort();
  const { output } = await serve(["--port", String(port)]);
  expect(await waitFor(() => output.stderr.includes("no webhook secret is set")), output.stderr).toBe(true);
  expect(output.stdout).toContain(`Webhook server started at http://127.0.0.1:${port}/webhook`);
  expect((await post(`http://127.0.0.1:${port}/webhook`)).status).toBe(200);
  expect(await waitFor(() => output.stdout.includes("CREATED: AB-1 - s"), 5_000)).toBe(true);
}, 60_000);

test("takes the secret from ATLCLI_WEBHOOK_SECRET, and --secret wins over it", async () => {
  const signature = `sha256=${createHmac("sha256", SECRET).update(EVENT).digest("hex")}`;
  for (const [args, env] of [
    [[], { ATLCLI_WEBHOOK_SECRET: SECRET }],
    [["--secret", SECRET], { ATLCLI_WEBHOOK_SECRET: "another-secret" }],
  ] as const) {
    const port = await freePort();
    const { output } = await serve(["--port", String(port), ...args], env);
    expect(await waitFor(() => output.stdout.includes("Webhook server started")), output.stderr).toBe(true);
    const url = `http://127.0.0.1:${port}/webhook`;
    expect((await post(url)).status).toBe(401);
    expect((await post(url, { "X-Hub-Signature": signature })).status).toBe(200);
    expect(output.stderr).not.toContain("no webhook secret");
    await cleanup?.();
    cleanup = null;
  }
}, 90_000);
