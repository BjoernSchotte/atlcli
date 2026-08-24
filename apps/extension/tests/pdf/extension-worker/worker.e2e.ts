import { expect, test, chromium, type BrowserContext } from "@playwright/test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_DIR } from "../../build-helper.js";
import { createPackedBrowserEvidence } from "../../support/packed-browser-evidence.js";

let context: BrowserContext;
let extensionId: string;
let serviceWorkerUrl: string;
let testRoot: string;
const browserEvidence = createPackedBrowserEvidence("worker");

function singleAsset(prefix: string, suffix: string): string {
  const matches = readdirSync(join(OUTPUT_DIR, "assets")).filter(
    (name) => name.startsWith(prefix) && name.endsWith(suffix)
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one ${prefix}*${suffix} asset, found ${matches.length}.`);
  }
  return `assets/${matches[0]!}`;
}

test.beforeAll(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "atlcli-pdfjs-extension-"));
  const extensionDir = join(testRoot, "extension");
  const userDataDir = join(testRoot, "profile");
  mkdirSync(extensionDir, { recursive: true });
  cpSync(OUTPUT_DIR, extensionDir, { recursive: true });

  const viewerAsset = singleAsset("pdf.min-", ".mjs");
  const workerAsset = singleAsset("pdfjs-worker-bootstrap-", ".js");
  writeFileSync(
    join(extensionDir, "pdf-worker-smoke.html"),
    `<!doctype html><meta charset="utf-8"><title>PDF.js worker smoke</title><output data-testid="state">loading</output><script type="module" src="pdf-worker-smoke.mjs"></script>\n`
  );
  writeFileSync(
    join(extensionDir, "pdf-worker-smoke.mjs"),
    `const state = document.querySelector('[data-testid="state"]');
const mode = new URL(location.href).searchParams.get("mode") ?? "worker";
try {
  const pdfjs = await import(${JSON.stringify(`./${viewerAsset}`)});
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(${JSON.stringify(workerAsset)});
  const NativeWorker = globalThis.Worker;
  if (mode === "fallback") {
    globalThis.Worker = class DisabledWorker {
      constructor() { throw new Error("forced worker-constructor failure"); }
    };
  }
  const worker = new pdfjs.PDFWorker();
  await Promise.race([
    worker.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("worker handshake timed out")), 10_000)),
  ]);
  const isRealWorker = worker.port instanceof NativeWorker;
  document.body.dataset.workerKind = isRealWorker ? "worker" : worker.port?.constructor?.name ?? "unknown";
  worker.destroy();
  globalThis.Worker = NativeWorker;
  if (mode === "worker" && !isRealWorker) throw new Error("PDF.js selected its fake worker");
  if (mode === "fallback" && isRealWorker) throw new Error("forced fallback still used a real worker");
  state.textContent = mode === "worker" ? "worker-ready" : "fallback-ready";
} catch (error) {
  state.textContent = error instanceof Error ? error.message : String(error);
  throw error;
}
`
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
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
  serviceWorkerUrl = serviceWorker.url();
  extensionId = new URL(serviceWorker.url()).host;
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
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("loads the release manifest, service worker, and side panel from the explicit artifact", async () => {
  const expected = JSON.parse(readFileSync(join(OUTPUT_DIR, "manifest.json"), "utf8")) as {
    version: string;
    version_name: string;
    side_panel: { default_path: string };
  };
  expect(serviceWorkerUrl).toBe(`chrome-extension://${extensionId}/background.js`);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${expected.side_panel.default_path}`);
  const loaded = await page.evaluate(() => chrome.runtime.getManifest());
  expect(loaded.version).toBe(expected.version);
  expect(loaded.version_name).toBe(expected.version_name);
  expect(loaded.side_panel?.default_path).toBe(expected.side_panel.default_path);
  await page.close();
});

test("starts PDF.js as a real module worker from chrome-extension://", async () => {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (entry) => {
    if (entry.type() === "warning" || entry.type() === "error") problems.push(entry.text());
  });
  await page.goto(`chrome-extension://${extensionId}/pdf-worker-smoke.html`);
  await expect(page.getByTestId("state")).toHaveText("worker-ready", { timeout: 30_000 });
  await expect(page.locator("body")).toHaveAttribute("data-worker-kind", "worker");
  expect(problems.filter((message) => message.includes("fake worker"))).toEqual([]);
  await page.close();
});

test("keeps PDF.js' official fake-worker fallback executable", async () => {
  const page = await context.newPage();
  const warnings: string[] = [];
  page.on("console", (entry) => {
    if (entry.type() === "warning") warnings.push(entry.text());
  });
  await page.goto(`chrome-extension://${extensionId}/pdf-worker-smoke.html?mode=fallback`);
  await expect(page.getByTestId("state")).toHaveText("fallback-ready", { timeout: 30_000 });
  await expect(page.locator("body")).toHaveAttribute("data-worker-kind", "LoopbackPort");
  expect(warnings.filter((message) => message.includes("Setting up fake worker"))).toHaveLength(1);
  await page.close();
});
