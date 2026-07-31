import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

let server: ReturnType<typeof Bun.serve>;
let home: string;
let requestPaths: string[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      requestPaths.push(pathname);

      if (pathname === "/rest/api/user/current" || pathname === "/rest/api/2/myself") {
        if (req.headers.get("authorization") !== "Bearer fixture-token") {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }
      }

      if (pathname === "/rest/api/user/current") {
        return Response.json({ accountId: "doctor-user", displayName: "Doctor User" });
      }
      if (pathname === "/rest/api/2/myself") {
        return Response.json({ accountId: "doctor-user", displayName: "Doctor User" });
      }
      return Response.json({ message: `No fixture route for ${pathname}` }, { status: 404 });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-doctor-auth-"));
  await mkdir(join(home, ".atlcli", "logs"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "active",
      profiles: {
        active: {
          name: "active",
          baseUrl: server.url.origin,
          deploymentType: "data-center",
          auth: { type: "bearer" },
        },
      },
    }),
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

async function runDoctor(
  args: string[],
  token?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  requestPaths = [];
  const env = { ...process.env };
  env.HOME = home;
  env.USERPROFILE = home;
  env.ATLCLI_DISABLE_UPDATE_CHECK = "1";
  if (token) env.ATLCLI_API_TOKEN = token;
  else delete env.ATLCLI_API_TOKEN;

  const proc = Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, "doctor", ...args, "--json"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("doctor credential resolution", () => {
  it("accepts an environment-backed bearer token for the active profile", async () => {
    const result = await runDoctor([], "fixture-token");

    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
    const output = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; message: string; details?: Record<string, unknown> }>;
      summary: { failed: number };
    };
    const profileCheck = output.checks.find((check) => check.name === "active_profile");

    expect(profileCheck).toMatchObject({
      status: "pass",
      message: "Active profile: active",
      details: { profile: "active", authType: "bearer" },
    });
    expect(output.summary.failed).toBe(0);
    expect(requestPaths).toContain("/rest/api/user/current");
    expect(requestPaths).toContain("/rest/api/2/myself");
    expect(`${result.stdout}${result.stderr}`).not.toContain("fixture-token");
  });

  it("reports a missing resolved token instead of requiring email on bearer auth", async () => {
    const result = await runDoctor([]);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    expect(output.checks.find((check) => check.name === "active_profile")).toMatchObject({
      status: "fail",
      message: "Profile 'active' missing credentials",
    });
    expect(requestPaths).toEqual([]);
  });
});
