import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_ENTRYPOINTS, checkEntrypoint } from "./check-browser-build.ts";

/**
 * Note on scope: the *positive* proof — that the four §6 entrypoints build for
 * the browser with zero node:/bun: specifiers — is delivered by the executable
 * gate itself (`bun run check:browser`), which runs in CI. It is intentionally
 * not re-run here: `bun test` cannot resolve the hoisted workspace deps that
 * `markdown.ts` pulls in (`markdown-it`, `turndown`, …) inside `Bun.build`.
 *
 * This file provides the *negative* proof (spec 001 task 6 AC) with
 * self-contained fixtures that need no dependency resolution.
 */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlcli-browser-gate-"));
  tmpDirs.push(dir);
  return dir;
}

describe("browser-build gate (spec 001 task 6)", () => {
  test("the gate's entrypoint set includes every browser entrypoint", () => {
    expect(BROWSER_ENTRYPOINTS).toEqual([
      "packages/confluence/src/markdown.ts",
      "packages/confluence/src/client.ts",
      "packages/jira/src/client.ts",
      "packages/core/src/index.browser.ts",
      "packages/confluence/src/index.browser.ts",
      "packages/docx/src/index.browser.ts",
      "packages/diagram/src/index.ts",
      "packages/pdf/src/index.browser.ts",
    ]);
  });

  test("a browser-safe entrypoint passes (build ok, no specifiers)", async () => {
    const dir = fixtureDir();
    const file = join(dir, "clean.ts");
    writeFileSync(file, `export const answer = 40 + 2;\n`);

    const result = await checkEntrypoint(file);
    expect(result.buildFailed).toBe(false);
    expect(result.specifiers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Negative proof (spec 001 task 6 AC).
  //
  // Deviation from the AC's `import "node:fs"` wording: under Bun 1.3.x,
  // `node:fs` is silently *polyfilled* for the browser target (it builds clean),
  // so seeding it would NOT turn the gate red. The module that actually broke the
  // clients in the §1 baseline is `node:os` (via `config.ts` → the barrel), which
  // Bun cannot polyfill — the build fails and the specifier is named.
  test("a seeded node: import turns the gate red, naming the entrypoint and specifier", async () => {
    const dir = fixtureDir();
    const file = join(dir, "leaky-client.ts");
    // Mimics a client that has picked up a stray Node-only import.
    writeFileSync(
      file,
      `import os from "node:os";\nexport const platform = os.platform();\n`
    );

    const result = await checkEntrypoint(file);

    expect(result.ok).toBe(false);
    expect(result.buildFailed).toBe(true);
    expect(result.specifiers).toContain("node:os");
    expect(result.entrypoint).toBe(file); // named in the failure output
  });

  test("the specifier scan ignores Bun's inlined polyfill diagnostic strings (no false positive)", async () => {
    // A string literal that merely *contains* the text `node:buffer` must not be
    // mistaken for a real import — this is the exact shape of Bun's browser
    // polyfill stub messages that markdown.ts legitimately carries.
    const dir = fixtureDir();
    const file = join(dir, "stringy.ts");
    writeFileSync(file, `export const note = "not implemented for node:buffer browser build";\n`);

    const result = await checkEntrypoint(file);
    expect(result.ok).toBe(true);
    expect(result.specifiers).toEqual([]);
  });
});
