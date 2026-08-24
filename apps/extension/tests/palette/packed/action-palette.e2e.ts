import AxeBuilder from "@axe-core/playwright";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type FrameLocator,
  type Page,
  type Worker,
} from "@playwright/test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { OUTPUT_DIR } from "../../build-helper.js";
import { createPackedBrowserEvidence } from "../../support/packed-browser-evidence.js";

const ORIGIN = "https://fixture.atlassian.net";
const URLS = {
  confluenceView: `${ORIGIN}/wiki/spaces/DOCSY/pages/42/Palette-test`,
  confluenceEditor: `${ORIGIN}/wiki/spaces/DOCSY/pages/42/Palette-test?mode=edit`,
  jiraIssue: `${ORIGIN}/browse/ATLCLI-42`,
  jiraBoard: `${ORIGIN}/jira/software/projects/ATLCLI/boards/7`,
  generic: `${ORIGIN}/home`,
  outside: "https://example.com/palette-test",
} as const;

const FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Atlassian palette fixture</title>
    <style>
      html { font-family: serif !important; color: magenta !important; }
      body { margin: 0; background: repeating-linear-gradient(45deg,#fff,#fff 10px,#eef 10px,#eef 20px); }
      button, input, [contenteditable] { font: 72px fantasy !important; color: red !important; }
    </style>
  </head>
  <body>
    <nav><button id="host-button">Host action</button></nav>
    <main>
      <h1>Atlassian fixture</h1>
      <div id="editor" contenteditable="true">Editable selection survives</div>
    </main>
  </body>
</html>`;

let context: BrowserContext;
let storagePage: Page;
let suiteRoot: string;
let extensionId: string;
let missingCapabilityFixture = false;
let extensionWorker: Worker;
const browserEvidence = createPackedBrowserEvidence("palette");

function paletteFrame(page: Page): FrameLocator {
  return page.frameLocator("atlcli-action-palette-root iframe");
}

async function openFixture(url: string): Promise<Page> {
  const page = await context.newPage();
  await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE }));
  await page.goto(url);
  return page;
}

async function toggle(page: Page, probe: Page = storagePage): Promise<boolean> {
  return probe.evaluate(async ({ url }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab?.id === undefined) return false;
    try {
      const response = await chrome.tabs.sendMessage(
        tab.id,
        { kind: "action-palette:toggle", requestId: `e2e:${crypto.randomUUID()}` },
        { frameId: 0 },
      ) as { kind?: string; accepted?: boolean };
      return response?.kind === "action-palette:toggle-result" && response.accepted === true;
    } catch {
      return false;
    }
  }, { url: page.url() });
}

async function setZoom(page: Page, value: number): Promise<void> {
  await storagePage.evaluate(async ({ url, value }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab?.id !== undefined) await chrome.tabs.setZoom(tab.id, value);
  }, { url: page.url(), value });
}

async function expectOpen(page: Page, contextLabel: RegExp): Promise<FrameLocator> {
  const frame = paletteFrame(page);
  await expect(frame.getByTestId("palette-search")).toBeVisible();
  await expect(frame.getByText(contextLabel)).toBeVisible();
  await expect(frame.getByTestId("palette-search")).toBeFocused();
  await expect(frame.getByTestId("palette-search")).toHaveAttribute("aria-activedescendant", /.+/u);
  return frame;
}

async function closeWithEscape(page: Page, frame: FrameLocator): Promise<void> {
  const search = frame.getByTestId("palette-search");
  await expect(search).toBeFocused();
  // Close through the real extension transport. Playwright cannot reliably
  // acknowledge a key press from an iframe that the resulting close removes;
  // the package-level keyboard contract covers Escape itself, while this
  // packed test proves the host lifecycle and transport end to end.
  expect(await toggle(page)).toBe(true);
  const host = page.locator("atlcli-action-palette-root");
  await expect(host).toHaveAttribute("aria-hidden", "true");
  await expect(host).toHaveAttribute("hidden", "");
  await expect(host).toBeHidden();
}

async function closeWithBackdrop(page: Page, frame: FrameLocator): Promise<void> {
  const backdrop = frame.locator(".atlcli-action-palette-backdrop");
  // Leave enough time for Chromium to acknowledge evaluate before the click
  // deliberately tears down the extension iframe. A zero-delay timer can run
  // first on a loaded CI runner and strand the Playwright protocol call.
  await backdrop.evaluate((element) => {
    setTimeout(() => (element as HTMLElement).click(), 100);
  });
  const host = page.locator("atlcli-action-palette-root");
  await expect(host).toHaveAttribute("aria-hidden", "true");
  await expect(host).toHaveAttribute("hidden", "");
  await expect(host).toBeHidden();
}

async function assertFullViewportHost(page: Page): Promise<void> {
  const geometry = await page.locator("atlcli-action-palette-root").evaluate((host) => {
    const iframe = host.shadowRoot?.querySelector("iframe");
    const rectangle = iframe?.getBoundingClientRect();
    return {
      viewportWidth: globalThis.innerWidth,
      viewportHeight: globalThis.innerHeight,
      iframe: rectangle ? {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
      } : null,
    };
  });
  expect(geometry.iframe).not.toBeNull();
  expect(geometry.iframe?.x).toBe(0);
  expect(geometry.iframe?.y).toBe(0);
  expect(geometry.iframe?.width).toBe(geometry.viewportWidth);
  expect(geometry.iframe?.height).toBe(geometry.viewportHeight);
  expect(geometry.iframe?.height).toBeGreaterThan(150);
}

async function assertNoSeriousOrCriticalAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    results.violations.filter((violation) => violation.nodes.some((node) =>
      JSON.stringify(node.target).includes("atlcli-action-palette-root")
    )),
  ).toEqual([]);
  expect(
    results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
}

async function assertPointerTargets(frame: FrameLocator): Promise<void> {
  const targets = await frame.locator("button, input, textarea, select, [role='option']").evaluateAll((elements) =>
    elements.map((element) => {
      const rectangle = element.getBoundingClientRect();
      return {
        descriptor: `${element.tagName.toLowerCase()}.${element.className || "no-class"}:${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}`,
        visible: rectangle.width > 0 && rectangle.height > 0,
        width: rectangle.width,
        height: rectangle.height,
        primary: element.matches(".atlcli-action-palette-primary, .atlcli-action-palette-close, .atlcli-action-palette-back"),
      };
    })
  );
  for (const target of targets.filter((candidate) => candidate.visible)) {
    expect(target.width).toBeGreaterThanOrEqual(24);
    expect(target.height).toBeGreaterThanOrEqual(24);
    if (target.primary) {
      expect(target.width, target.descriptor).toBeGreaterThanOrEqual(44);
      expect(target.height, target.descriptor).toBeGreaterThanOrEqual(44);
    }
  }
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function gzipBytes(path: string): number {
  return gzipSync(readFileSync(path), { level: 9 }).byteLength;
}

function paletteBundleSizes(): { eagerGzipBytes: number; lazyGzipBytes: number } {
  const eagerGzipBytes = [
    "content-scripts/atlassian-action-palette.js",
    "content-scripts/atlassian-action-palette.css",
  ].reduce((total, path) => total + gzipBytes(join(OUTPUT_DIR, path)), 0);
  const html = readFileSync(join(OUTPUT_DIR, "action-palette.html"), "utf8");
  const referenced = [...html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/gu)]
    .map((match) => match[1]!)
    .filter((path, index, paths) => paths.indexOf(path) === index);
  const lazyGzipBytes = referenced.reduce(
    (total, path) => total + gzipBytes(join(OUTPUT_DIR, path)),
    0,
  );
  return { eagerGzipBytes, lazyGzipBytes };
}

test.beforeAll(async ({}, workerInfo) => {
  missingCapabilityFixture = workerInfo.project.name === "missing-capability";
  suiteRoot = mkdtempSync(join(tmpdir(), "atlcli-palette-extension-"));
  const extensionDir = join(suiteRoot, "extension");
  const userDataDir = join(suiteRoot, "profile");
  mkdirSync(extensionDir, { recursive: true });
  cpSync(OUTPUT_DIR, extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "storage-probe.html"), "<!doctype html><title>Storage probe</title>");
  if (missingCapabilityFixture) {
    const backgroundPath = join(extensionDir, "background.js");
    const background = readFileSync(backgroundPath, "utf8");
    const capabilityProjection = /([A-Za-z_$][\w$]*)\.executors\.map\(([A-Za-z_$][\w$]*)=>\2\.capability\)\)/gu;
    const matches = [...background.matchAll(capabilityProjection)];
    expect(matches).toHaveLength(1);
    writeFileSync(backgroundPath, background.replace(
      capabilityProjection,
      (_match, deps: string, executor: string) =>
        `${deps}.executors.map(${executor}=>${executor}.capability).filter(${executor}=>${executor}!=="atlcli.capability.export.pdf"))`,
    ));
  }
  context = await chromium.launchPersistentContext(userDataDir, browserEvidence.launchOptions({
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  }));
  await browserEvidence.attachContext(context);
  extensionWorker = context.serviceWorkers()[0] ??
    await context.waitForEvent("serviceworker", { timeout: 30_000 });
  extensionId = new URL(extensionWorker.url()).host;
  storagePage = await context.newPage();
  await storagePage.goto(`chrome-extension://${extensionId}/storage-probe.html`);
});

test.beforeEach(async ({}, testInfo) => {
  await browserEvidence.startTest(testInfo);
});

test.afterEach(async ({}, testInfo) => {
  await browserEvidence.finishTest(testInfo);
});

test.afterAll(async () => {
  try {
    if (context) await browserEvidence.closeContext(context);
  } finally {
    browserEvidence.finalize();
    rmSync(suiteRoot, { recursive: true, force: true });
  }
});

test("mounts only on Atlassian and derives every MVP context", async () => {
  const cases: Array<[string, RegExp]> = [
    [URLS.confluenceView, /Confluence · DOCSY/],
    [URLS.confluenceEditor, /Confluence · DOCSY/],
    [URLS.jiraIssue, /Jira · ATLCLI-42/],
    [URLS.jiraBoard, /Jira · ATLCLI/],
    [URLS.generic, /^Atlassian$/],
  ];
  for (const [index, [url, label]] of cases.entries()) {
    const page = await openFixture(url);
    expect(await toggle(page)).toBe(true);
    const frame = await expectOpen(page, label);
    if (index === 0) {
      await assertFullViewportHost(page);
      const assignment = await storagePage.evaluate(async () =>
        (await chrome.commands.getAll()).find((command) => command.name === "action-palette")?.shortcut ?? ""
      );
      const footer = frame.getByTestId("palette-footer-leading");
      await expect(footer).toContainText(assignment || "Shortcut not assigned");
    }
    await closeWithEscape(page, frame);
    await page.close();
  }

  const outside = await openFixture(URLS.outside);
  expect(await toggle(outside)).toBe(false);
  await expect(outside.locator("atlcli-action-palette-root")).toHaveCount(0);
  await outside.close();
});

test("survives SPA navigation, adversarial CSS, zoom, and fifty toggle cycles", async () => {
  const page = await openFixture(URLS.confluenceView);
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  expect(await toggle(page)).toBe(true);
  let frame = await expectOpen(page, /Confluence · DOCSY/);
  await closeWithBackdrop(page, frame);
  expect(await toggle(page)).toBe(true);
  frame = await expectOpen(page, /Confluence · DOCSY/);
  const searchBox = await frame.getByTestId("palette-search").boundingBox();
  expect(searchBox?.height).toBeGreaterThanOrEqual(24);
  expect(searchBox?.height).toBeLessThan(100);
  await assertPointerTargets(frame);
  await closeWithEscape(page, frame);
  await page.evaluate(() => {
    (window as typeof window & { __hostKeydowns?: number }).__hostKeydowns = 0;
    document.addEventListener("keydown", () => {
      const scope = window as typeof window & { __hostKeydowns?: number };
      scope.__hostKeydowns = (scope.__hostKeydowns ?? 0) + 1;
    }, { once: true });
    document.querySelector<HTMLElement>("#editor")?.focus();
  });
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() =>
    (window as typeof window & { __hostKeydowns?: number }).__hostKeydowns
  )).toBe(1);

  await page.evaluate((url) => history.pushState({}, "", url), URLS.jiraIssue);
  await page.waitForTimeout(1_100);
  expect(await toggle(page)).toBe(true);
  frame = await expectOpen(page, /Jira · ATLCLI-42/);
  await closeWithEscape(page, frame);

  await setZoom(page, 1.5);
  expect(await toggle(page)).toBe(true);
  frame = await expectOpen(page, /Jira · ATLCLI-42/);
  await expect(frame.getByTestId("action-palette")).toBeVisible();
  await closeWithEscape(page, frame);
  await setZoom(page, 1);

  for (let index = 0; index < 50; index += 1) {
    expect(await toggle(page)).toBe(true);
    await expect(frame.getByTestId("palette-search")).toBeVisible();
    expect(await toggle(page)).toBe(true);
    await expect(frame.getByTestId("palette-search")).toBeHidden();
  }
  expect(await page.locator("atlcli-action-palette-root").count()).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
});

test("queues the real current-page PDF path and hands missing DOCX setup to Publishing", async () => {
  await extensionWorker.evaluate(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://fixture.atlassian.net/wiki/rest/api/")) {
        const body = url.includes("/child/attachment")
          ? { results: [] }
          : {
              id: "42",
              title: "Palette Guide",
              body: { storage: { value: "<h1>Palette Guide</h1><p>Fixture body</p>" } },
              version: { number: 7 },
              space: { key: "DOCSY" },
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });
  const page = await openFixture(URLS.confluenceView);
  expect(await toggle(page)).toBe(true);
  let frame = await expectOpen(page, /Confluence · DOCSY/);
  await frame.getByTestId("palette-search").fill("Export current page as PDF");
  await frame.getByTestId("palette-search").press("Enter");
  const pdfResult = frame.locator("[data-testid^='palette-result-']");
  await expect(pdfResult).toBeVisible();
  await expect(pdfResult).toHaveAttribute("data-testid", "palette-result-queued");
  await expect(frame.getByTestId("palette-result-queued")).toContainText("PDF · queued");
  expect(await toggle(page)).toBe(true);
  await expect(frame.getByTestId("palette-search")).toBeHidden();

  expect(await toggle(page)).toBe(true);
  frame = await expectOpen(page, /Confluence · DOCSY/);
  await frame.getByTestId("palette-search").fill("Export current page as DOCX");
  await frame.getByTestId("palette-search").press("Enter");
  await expect(frame.getByTestId("palette-result-open-surface")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Open Publishing" })).toBeVisible();
  await frame.getByRole("button", { name: "Open Publishing" }).click();
  await expect(frame.getByTestId("palette-result-open-surface")).toBeVisible();
  await page.close();
});

test("preserves contenteditable focus and selection and exposes accessible nested states", async () => {
  const page = await openFixture(URLS.confluenceView);
  await test.step("select editor text", async () => page.locator("#editor").evaluate((element) => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (element as HTMLElement).focus();
  }));
  await test.step("open and scan root", async () => {
    expect(await toggle(page)).toBe(true);
    await expectOpen(page, /Confluence · DOCSY/);
    await assertNoSeriousOrCriticalAxe(page);
    await assertPointerTargets(paletteFrame(page));
  });
  const frame = paletteFrame(page);

  await test.step("scan empty results", async () => {
    await frame.getByTestId("palette-search").fill("no such action");
    await expect(frame.getByTestId("palette-empty")).toBeVisible();
    await assertNoSeriousOrCriticalAxe(page);
    await assertPointerTargets(frame);
    await frame.getByTestId("palette-search").press("Escape");
  });
  await test.step("scan action panel", async () => {
    await frame.getByTestId("palette-search").press("Control+Enter");
    await expect(frame.getByTestId("palette-action-panel")).toBeVisible();
    await assertNoSeriousOrCriticalAxe(page);
    await assertPointerTargets(frame);
    await frame.getByRole("button", { name: /Back/ }).click();
  });
  await test.step("scan input", async () => {
    await frame.getByTestId("palette-search").fill("Ask AI");
    await frame.getByTestId("palette-search").press("Enter");
    await expect(frame.getByTestId("palette-input-form")).toBeVisible();
    await expect(frame.getByText("Confluence · DOCSY", { exact: true })).toBeVisible();
    await expect(frame.getByTestId("palette-input-disclosure")).not.toBeChecked();
    await frame.getByTestId("palette-input-question").fill("Summarize the current context");
    await frame.getByTestId("palette-input-question").press("Control+Enter");
    await expect(frame.getByTestId("palette-input-form")).toBeVisible();
    await expect(frame.getByTestId("palette-executing")).toHaveCount(0);
    await frame.getByTestId("palette-input-disclosure").check();
    await frame.getByTestId("palette-input-question").press("Control+Enter");
    await expect(frame.getByTestId("palette-result-failed")).toBeVisible();
    await assertNoSeriousOrCriticalAxe(page);
    await assertPointerTargets(frame);
    await frame.getByRole("button", { name: /Back/ }).click();
  });
  await test.step("close and restore selection", async () => {
    await frame.getByTestId("palette-search").fill("");
    await closeWithEscape(page, frame);

    await expect.poll(() => page.evaluate(() => ({
      active: document.activeElement?.id,
      selection: getSelection()?.toString(),
    })), { timeout: 2_000 }).toEqual({ active: "editor", selection: "Editable" });
  });
  await page.close();
});

test("keeps loading and bounded transport-error states accessible", async () => {
  const page = await openFixture(URLS.confluenceView);
  expect(await toggle(page)).toBe(true);
  const frame = await expectOpen(page, /Confluence · DOCSY/);
  const extensionFrame = page.frames().find((candidate) =>
    candidate.url().startsWith(`chrome-extension://${extensionId}/action-palette.html`)
  );
  expect(extensionFrame).toBeDefined();
  await context.addInitScript(() => {
    if (
      location.pathname.endsWith("/action-palette.html") &&
      localStorage.getItem("__atlcliE2eInvalidLocale") === "1"
    ) {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => "x",
      });
    }
  });
  await extensionFrame!.evaluate(() => {
    localStorage.setItem("__atlcliE2eInvalidLocale", "1");
  });
  expect(await toggle(page)).toBe(true);

  const opening = toggle(page);
  await expect(frame.getByTestId("palette-host-loading")).toBeVisible();
  await assertNoSeriousOrCriticalAxe(page);
  await assertPointerTargets(frame);
  expect(await opening).toBe(true);
  await expect(frame.getByTestId("palette-host-error")).toBeVisible({ timeout: 4_000 });
  await assertNoSeriousOrCriticalAxe(page);
  await assertPointerTargets(frame);
  const failedFrame = page.frames().find((candidate) =>
    candidate.url().startsWith(`chrome-extension://${extensionId}/action-palette.html`)
  );
  expect(failedFrame).toBeDefined();
  await failedFrame!.evaluate(() => {
    localStorage.removeItem("__atlcliE2eInvalidLocale");
  });
  expect(await toggle(page)).toBe(true);
  await page.close();
});

test("meets cold, warm, network, long-task, and packed-size budgets", async () => {
  const releaseConsumer = process.env.ATLCLI_RELEASE_CONSUMER === "1";
  const assertTiming = process.env.ATLCLI_BROWSER_ASSERT_TIMING !== "0";
  const coldMs: number[] = [];
  for (let iteration = 0; iteration < 35; iteration += 1) {
    const page = await openFixture(`${URLS.confluenceView}?cold=${iteration}`);
    const startedAt = performance.now();
    expect(await toggle(page)).toBe(true);
    await expectOpen(page, /Confluence · DOCSY/);
    if (iteration >= 5) coldMs.push(performance.now() - startedAt);
    await page.close();
  }

  const page = await openFixture(`${URLS.confluenceView}?warm=1`);
  expect(await toggle(page)).toBe(true);
  const frame = await expectOpen(page, /Confluence · DOCSY/);
  expect(await toggle(page)).toBe(true);

  const warmMs: number[] = [];
  const longTasks: number[] = [];
  for (let iteration = 0; iteration < 35; iteration += 1) {
    const startedAt = performance.now();
    expect(await toggle(page)).toBe(true);
    await expect(frame.getByTestId("palette-search")).toBeFocused();
    const duration = performance.now() - startedAt;
    if (iteration >= 5) warmMs.push(duration);
    const warmFrame = page.frames().find((candidate) =>
      candidate.url().startsWith(`chrome-extension://${extensionId}/action-palette.html`)
    );
    expect(warmFrame).toBeDefined();
    longTasks.push(...await warmFrame!.evaluate(async () => {
      const samples: number[] = [];
      new PerformanceObserver((list) => {
        samples.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ type: "longtask", buffered: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return samples;
    }));
    expect(await toggle(page)).toBe(true);
    await expect(frame.getByTestId("palette-search")).toBeHidden();
  }

  expect(await toggle(page)).toBe(true);
  await expect(frame.getByTestId("palette-search")).toBeFocused();
  const searchFrame = page.frames().find((candidate) =>
    candidate.url().startsWith(`chrome-extension://${extensionId}/action-palette.html`)
  );
  expect(searchFrame).toBeDefined();
  await searchFrame!.evaluate(() => {
    const scope = window as typeof window & { __atlcliLongTasks?: number[] };
    scope.__atlcliLongTasks = [];
    new PerformanceObserver((list) => {
      scope.__atlcliLongTasks!.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask", buffered: true });
  });
  let searchRequests = 0;
  const countRequest = (): void => { searchRequests += 1; };
  page.on("request", countRequest);
  for (let iteration = 0; iteration < 30; iteration += 1) {
    await frame.getByTestId("palette-search").fill(`local query ${iteration}`);
  }
  page.off("request", countRequest);
  longTasks.push(...await searchFrame!.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return (window as typeof window & { __atlcliLongTasks?: number[] }).__atlcliLongTasks ?? [];
  }));
  const sizes = paletteBundleSizes();
  const evidence = {
    samples: { coldMs, warmMs },
    summary: {
      coldP95Ms: p95(coldMs),
      warmP95Ms: p95(warmMs),
      maxLongTaskMs: Math.max(0, ...longTasks),
      searchRequests,
      ...sizes,
    },
  };
  console.info(`PALETTE_PACKED_PERFORMANCE ${JSON.stringify(evidence)}`);
  expect(coldMs).toHaveLength(30);
  expect(warmMs).toHaveLength(30);
  // Local and homelab runs enforce latency by default. Shared GitHub runners
  // record the samples but opt out because host scheduling is not controlled.
  // Release consumers also avoid re-measuring the source-quality budget.
  if (assertTiming && !releaseConsumer) {
    expect(evidence.summary.coldP95Ms).toBeLessThanOrEqual(200);
    expect(evidence.summary.warmP95Ms).toBeLessThanOrEqual(100);
    expect(evidence.summary.maxLongTaskMs).toBeLessThan(50);
  }
  expect(searchRequests).toBe(0);
  expect(sizes.eagerGzipBytes).toBeLessThanOrEqual(30 * 1024);
  expect(sizes.lazyGzipBytes).toBeLessThanOrEqual(180 * 1024);
  await page.close();
});

test("renders a capability-missing action as unavailable", async () => {
  expect(missingCapabilityFixture).toBe(true);
  const page = await openFixture(URLS.confluenceView);
  expect(await toggle(page)).toBe(true);
  const frame = await expectOpen(page, /Confluence · DOCSY/);
  await frame.getByTestId("palette-search").fill("Export current page as PDF");
  const pdf = frame.getByTestId("palette-option-atlcli.export.pdf.current-page");
  await expect(pdf).toHaveAttribute("aria-disabled", "true");
  await expect(pdf).toContainText("This capability is not available in the current host.");
  expect(await pdf.evaluate((element) =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  )).toBe(true);
  await expect(frame.getByTestId("palette-search")).toBeVisible();
  await assertNoSeriousOrCriticalAxe(page);
  await page.close();
});
