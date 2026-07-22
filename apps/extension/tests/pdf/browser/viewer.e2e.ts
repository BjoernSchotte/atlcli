import { expect, test } from "@playwright/test";

test("real PDF.js AnnotationLayer activates internal and external compiled-PDF links", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleProblems: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "warning" || entry.type() === "error") {
      consoleProblems.push(entry.text());
    }
  });
  await page.goto("./");
  await expect(page.getByTestId("viewer-state")).toHaveText("ready", { timeout: 90_000 });
  const pageCount = Number(await page.locator("body").getAttribute("data-page-count"));
  expect(pageCount).toBeGreaterThanOrEqual(2);

  const layer = page.getByTestId("viewer-annotations");
  const internal = layer.locator("section.linkAnnotation[data-internal-link] > a");
  const external = layer.locator('section.linkAnnotation:not([data-internal-link]) > a[href^="https://"]');
  await expect(internal).toHaveCount(1);
  await expect(external).toHaveCount(1);
  await expect(external).toHaveAttribute("href", "https://example.com/docs");
  await expect(external).toHaveAttribute("target", "_blank");
  await expect(external).toHaveAttribute("rel", "noopener noreferrer");
  await expect(external).toHaveAttribute("aria-label", "https://example.com/docs");

  await internal.click();
  await expect
    .poll(async () => Number(await page.getByTestId("viewer-navigation").textContent()))
    .toBeGreaterThan(1);
  expect(Number(await page.getByTestId("viewer-navigation").textContent())).toBeLessThanOrEqual(
    pageCount
  );
  expect(pageErrors).toEqual([]);
  expect(consoleProblems).toEqual([]);
});
