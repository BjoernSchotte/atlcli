import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { CREDENTIAL_VARIABLES, isolatedTestEnv } from "./run-tests.js";

const real = { ATLCLI_API_TOKEN: "real-token", ATLCLI_EMAIL: "me@example.invalid", PATH: "/bin", HOME: "/home/me" };

test("drops credentials and sandboxes HOME (#278)", () => {
  const env = isolatedTestEnv(real, "/home/me", () => "/tmp/sandbox");
  for (const name of CREDENTIAL_VARIABLES) expect(env[name]).toBeUndefined();
  expect(env.HOME).toBe("/tmp/sandbox");
  expect(env.USERPROFILE).toBe("/tmp/sandbox");
  expect(env.PATH).toBe("/bin");
});

test("a live E2E opt-in keeps the real HOME but still drops the token", () => {
  for (const optIn of ["ATLCLI_JIRA_CONTENT_E2E", "ATLCLI_E2E_PROFILE", "ATLCLI_NFS_LIVE"]) {
    const env = isolatedTestEnv({ ...real, [optIn]: "1" }, "/home/me", () => "/tmp/sandbox");
    expect(env.HOME).toBe("/home/me");
    expect(env.ATLCLI_API_TOKEN).toBeUndefined();
  }
  expect(isolatedTestEnv({ ...real, ATLCLI_NFS_LIVE: "0" }, "/home/me", () => "/tmp/sandbox").HOME).toBe("/tmp/sandbox");
});

test("bun run test itself runs in the sandbox", () => {
  // This file runs under `bun run test`; only a live E2E opt-in keeps the real HOME.
  const optedIn = isolatedTestEnv(process.env, "/real", () => "/sandbox").HOME === process.env.HOME;
  if (!optedIn) expect(homedir()).toMatch(/atlcli-test-home-/);
  expect(process.env.ATLCLI_API_TOKEN).toBeUndefined();
});
