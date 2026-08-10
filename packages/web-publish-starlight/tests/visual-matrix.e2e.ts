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

test("Starlight Pagefind search supports mouse opening, keyboard focus/closing, result navigation, and empty states", async ({ page }) => {
  await page.goto("/starlight/");
  const trigger = page.getByRole("button", { name: "Search" });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const dialog = page.locator("site-search dialog");
  await expect(dialog).toBeVisible();
  const input = dialog.locator("input").first();
  await expect(input).toBeFocused();
  await input.fill("Publishing guide");
  const result = dialog.getByRole("link", { name: /Publishing guide/iu }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/guide\/$/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/starlight\/$/u);
  await trigger.click();
  await expect(dialog).toBeVisible();
  const searchStarted = performance.now();
  await input.fill("ExportBlock");
  await expect(dialog).toContainText(/result for ExportBlock/iu);
  expect(performance.now() - searchStarted).toBeLessThan(5_000);
  await input.fill("query-with-no-matching-publication");
  await expect(dialog).toContainText(/Searching|No results|unavailable/iu);
  await input.press("Tab");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
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

test("TanStack chart islands provide responsive legends, pointer and keyboard tooltips, reduced motion, and a JavaScript-off exact-value fallback", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/plain/charts/", { waitUntil: "networkidle" });
  const islands = page.locator('[data-atlcli-chart-island="hydrated"]');
  await expect(islands).toHaveCount(2);
  await expect(page.locator("[data-atlcli-chart-runtime]")).toHaveCount(2);
  const legends = page.locator("[data-atlcli-chart-runtime] .ts-chart__legend");
  await expect(legends).toHaveCount(2);
  await expect(legends.first()).toContainText("Primary");
  await expect(legends.first()).toContainText("Secondary");
  await expect(page.locator("table[data-atlcli-chart-data]")).toHaveCount(2);
  await expect(page.locator('figure[data-atlcli-chart-fallback="static-hidden"]')).toHaveCount(2);

  const firstRuntime = page.locator("[data-atlcli-chart-runtime]").first();
  const surface = firstRuntime.locator("svg");
  await expect(surface).toHaveAttribute("tabindex", "0");
  await expect(surface).toHaveAttribute("aria-label", "bar sample");
  await surface.focus();
  const tooltip = page.locator(".ts-chart-tooltip").first();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("role", "status");
  const initialTooltip = await tooltip.textContent();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => tooltip.textContent()).not.toBe(initialTooltip);
  await page.keyboard.press("Enter");
  await expect(tooltip).toHaveAttribute("data-sticky", "true");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();

  const firstBar = firstRuntime.locator(".ts-chart__bar rect").first();
  await firstBar.scrollIntoViewIfNeeded();
  const barBox = await firstBar.boundingBox();
  expect(barBox).not.toBeNull();
  await page.mouse.move((barBox?.x ?? 0) + (barBox?.width ?? 0) / 2, (barBox?.y ?? 0) + (barBox?.height ?? 0) / 2);
  await expect(tooltip).toBeVisible();
  const desktopWidth = Number(await islands.first().getAttribute("data-atlcli-chart-width"));
  expect(desktopWidth).toBeGreaterThan(700);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Number(await islands.first().getAttribute("data-atlcli-chart-width"))).toBeLessThan(desktopWidth);
  const mobileLayout = await page.evaluate(assertNoHorizontalOverflow());
  expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.width);
  expect(browserErrors).toEqual([]);
  await context.close();

  const reducedContext = await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
  const reducedPage = await reducedContext.newPage();
  await reducedPage.goto("/plain/charts/", { waitUntil: "networkidle" });
  await expect(reducedPage.locator('[data-atlcli-chart-island="hydrated"]')).toHaveCount(2);
  await expect(reducedPage.locator('[data-atlcli-chart-motion="reduced"]')).toHaveCount(2);
  await expect.poll(() => reducedPage.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0);
  await reducedContext.close();

  const staticContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await staticContext.newPage();
  await staticPage.goto("/plain/charts/", { waitUntil: "networkidle" });
  await expect(staticPage.locator('[data-atlcli-chart-island="enabled"]')).toHaveCount(2);
  await expect(staticPage.locator("[data-atlcli-chart-runtime]")).toHaveCount(0);
  await expect(staticPage.locator("figure[data-atlcli-block=chart] svg")).toHaveCount(2);
  await expect(staticPage.locator("table[data-atlcli-chart-data]")).toHaveCount(2);
  const staticLayout = await staticPage.evaluate(assertNoHorizontalOverflow());
  expect(staticLayout.scrollWidth).toBeLessThanOrEqual(staticLayout.width);
  await staticContext.close();
});

test("the clean Starlight gallery proves every static shape and both bounded islands with and without JavaScript", async ({ browser }) => {
  const expectedKinds = [
    "pie", "bar", "line", "area", "xyArea", "xyBar", "xyLine", "xyStep",
    "xyStepArea", "scatter", "timeSeries", "gantt",
  ].sort();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/starlight/charts/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Chart gallery" })).toBeVisible();
  const charts = page.locator('figure[data-atlcli-block="chart"]');
  await expect(charts).toHaveCount(14);
  await expect(charts.locator("svg")).toHaveCount(14);
  await expect(page.locator("table[data-atlcli-chart-data]")).toHaveCount(14);
  const kinds = await charts.evaluateAll((figures) => [...new Set(figures.map((figure) => figure.getAttribute("data-atlcli-chart-kind")))].sort());
  expect(kinds).toEqual(expectedKinds);
  await expect(page.locator('[data-atlcli-chart-island="hydrated"]')).toHaveCount(2);
  await expect(page.locator('[data-atlcli-chart-island="static"]')).toHaveCount(12);
  await expect(page.locator('[data-atlcli-chart-capability="tanstack-v0.3/bar"]')).toHaveCount(2);
  await expect(page.getByText("Interactive chart enhancement is unavailable", { exact: false })).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("onerror=alert");
  expect(await page.evaluate(assertNoHorizontalOverflow())).toMatchObject({ scrollWidth: 1440, width: 1440 });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(assertNoHorizontalOverflow());
  expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.width);
  await expect(page.locator('[data-atlcli-chart-island="hydrated"]')).toHaveCount(2);
  expect(browserErrors).toEqual([]);
  await context.close();

  const staticContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const externalRequests: string[] = [];
  await staticContext.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== `http://127.0.0.1:${process.env.ATLCLI_WEB_PUBLISH_VISUAL_PORT ?? "4387"}`) {
      externalRequests.push(url.href);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const staticPage = await staticContext.newPage();
  const response = await staticPage.goto("/starlight/charts/", { waitUntil: "networkidle" });
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await expect(staticPage.locator('figure[data-atlcli-block="chart"]')).toHaveCount(14);
  await expect(staticPage.locator('figure[data-atlcli-block="chart"] svg')).toHaveCount(14);
  await expect(staticPage.locator("table[data-atlcli-chart-data]")).toHaveCount(14);
  await expect(staticPage.locator("[data-atlcli-chart-runtime]")).toHaveCount(0);
  await expect(staticPage.locator('[data-atlcli-chart-island="hydrated"]')).toHaveCount(0);
  const staticKinds = await staticPage.locator('figure[data-atlcli-block="chart"]').evaluateAll((figures) =>
    [...new Set(figures.map((figure) => figure.getAttribute("data-atlcli-chart-kind")))].sort()
  );
  expect(staticKinds).toEqual(expectedKinds);
  const staticLayout = await staticPage.evaluate(assertNoHorizontalOverflow());
  expect(staticLayout.scrollWidth).toBeLessThanOrEqual(staticLayout.width);
  expect(externalRequests).toEqual([]);
  await staticContext.close();
});

test("an island runtime-budget overrun tears down TanStack and exposes the complete static chart", async ({ page }) => {
  await page.goto("/plain/charts-budget/", { waitUntil: "networkidle" });
  const island = page.locator('[data-atlcli-chart-island="static"]');
  await expect(island).toHaveCount(1);
  await expect(island).toHaveAttribute("data-atlcli-chart-fallback", "runtime-budget");
  await expect(island.locator("[data-atlcli-chart-runtime-status]")).toContainText("complete static chart and data table remain available");
  await expect(island.locator("[data-atlcli-chart-runtime]")).toHaveCount(0);
  await expect(island.locator("figure[data-atlcli-block=chart] svg")).toBeVisible();
  await expect(island.locator("table[data-atlcli-chart-data]")).toHaveCount(1);
  await expect(island.locator("table[data-atlcli-chart-data] tbody tr")).toHaveCount(66);
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

test("the published page stays within the browser quality budgets", async ({ page }) => {
  await page.goto("/starlight/", { waitUntil: "networkidle" });
  const metrics = await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    let lcp = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries.at(-1);
        if (last !== undefined) lcp = last.startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
      observer.takeRecords();
      observer.disconnect();
    } catch {
      // Browsers without LCP expose a zero sentinel; static byte budgets still run.
    }
    let cls = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value?: number; hadRecentInput?: boolean })[]) {
          if (!entry.hadRecentInput) cls += entry.value ?? 0;
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
      observer.takeRecords();
      observer.disconnect();
    } catch {
      // See LCP note above.
    }
    return {
      lcp,
      cls,
      ttfb: navigation?.responseStart ?? 0,
      totalBlockingJs: resources.filter((entry) => entry.name.endsWith(".js")).reduce((total, entry) => total + entry.duration, 0),
      external: resources.filter((entry) => /^https?:/u.test(entry.name) && new URL(entry.name).origin !== location.origin).map((entry) => entry.name),
    };
  });
  expect(metrics.external).toEqual([]);
  expect(metrics.ttfb).toBeLessThan(1000);
  expect(metrics.totalBlockingJs).toBeLessThan(1500);
  if (metrics.lcp > 0) expect(metrics.lcp).toBeLessThan(5000);
  expect(metrics.cls).toBeLessThan(0.25);
});

test("the published page stays within the semantic accessibility budget", async ({ page }) => {
  await page.goto("/starlight/", { waitUntil: "networkidle" });
  expect(await page.getByRole("main").count()).toBe(1);
  expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
  expect(await page.locator("[data-pagefind-body]").count()).toBe(1);
  const unlabeledImages = await page.locator("img").evaluateAll((images) => images.filter((image) => !image.hasAttribute("alt")).length);
  expect(unlabeledImages).toBe(0);
  const unnamedButtons = await page.locator("button").evaluateAll((buttons) => buttons.filter((button) => {
    const labelledBy = button.getAttribute("aria-labelledby");
    return !(button.getAttribute("aria-label") || labelledBy || button.getAttribute("title") || button.textContent?.trim());
  }).length);
  expect(unnamedButtons).toBe(0);
});

test("static content remains usable without JavaScript and stays inside the CSP/privacy boundary", async ({ browser }) => {
  const visualOrigin = `http://127.0.0.1:${process.env.ATLCLI_WEB_PUBLISH_VISUAL_PORT ?? "4387"}`;
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1280, height: 800 },
  });
  const externalRequests: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== visualOrigin) {
      externalRequests.push(url.href);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  const response = await page.goto("/plain/", { waitUntil: "networkidle" });
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response?.headers()["content-security-policy"]).toContain("'wasm-unsafe-eval'");
  await expect(page.locator('[data-atlcli-document]').first()).toBeVisible();
  await expect(page.locator('[data-atlcli-block="table"]')).toBeVisible();
  await expect(page.locator('[data-atlcli-block="image"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("*")].some((element) =>
    [...element.attributes].some((attribute) => attribute.name.toLowerCase().startsWith("on"))
  ))).toBe(false);
  const markup = await page.content();
  expect(markup).not.toMatch(/(?:atlassian\.net|confluence|cloudId|tenant)/iu);
  expect(externalRequests).toEqual([]);
  await context.close();
});
