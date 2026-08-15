/**
 * Probe: after the `mock.module` users have run, is the module registry intact?
 *
 * `auth.test.ts`, `helloworld.test.ts` and `session-guard.test.ts` all replace
 * `@atlcli/core` / `@atlcli/confluence` / `@atlcli/jira` via `mock.module`,
 * which mutates the registry for the WHOLE process. Without an `afterAll` that
 * puts the real barrels back, their stubs leak into every file that runs later:
 * `getLogger()` came back with only an `auth` method, so anything touching a
 * real API client died on `logger.api is not a function`, and the clients threw
 * on construction.
 *
 * This file holds only the assertions. `registry-isolation.test.ts` is what
 * makes them meaningful — it runs this file in a dedicated `bun test` process
 * *after* the three polluters, so the check no longer depends on the alphabetical
 * file order that caused the original bug. Running standalone (as it does in the
 * normal suite) it simply passes.
 */

import { describe, expect, it } from "bun:test";
import type { Profile } from "@atlcli/core";

describe("module registry integrity for later test files", () => {
  it("hands later files the real @atlcli/core logger, not a test stub", async () => {
    const { getLogger } = await import("@atlcli/core");
    const logger = getLogger();
    // `api` is the method the leaked stub omitted, which is what broke the
    // Confluence/Jira clients for every file that ran after the mock.
    expect(typeof logger.api).toBe("function");
    expect(typeof logger.auth).toBe("function");
  });

  it("hands later files constructible API clients", async () => {
    const { ConfluenceClient } = await import("@atlcli/confluence");
    const { JiraClient } = await import("@atlcli/jira");
    const profile: Profile = {
      name: "registry-probe",
      baseUrl: "https://probe.example.com",
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "probe-token" },
    };
    expect(() => new ConfluenceClient(profile)).not.toThrow();
    expect(() => new JiraClient(profile)).not.toThrow();
  });
});
