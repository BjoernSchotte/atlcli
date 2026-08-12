import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "../../../../..");
const productionOutput = join(repositoryRoot, "apps", "extension", ".output", "chrome-mv3");
const evidenceDirectory = resolve(
  process.env.ATLCLI_NVDA_EVIDENCE_DIR ?? join(tmpdir(), "atlcli-nvda-evidence"),
);
const nvdaLogPath = process.env.ATLCLI_NVDA_LOG_PATH;
const sourceSha = process.env.ATLCLI_SOURCE_SHA ?? "unknown";
const nvdaVersion = process.env.ATLCLI_NVDA_VERSION ?? "unknown";
const nvdaInstallerSha256 = process.env.ATLCLI_NVDA_INSTALLER_SHA256 ?? "unknown";
const fixtureUrl = "https://fixture.atlassian.net/wiki/spaces/DOCSY/pages/42/Palette-screenreader-test";
const fixture = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Action palette screen-reader fixture</title>
    <style>
      body { margin: 0; min-height: 100vh; font: 16px system-ui; background: #f4f5f7; color: #172b4d; }
      main { padding: 32px; }
      button { min-height: 44px; padding: 8px 16px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Synthetic Confluence editor</h1>
      <button id="host-button">Return focus target</button>
      <div contenteditable="true">No tenant data is used by this fixture.</div>
    </main>
  </body>
</html>`;

mkdirSync(evidenceDirectory, { recursive: true });

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyExtension({ instrumented }) {
  const root = mkdtempSync(join(tmpdir(), instrumented ? "atlcli-nvda-instrumented-" : "atlcli-nvda-production-"));
  const extensionDirectory = join(root, "extension");
  const profileDirectory = join(root, "profile");
  cpSync(productionOutput, extensionDirectory, { recursive: true });
  writeFileSync(join(extensionDirectory, "storage-probe.html"), "<!doctype html><title>Storage probe</title>");

  if (instrumented) {
    const backgroundPath = join(extensionDirectory, "background.js");
    let background = readFileSync(backgroundPath, "utf8");
    const capabilityProjection = /([A-Za-z_$][\w$]*)\.executors\.map\(([A-Za-z_$][\w$]*)=>\2\.capability\)\)/gu;
    const capabilityMatches = [...background.matchAll(capabilityProjection)];
    if (capabilityMatches.length !== 1) {
      throw new Error(`Expected one capability projection, found ${capabilityMatches.length}.`);
    }
    background = background.replace(
      capabilityProjection,
      (_match, dependencies, executor) =>
        `${dependencies}.executors.map(${executor}=>${executor}.capability).filter(${executor}=>${executor}!=="atlcli.capability.export.pdf"))`,
    );

    const unavailableProvider = /if\(!await ([A-Za-z_$][\w$]*)\.hasProvider\(\)\)return\{status:`failed`,errorCode:`atlcli\.ai\.provider-unavailable`,messageKey:`atlcli\.action\.quick-ask\.provider-unavailable`,retryable:!1\};/gu;
    const providerMatches = [...background.matchAll(unavailableProvider)];
    if (providerMatches.length !== 1) {
      throw new Error(`Expected one unavailable-provider branch, found ${providerMatches.length}.`);
    }
    background = background.replace(
      unavailableProvider,
      (_match, dependencies) =>
        `if(!await ${dependencies}.hasProvider())return{status:\`completed\`,messageKey:\`atlcli.action.quick-ask.completed\`};`,
    );
    writeFileSync(backgroundPath, background);
  }

  return { root, extensionDirectory, profileDirectory };
}

async function waitForSpeech() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 900));
}

async function toggle(storagePage, page) {
  const accepted = await storagePage.evaluate(async ({ url }) => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
    if (tab?.id === undefined) return false;
    const response = await chrome.tabs.sendMessage(
      tab.id,
      { kind: "action-palette:toggle", requestId: `nvda:${crypto.randomUUID()}` },
      { frameId: 0 },
    );
    return response?.kind === "action-palette:toggle-result" && response.accepted === true;
  }, { url: page.url() });
  if (!accepted) throw new Error("The production content script rejected the palette toggle.");
}

async function openHarness({ instrumented }) {
  const copied = copyExtension({ instrumented });
  const context = await chromium.launchPersistentContext(copied.profileDirectory, {
    channel: "chromium",
    headless: false,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${copied.extensionDirectory}`,
      `--load-extension=${copied.extensionDirectory}`,
      "--disable-features=Translate",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  const storagePage = await context.newPage();
  await storagePage.goto(`chrome-extension://${extensionId}/storage-probe.html`);
  const page = await context.newPage();
  await page.route(fixtureUrl, (route) => route.fulfill({ status: 200, contentType: "text/html", body: fixture }));
  await page.goto(fixtureUrl);
  await page.bringToFront();
  return { ...copied, context, worker, storagePage, page };
}

async function screenshot(page, filename) {
  const path = join(evidenceDirectory, filename);
  await page.screenshot({ path });
  return path;
}

async function runProductionLane(screenshotPaths) {
  const harness = await openHarness({ instrumented: false });
  try {
    await harness.worker.evaluate(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://fixture.atlassian.net/wiki/rest/api/")) {
          const body = url.includes("/child/attachment")
            ? { results: [] }
            : {
                id: "42",
                title: "Palette Screenreader Fixture",
                body: { storage: { value: "<h1>Fixture</h1><p>No tenant data.</p>" } },
                version: { number: 1 },
                space: { key: "DOCSY" },
              };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      });
    });

    await harness.page.locator("#host-button").focus();
    await toggle(harness.storagePage, harness.page);
    const frame = harness.page.frameLocator("atlcli-action-palette-root iframe");
    const search = frame.getByTestId("palette-search");
    await search.waitFor({ state: "visible" });
    const dialog = frame.getByRole("dialog", { name: "atlcli actions" });
    await dialog.waitFor({ state: "visible" });
    const options = frame.getByRole("option");
    if (await options.count() !== 8) throw new Error("Expected eight production action options.");
    const groups = await frame.getByRole("group").allTextContents();
    console.log(`NVDA_PALETTE_GROUPS ${JSON.stringify(groups)}`);
    for (const expected of ["export", "ai", "navigation"]) {
      if (!groups.some((value) => value.toLocaleLowerCase("en-US").includes(expected))) {
        throw new Error(`Missing ${expected} group.`);
      }
    }
    await frame.getByTestId("palette-option-atlcli.export.pdf.current-page").getAttribute("aria-selected").then((value) => {
      if (value !== "true") throw new Error("PDF was not the active root option.");
    });
    await waitForSpeech();
    screenshotPaths.push(await screenshot(harness.page, "ap09-nvda-root.png"));

    await search.press("ArrowDown");
    await frame.getByTestId("palette-option-atlcli.export.docx.current-page").getAttribute("aria-selected").then((value) => {
      if (value !== "true") throw new Error("Arrow navigation did not activate DOCX.");
    });
    await waitForSpeech();
    screenshotPaths.push(await screenshot(harness.page, "ap09-nvda-arrow-navigation.png"));

    await search.fill("Ask AI about this page");
    await search.press("Enter");
    const question = frame.getByTestId("palette-input-question");
    await question.fill("Summarize this synthetic fixture.");
    await frame.getByTestId("palette-input-disclosure").check();
    await question.press("Control+Enter");
    await frame.getByTestId("palette-result-failed").waitFor({ state: "visible" });
    await waitForSpeech();
    screenshotPaths.push(await screenshot(harness.page, "ap09-nvda-failed.png"));

    await frame.getByTestId("palette-result-failed").press("Escape");
    await search.waitFor({ state: "visible" });
    await search.fill("Export current page as PDF");
    await search.press("Enter");
    await frame.getByTestId("palette-result-queued").waitFor({ state: "visible" });
    await waitForSpeech();
    screenshotPaths.push(await screenshot(harness.page, "ap09-nvda-queued.png"));

    await frame.getByTestId("palette-result-queued").press("Escape");
    await search.fill("Ask AI about this page");
    await search.press("Enter");
    await question.waitFor({ state: "visible" });
    await question.press("Escape");
    await search.waitFor({ state: "visible" });
    await search.press("Escape");
    if (await search.inputValue() !== "") throw new Error("The first root Escape did not clear the query.");
    await search.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (await harness.page.evaluate(() => document.activeElement?.id) !== "host-button") {
      throw new Error("Escape hierarchy did not return focus to the host button.");
    }
    await waitForSpeech();
    screenshotPaths.push(await screenshot(harness.page, "ap09-nvda-focus-return.png"));
  } finally {
    await harness.context.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
}

async function runInstrumentedLane(screenshotPaths) {
  const harness = await openHarness({ instrumented: true });
  try {
    await harness.page.locator("#host-button").focus();
    await toggle(harness.storagePage, harness.page);
    const frame = harness.page.frameLocator("atlcli-action-palette-root iframe");
    const search = frame.getByTestId("palette-search");
    await search.waitFor({ state: "visible" });

    await search.fill("Export current page as PDF");
    const unavailable = frame.getByTestId("palette-option-atlcli.export.pdf.current-page");
    if (await unavailable.getAttribute("aria-disabled") !== "true") {
      throw new Error("Instrumented missing capability was not exposed as disabled.");
    }
    const unavailableText = await unavailable.textContent();
    if (!unavailableText?.includes("This capability is not available in the current host.")) {
      throw new Error("The complete unavailable reason is missing.");
    }
    await search.press("Enter");
    await waitForSpeech();
    screenshotPaths.push(await screenshot(harness.page, "ap09-nvda-unavailable-reason.png"));

    await search.fill("Ask AI about this page");
    await search.press("Enter");
    const question = frame.getByTestId("palette-input-question");
    await question.fill("Summarize this synthetic fixture.");
    await frame.getByTestId("palette-input-disclosure").check();
    await question.press("Control+Enter");
    await frame.getByTestId("palette-result-completed").waitFor({ state: "visible" });
    await waitForSpeech();
    screenshotPaths.push(await screenshot(harness.page, "ap09-nvda-completed.png"));

    await frame.getByTestId("palette-result-completed").press("Escape");
    await search.press("Escape");
    if (await search.inputValue() !== "") throw new Error("The instrumented root Escape did not clear the query.");
    await search.press("Escape");
    if (await harness.page.evaluate(() => document.activeElement?.id) !== "host-button") {
      throw new Error("Instrumented lane did not return focus to the host button.");
    }
  } finally {
    await harness.context.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function assertNvdaSpeech() {
  if (!nvdaLogPath || !existsSync(nvdaLogPath)) throw new Error("The NVDA input/output log is missing.");
  const speech = readFileSync(nvdaLogPath, "utf8").toLocaleLowerCase("en-US");
  const assertions = [
    ["dialog label", "atlcli actions"],
    ["result count", "8 actions available"],
    ["export group", "export"],
    ["active PDF option", "export current page as pdf"],
    ["arrow-selected DOCX option", "export current page as docx"],
    ["unavailable reason", "this capability is not available in the current host"],
    ["queued status", "action queued"],
    ["failure status", "the action could not be completed"],
    ["completed status", "action completed"],
    ["returned host focus", "return focus target"],
  ];
  const missing = assertions.filter(([, fragment]) => !speech.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`NVDA did not log the expected speech assertions: ${missing.map(([label]) => label).join(", ")}.`);
  }
  return Object.fromEntries(assertions.map(([label, fragment]) => [label, fragment]));
}

const screenshotPaths = [];
try {
  await runProductionLane(screenshotPaths);
  await runInstrumentedLane(screenshotPaths);
  await waitForSpeech();
  const speechAssertions = assertNvdaSpeech();
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const browserVersion = browser.version();
  await browser.close();
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceSha,
    os: `${process.platform} ${process.arch}`,
    browser: { name: "Chromium", version: browserVersion, headed: true },
    screenReader: {
      name: "NVDA",
      version: nvdaVersion,
      installerSha256: nvdaInstallerSha256,
      logLevel: "input/output (12)",
    },
    fixture: { origin: "https://fixture.atlassian.net", tenantData: false },
    assertions: {
      dialogLabel: "atlcli actions",
      resultCount: { count: 8, spoken: "8 actions available" },
      groups: ["EXPORT", "AI", "NAVIGATION"],
      initialActiveOption: "Export current page as PDF",
      arrowActiveOption: "Export current page as DOCX",
      unavailableReason: "This capability is not available in the current host.",
      executionStatuses: ["queued", "failed", "completed"],
      escapeHierarchy: ["result to root", "input to root", "non-empty root query to cleared query", "empty root to closed"],
      returnedHostFocus: "host-button",
      speechAssertions,
    },
    instrumentation: {
      productionLane: ["dialog", "groups", "navigation", "failed", "queued", "escape", "focus return"],
      isolatedCopiedBuildLane: ["missing capability projection", "completed host result"],
      productionFilesModified: false,
    },
    screenshots: screenshotPaths.map((path) => ({ file: basename(path), sha256: sha256(path) })),
  };
  writeFileSync(join(evidenceDirectory, "ap09-nvda-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`NVDA_SCREENREADER_EVIDENCE ${JSON.stringify(receipt)}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
