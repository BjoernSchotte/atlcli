import { expect, test } from "@playwright/test";

function assertNoHorizontalOverflow() {
  return () => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth });
}

test("the Starlight experience remains usable across viewport, theme, preference, print, zoom, and deep-navigation variants", async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto("/starlight/guides/deep/");
    await expect(page.getByRole("heading", { level: 1, name: "A deliberately long deep-tree page title for a responsive navigation proof" })).toBeVisible();
    if (viewport.width < 800) {
      const menu = page.getByRole("button", { name: "Menu" });
      await menu.click();
      await expect(page.locator("body")).toHaveAttribute("data-mobile-menu-expanded", "");
    }
    await page.locator("nav.sidebar details").evaluateAll((items) => {
      for (const item of items) (item as HTMLDetailsElement).open = true;
    });
    const layout = await page.evaluate(assertNoHorizontalOverflow());
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    await expect(page.locator("nav.sidebar").getByText("Static publishing", { exact: true })).toBeVisible();
    await expect(page.locator("nav.sidebar").getByText("A deliberately long deep-tree page title for a responsive navigation proof", { exact: true })).toBeVisible();
    if (viewport.width < 800) {
      await page.keyboard.press("Escape");
      await expect(page.locator("body")).not.toHaveAttribute("data-mobile-menu-expanded", "");
    }
    await context.close();
  }

  for (const colorScheme of ["dark", "light"] as const) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto("/starlight/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await context.close();
  }

  const systemContext = await browser.newContext({ colorScheme: "light", viewport: { width: 1280, height: 800 } });
  const systemPage = await systemContext.newPage();
  await systemPage.goto("/starlight/");
  const picker = systemPage.locator("starlight-theme-select select").first();
  await picker.selectOption("auto");
  await expect(systemPage.locator("html")).toHaveAttribute("data-theme", "light");
  await systemContext.close();

  const forcedContext = await browser.newContext({ forcedColors: "active", reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const forcedPage = await forcedContext.newPage();
  await forcedPage.goto("/starlight/guide/");
  await expect(forcedPage.getByText("Prepare", { exact: true }).last()).toBeVisible();
  await expect.poll(() => forcedPage.evaluate(() => matchMedia("(forced-colors: active)").matches && matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await forcedPage.emulateMedia({ media: "print" });
  await expect(forcedPage.getByRole("navigation", { name: "Main" })).toBeHidden();
  await expect(forcedPage.getByText("A responsive Starlight presentation keeps normalized content separate from its theme.")).toBeVisible();
  await forcedPage.emulateMedia({ media: "screen" });
  await forcedPage.evaluate(() => { document.body.style.zoom = "2"; });
  const zoomed = await forcedPage.evaluate(assertNoHorizontalOverflow());
  expect(zoomed.scrollWidth).toBeLessThanOrEqual(zoomed.width);
  await forcedContext.close();
});

test("the plain experience preserves RTL logical layout, custom tokens, keyboard access, and static content without Starlight", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/plain/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const document = page.locator("[data-atlcli-document]").first();
  await expect(document).toHaveAttribute("dir", "rtl");
  await expect(page.locator('[data-atlcli-block="paragraph"]').first()).toHaveCSS("color", "rgb(23, 50, 77)");
  const layout = await page.evaluate(assertNoHorizontalOverflow());
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  const columns = page.locator('[data-atlcli-block="layout"] > div');
  const [first, second] = await Promise.all([columns.nth(0).boundingBox(), columns.nth(1).boundingBox()]);
  expect(first?.x).toBeGreaterThan(second?.x ?? Number.POSITIVE_INFINITY);
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("href", "https://example.test/guide");
  await expect(page.getByText("Fallback body", { exact: true })).toBeVisible();
  await context.close();
});

test("the Starlight Expressive Code surface keeps fixed presentation controls and hostile code inert", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto("/starlight/");
  const codeBlocks = page.locator('[data-atlcli-code-renderer="starlight-expressive-code"]');
  await expect(codeBlocks).toHaveCount(2);
  const normalizedCode = codeBlocks.nth(0);
  const hostileCode = codeBlocks.nth(1);
  await expect(normalizedCode.locator('[data-atlcli-code-language="TypeScript"]')).toBeVisible();
  await expect(normalizedCode.locator("pre.wrap")).toBeVisible();
  await expect(normalizedCode.locator(".ec-line.highlight.mark")).toBeVisible();
  const copy = normalizedCode.getByRole("button", { name: "Copy to clipboard" });
  await expect(copy).toHaveCount(1);
  await copy.click();
  await expect(normalizedCode.locator(".copy [aria-live]")).toHaveText("Copied!");
  await expect(hostileCode.locator('[data-atlcli-code-language="Text"]')).toBeVisible();
  await expect(hostileCode.locator("img")).toHaveCount(0);
  await expect(hostileCode.getByText("</script><img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await context.close();
});
