import { describe, expect, test } from "bun:test";
import {
  DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE,
} from "./docx-template-intake-fixture.js";

async function fixtureDigestInTimezone(timezone: string): Promise<string> {
  const moduleUrl = new URL(
    "./docx-template-intake-fixture.ts",
    import.meta.url
  ).href;
  const script = `
    const fixture = await import(${JSON.stringify(moduleUrl)});
    const bytes = fixture.createDocxTemplateIntakeFixture();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    console.log(Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""));
  `;
  const child = Bun.spawn(
    [process.execPath, "--conditions=development", "-e", script],
    {
      cwd: import.meta.dir,
      env: { ...process.env, TZ: timezone },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

describe("DOCX template intake fixture", () => {
  test("is byte-identical across host timezones", async () => {
    const digests = await Promise.all(
      ["UTC", "Europe/Berlin", "America/Los_Angeles"].map(
        fixtureDigestInTimezone
      )
    );
    expect(new Set(digests)).toEqual(
      new Set([DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.sourceDigest])
    );
  });
});
