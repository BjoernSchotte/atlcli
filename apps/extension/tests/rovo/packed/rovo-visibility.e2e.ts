import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_SETTINGS_STORAGE_KEY } from "../../../utils/ports/settings.js";
import { ROVO_HIDDEN_ATTRIBUTE } from "../../../utils/rovo-visibility.js";
import { OUTPUT_DIR } from "../../build-helper.js";
import { createPackedBrowserEvidence } from "../../support/packed-browser-evidence.js";

const CONFLUENCE_URL =
  "https://fixture.atlassian.net/wiki/spaces/DOCSY/pages/42/Rovo-test";
const CONFLUENCE_FIXTURE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Confluence Rovo fixture</title></head>
  <body>
    <nav>
      <span data-testid="app-navigation-ai-mate">
        <div><button>Ask Rovo</button></div>
      </span>
      <button data-testid="unrelated-action">Page actions</button>
    </nav>
    <main>Confluence page</main>
    <button data-testid="platform-ai-button">Rovo</button>
  </body>
</html>`;

let context: BrowserContext;
let storagePage: Page;
let suiteRoot: string;
const browserEvidence = createPackedBrowserEvidence("rovo");

async function setHideRovo(value: boolean): Promise<void> {
  await storagePage.evaluate(
    async ({ key, hideRovoEntrypoints }) => {
      await chrome.storage.local.set({
        [key]: { locale: null, hideRovoEntrypoints },
      });
    },
    { key: APP_SETTINGS_STORAGE_KEY, hideRovoEntrypoints: value }
  );
}

async function openConfluenceFixture(): Promise<Page> {
  const page = await context.newPage();
  await page.route(CONFLUENCE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: CONFLUENCE_FIXTURE,
    })
  );
  await page.goto(CONFLUENCE_URL);
  return page;
}

test.beforeAll(async () => {
  suiteRoot = mkdtempSync(join(tmpdir(), "atlcli-rovo-extension-"));
  const extensionDir = join(suiteRoot, "extension");
  const userDataDir = join(suiteRoot, "profile");
  mkdirSync(extensionDir, { recursive: true });
  cpSync(OUTPUT_DIR, extensionDir, { recursive: true });
  writeFileSync(
    join(extensionDir, "storage-probe.html"),
    "<!doctype html><meta charset=utf-8><title>Storage probe</title>",
  );

  context = await chromium.launchPersistentContext(userDataDir, browserEvidence.launchOptions({
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  }));
  await browserEvidence.attachContext(context);
  const serviceWorker = context.serviceWorkers()[0] ??
    await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  storagePage = await context.newPage();
  await storagePage.goto(`chrome-extension://${extensionId}/storage-probe.html`);
});

test.beforeEach(async ({}, testInfo) => {
  await browserEvidence.startTest(testInfo);
});

test.beforeEach(async () => {
  await storagePage.evaluate(async () => {
    await chrome.storage.local.clear();
  });
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

test("leaves Confluence unchanged by default", async () => {
  const page = await openConfluenceFixture();

  await expect(page.locator("html")).not.toHaveAttribute(ROVO_HIDDEN_ATTRIBUTE, "");
  await expect(page.getByTestId("app-navigation-ai-mate")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Rovo" })).toBeVisible();
  await expect(page.getByTestId("platform-ai-button")).toBeVisible();
  await expect(page.getByTestId("unrelated-action")).toBeVisible();

  await page.close();
});

test("applies the persisted preference to current and late Rovo controls", async () => {
  await setHideRovo(true);
  const page = await openConfluenceFixture();

  await expect(page.locator("html")).toHaveAttribute(ROVO_HIDDEN_ATTRIBUTE, "");
  await expect(page.getByTestId("app-navigation-ai-mate")).toHaveCSS("display", "none");
  await expect(page.getByRole("button", { name: "Ask Rovo" })).toBeHidden();
  await expect(page.getByTestId("platform-ai-button")).toHaveCSS("display", "none");
  await expect(page.getByTestId("unrelated-action")).toBeVisible();

  await page.evaluate(() => {
    const lateTopControl = document.createElement("button");
    lateTopControl.dataset.testid =
      "atlassian-navigation.ui.conversation-assistant.app-navigation-ai-mate";
    lateTopControl.textContent = "Rovo fragen";
    document.body.append(lateTopControl);

    const lateFloatingControl = document.createElement("div");
    lateFloatingControl.id = "rovo-button-onboarding-spotlight";
    lateFloatingControl.textContent = "Rovo";
    document.body.append(lateFloatingControl);
  });
  await expect(
    page.getByTestId(
      "atlassian-navigation.ui.conversation-assistant.app-navigation-ai-mate"
    )
  ).toHaveCSS("display", "none");
  await expect(page.locator("#rovo-button-onboarding-spotlight")).toHaveCSS(
    "display",
    "none"
  );

  await setHideRovo(false);
  await expect(page.locator("html")).not.toHaveAttribute(ROVO_HIDDEN_ATTRIBUTE, "");
  await expect(page.getByTestId("app-navigation-ai-mate")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Rovo" })).toBeVisible();
  await expect(page.getByTestId("platform-ai-button")).toBeVisible();

  await setHideRovo(true);
  await expect(page.locator("html")).toHaveAttribute(ROVO_HIDDEN_ATTRIBUTE, "");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(ROVO_HIDDEN_ATTRIBUTE, "");
  await expect(page.getByTestId("app-navigation-ai-mate")).toHaveCSS("display", "none");

  await page.close();
});
