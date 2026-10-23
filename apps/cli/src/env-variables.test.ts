/**
 * Regression #282: ATLCLI_PROFILE, ATLCLI_CONFIG and ATLCLI_LOG_LEVEL were
 * documented but ignored. Real CLI, sandboxed HOME, no network.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
let home: string;

const profile = (name: string) => ({ name, baseUrl: `https://${name}.example.invalid`, auth: { type: "apiToken", email: "x@example.invalid", token: "t" } });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "atlcli-env-vars-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(join(home, ".atlcli", "config.json"), JSON.stringify({ currentProfile: "work", profiles: { work: profile("work"), home: profile("home") }, global: { space: "MAIN" } }));
  await writeFile(join(home, "other.json"), JSON.stringify({ currentProfile: "other", profiles: { other: profile("other") }, global: { space: "OTHER" } }));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_DISABLE_UPDATE_CHECK: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

test("ATLCLI_PROFILE picks the profile; --profile still wins", async () => {
  expect(JSON.parse((await run(["auth", "status", "--json"], { ATLCLI_PROFILE: "home" })).stdout).profile).toBe("home");
  expect(JSON.parse((await run(["auth", "status", "--profile", "work", "--json"], { ATLCLI_PROFILE: "home" })).stdout).profile).toBe("work");
}, 30_000);

test("ATLCLI_CONFIG reads another config file", async () => {
  const result = await run(["config", "get", "global.space", "--json"], { ATLCLI_CONFIG: join(home, "other.json") });
  expect(JSON.parse(result.stdout).value).toBe("OTHER");
}, 30_000);

test("ATLCLI_LOG_LEVEL=off writes no log", async () => {
  const logs = join(home, ".atlcli", "logs");
  await rm(logs, { recursive: true, force: true });
  await run(["config", "get", "global.space"], { ATLCLI_LOG_LEVEL: "off" });
  const files = await readdir(logs, { recursive: true }).catch(() => [] as string[]);
  expect(files.filter((f) => String(f).endsWith(".jsonl"))).toEqual([]);
}, 30_000);
