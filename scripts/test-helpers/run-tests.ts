#!/usr/bin/env bun
/**
 * `bun run test`: runs `bun test` so that it never sees the developer's
 * Atlassian credentials and never writes into their real `~/.atlcli` (#278).
 *
 * Bun binds the home directory at process start, so the isolation has to be
 * in the environment `bun test` starts with; a preload is too late.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Env-based auth and profile selection that would otherwise reach every client a test builds. */
export const CREDENTIAL_VARIABLES = [
  "ATLCLI_API_TOKEN", "ATLCLI_EMAIL", "ATLCLI_SITE", "ATLCLI_BASE_URL", "ATLCLI_AUTH_TYPE",
  "ATLCLI_PROFILE", "ATLCLI_CONFIG", "ATLCLI_LOG_LEVEL",
];

/**
 * The test environment: credentials removed, HOME a fresh directory. A live E2E
 * opt-in (`ATLCLI_*E2E*`, `ATLCLI_*_LIVE`) keeps the real HOME, because those
 * tests read the real profile on purpose. Tools that cache under HOME keep
 * their real caches.
 */
export function isolatedTestEnv(env: NodeJS.ProcessEnv, realHome: string, sandboxHome: () => string, platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of CREDENTIAL_VARIABLES) delete out[name];
  const liveOptIn = Object.entries(env).some(([name, value]) => /^ATLCLI_\w*(E2E|_LIVE)\w*$/.test(name) && !!value && value !== "0");
  if (liveOptIn) return out;
  const keep = (name: string, path: string) => {
    if (out[name] === undefined && existsSync(path)) out[name] = path;
  };
  keep("PLAYWRIGHT_BROWSERS_PATH", platform === "darwin" ? join(realHome, "Library", "Caches", "ms-playwright") : join(realHome, ".cache", "ms-playwright"));
  keep("RUSTUP_HOME", join(realHome, ".rustup"));
  keep("CARGO_HOME", join(realHome, ".cargo"));
  keep("BUN_INSTALL_CACHE_DIR", join(realHome, ".bun", "install", "cache"));
  keep("GIT_CONFIG_GLOBAL", join(realHome, ".gitconfig"));
  const home = sandboxHome();
  out.HOME = home;
  out.USERPROFILE = home;
  return out;
}

const BENCHMARKS = "**/*.benchmark.test.*";
/** Per-test default under `--parallel`: workers × spawned CLIs oversubscribe the CPU. */
export const PARALLEL_TIMEOUT_MS = 30_000;

/**
 * The `bun test` argument lists one `bun run test` runs. Serially that is one
 * run as given. With `--parallel` and no file filters, benchmarks (wall-clock
 * budgets, meaningless while every core is busy) are left out of the parallel
 * run and get a serial run of their own afterwards; the parallel run gets a
 * longer default timeout unless `--timeout` is given.
 */
export function testRuns(args: string[]): string[][] {
  const base = ["--conditions=development", "test", "--path-ignore-patterns=spikes/**"];
  const parallel = args.some((a) => a === "--parallel" || a.startsWith("--parallel="));
  if (!parallel) return [[...base, ...args]];
  const timeout = args.some((a) => a === "--timeout" || a.startsWith("--timeout=")) ? [] : [`--timeout=${PARALLEL_TIMEOUT_MS}`];
  const filtered = args.some((a) => !a.startsWith("-"));
  if (filtered) return [[...base, ...timeout, ...args]];
  const serialArgs = args.filter((a) => a !== "--parallel" && !a.startsWith("--parallel="));
  return [
    [...base, ...timeout, `--path-ignore-patterns=${BENCHMARKS}`, ...args],
    [...base, ...serialArgs, ".benchmark.test."],
  ];
}

if (import.meta.main) {
  let sandbox: string | undefined;
  const env = isolatedTestEnv(process.env, homedir(), () => (sandbox = mkdtempSync(join(tmpdir(), "atlcli-test-home-"))));
  let code = 0;
  for (const run of testRuns(process.argv.slice(2))) {
    const child = Bun.spawn([process.execPath, ...run], { env, stdio: ["inherit", "inherit", "inherit"] });
    code = (await child.exited) || code;
  }
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  process.exit(code);
}
