import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { CONFORMANCE_MANIFEST } from "../src/conformance-manifest.js";

const DIGEST_MANIFEST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../test-results/digests.json",
);

test("every registered conformance case passes from nested production output", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const foreignRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") consoleErrors.push(entry.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4179") foreignRequests.push(request.url());
  });

  const response = await page.goto("./");
  expect(response?.headers()["content-security-policy"]).toContain("wasm-unsafe-eval");
  await expect(page.getByTestId("buffer-state")).toHaveText("absent");

  // Digest manifest the Bun/CLI shape-parity runner (check-parity.ts) compares
  // its own output against. Only cases that emit digests contribute.
  const digestManifest: Record<string, unknown> = {};

  for (const meta of CONFORMANCE_MANIFEST) {
    await test.step(`case ${meta.id}`, async () => {
      await page.getByTestId(`run-${meta.id}`).click();
      // PDF compiles can be slow (real Typst WASM); give them room.
      await expect(page.getByTestId(`${meta.id}-state`)).toHaveText("passed", { timeout: 90_000 });
      const raw = await page.getByTestId(`${meta.id}-result`).textContent();
      const result = raw ? JSON.parse(raw) : null;

      if (meta.emitsDigests) {
        expect(result).not.toBeNull();
        expect(result.digests, `case ${meta.id} must expose digests`).toBeTruthy();
        expect(result.compilerVersion, `case ${meta.id} must expose compilerVersion`).toBeTruthy();
        digestManifest[meta.id] = result;
      }
    });
  }

  // Preserve the case-specific structural invariants the DOCX/PDF cases proved
  // historically (they still throw on their own invariants; these re-assert the
  // externally visible numbers).
  const docx = JSON.parse((await page.getByTestId("docx-result").textContent()) ?? "null");
  expect(docx.renderedDiagrams).toBe(1);
  expect(docx.byteLength).toBeGreaterThan(1_000);
  expect(docx.mediaParts.length).toBeGreaterThan(0);

  const pdf = JSON.parse((await page.getByTestId("pdf-result").textContent()) ?? "null");
  expect(pdf.byteIdenticalWarmRepeat).toBe(true);
  expect(pdf.tagged).toBe(true);
  expect(pdf.hasOutline).toBe(true);
  expect(pdf.embeddedFontFiles).toBeGreaterThan(0);
  expect(pdf.diagnosticCount).toBeGreaterThan(0);

  mkdirSync(dirname(DIGEST_MANIFEST), { recursive: true });
  writeFileSync(DIGEST_MANIFEST, JSON.stringify(digestManifest, null, 2));

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(foreignRequests).toEqual([]);
});
