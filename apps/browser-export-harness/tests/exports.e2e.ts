import { expect, test } from "@playwright/test";

test("public DOCX and PDF browser contracts pass from nested production output", async ({ page }) => {
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

  await page.getByTestId("run-pdf-abort").click();
  await expect(page.getByTestId("pdf-abort-state")).toHaveText("passed");

  await page.getByTestId("run-docx").click();
  await expect(page.getByTestId("docx-state")).toHaveText("passed");
  const docx = JSON.parse(await page.getByTestId("docx-result").textContent() ?? "null");
  expect(docx.renderedDiagrams).toBe(1);
  expect(docx.byteLength).toBeGreaterThan(1_000);
  expect(docx.mediaParts.length).toBeGreaterThan(0);

  await page.getByTestId("run-pdf").click();
  await expect(page.getByTestId("pdf-state")).toHaveText("passed", { timeout: 90_000 });
  const pdf = JSON.parse(await page.getByTestId("pdf-result").textContent() ?? "null");
  expect(pdf.byteIdenticalWarmRepeat).toBe(true);
  expect(pdf.tagged).toBe(true);
  expect(pdf.hasOutline).toBe(true);
  expect(pdf.embeddedFontFiles).toBeGreaterThan(0);
  expect(pdf.diagnosticCount).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(foreignRequests).toEqual([]);
});
