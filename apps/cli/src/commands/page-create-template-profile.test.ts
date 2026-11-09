/** `wiki page create --template` resolves profile-level templates from --profile, not the default profile. */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Spawns the CLI; loaded CI runners need more than Bun's 5 s per test.
setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "atlcli-template-profile-"));
  const profile = (name: string) => ({ name, baseUrl: "http://example.invalid", deploymentType: "data-center", auth: { type: "bearer" } });
  await mkdir(join(home, ".atlcli", "templates", "profiles", "other"), { recursive: true });
  await writeFile(join(home, ".atlcli", "config.json"), JSON.stringify({ currentProfile: "main", profiles: { main: profile("main"), other: profile("other") } }));
  await writeFile(join(home, ".atlcli", "templates", "profiles", "other", "note.md"), "Template of the other profile.\n");
});

afterAll(() => rm(home, { recursive: true, force: true }));

test("page create --template --profile finds the requested profile's template", async () => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_DISABLE_UPDATE_CHECK: "1" };
  delete env.ATLCLI_TEMPLATES_DIR;
  const proc = Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, "wiki", "page", "create", "--template", "note", "--title", "T", "--space", "S", "--profile", "other", "--dry-run", "--json"],
    { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode, stdout + stderr).toBe(0);
  expect(JSON.parse(stdout).rendered.markdown).toContain("Template of the other profile.");
});
