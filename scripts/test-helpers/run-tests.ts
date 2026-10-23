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

/** Env-based auth that would otherwise reach every client a test builds. */
export const CREDENTIAL_VARIABLES = ["ATLCLI_API_TOKEN", "ATLCLI_EMAIL", "ATLCLI_SITE", "ATLCLI_BASE_URL", "ATLCLI_AUTH_TYPE"];

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

if (import.meta.main) {
  let sandbox: string | undefined;
  const env = isolatedTestEnv(process.env, homedir(), () => (sandbox = mkdtempSync(join(tmpdir(), "atlcli-test-home-"))));
  const child = Bun.spawn(
    [process.execPath, "--conditions=development", "test", "--path-ignore-patterns=spikes/**", ...process.argv.slice(2)],
    { env, stdio: ["inherit", "inherit", "inherit"] }
  );
  const code = await child.exited;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  process.exit(code);
}
