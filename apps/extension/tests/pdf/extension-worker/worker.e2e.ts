import { expect, test, chromium, type BrowserContext } from "@playwright/test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUTPUT_DIR = join(EXTENSION_ROOT, ".output", "chrome-mv3");

let context: BrowserContext;
let extensionId: string;
let testRoot: string;

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

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
  extensionId = new URL(serviceWorker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  rmSync(testRoot, { recursive: true, force: true });
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
