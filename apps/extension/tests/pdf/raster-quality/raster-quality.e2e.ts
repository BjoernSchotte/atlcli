import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RasterQualityReport } from "./protocol.js";

const OUTPUT_DIR = fileURLToPath(
  new URL("../../../.output/raster-quality-mv3", import.meta.url),
);

/**
 * Pinned after the neutral Chromium-140 baseline. Observed maxima were RGB
 * MAE 3.2833, RMSE 18.665, p95 13, alpha MAE 0.055, alpha max 1, and corner
 * MAE 1.3906. These guards leave bounded runtime noise without allowing a
 * visibly different resampler, lost transparency, a halo, crop, or blank.
 */
const QUALITY_LIMITS = Object.freeze({
  rgbMae: 4,
  rgbRmse: 22,
  rgbP95: 16,
  rgbMax: 240,
  alphaMae: 0.1,
  alphaP95: 1,
  alphaMax: 2,
  cornerRgbMae: 2,
  minimumLumaRatio: 0.94,
  maximumLumaRatio: 1.07,
});

const NAMED_BYTE_OUTLIERS = Object.freeze({
  "png-rgba-transparent-edge": 1.4,
  "png-grayscale-alpha": 1.2,
} satisfies Record<string, number>);

interface Harness {
  context: BrowserContext;
  page: Page;
  profileDir: string;
}

async function openHarness(): Promise<Harness> {
  const profileDir = mkdtempSync(join(tmpdir(), "atlcli-raster-quality-profile-"));
  const channel = process.env.ATLCLI_RASTER_QUALITY_BROWSER_CHANNEL === "chrome"
    ? "chrome"
    : "chromium";
  const context = await chromium.launchPersistentContext(profileDir, {
    channel,
    headless: process.env.ATLCLI_RASTER_QUALITY_HEADED !== "1",
    args: [
      `--disable-extensions-except=${OUTPUT_DIR}`,
      `--load-extension=${OUTPUT_DIR}`,
    ],
  });
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1_500, height: 1_000 });
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await expect(page.getByTestId("quality-state")).toHaveText("ready");
  return { context, page, profileDir };
}

async function closeHarness(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  await harness.context.close().catch(() => undefined);
  rmSync(harness.profileDir, { recursive: true, force: true });
}

test("pins ImageBitmap eligibility, pixels, bytes, and contact sheets", async ({}, testInfo) => {
  let harness: Harness | undefined;
  try {
    harness = await openHarness();
    const report = await harness.page.evaluate(() => window.atlcliRasterQuality.run());

    expect(report.schema).toBe("atlcli.raster-quality/1");
    expect(report.supportedFixtureCount).toBe(13);
    expect(report.keptFixtureCount).toBe(12);
    expect(report.unsupportedReceipt).toMatchObject({
      backend: "image-bitmap",
      workerStarted: false,
      normalized: 0,
      kept: 12,
      outcome: "released",
    });
    for (const fixture of report.unsupported) {
      expect(fixture.expectation, fixture.id).toBe("kept");
      expect(fixture.candidateKind, fixture.id).toBe("kept");
      expect(fixture.sourceBytes, fixture.id).toBeGreaterThan(0);
      expect(fixture.candidateBytes, fixture.id).toBe(0);
    }

    const [first, second] = report.runs;
    expect(first.pureAssetSha256).toBe(second.pureAssetSha256);
    expect(first.candidateAssetSha256).toBe(second.candidateAssetSha256);
    expect(first.candidateAssetBytes).toBeLessThanOrEqual(first.pureAssetBytes * 1.1);
    for (const run of report.runs) {
      expect(run.pureReceipt).toMatchObject({
        backend: "pure-ts",
        workerStarted: true,
        requests: 13,
        normalized: 13,
        outcome: "released",
      });
      expect(run.candidateReceipt).toMatchObject({
        backend: "image-bitmap",
        workerStarted: true,
        requests: 13,
        normalized: 13,
        outcome: "released",
      });
      for (const fixture of run.fixtures) {
        expect(fixture.expectation, fixture.id).toBe("normalized");
        expect(fixture.pureKind, fixture.id).toBe("normalized");
        expect(fixture.candidateKind, fixture.id).toBe("normalized");
        expect(fixture.outputWidth, fixture.id).toBeGreaterThan(0);
        expect(fixture.outputHeight, fixture.id).toBeGreaterThan(0);
        const metrics = fixture.metrics;
        expect(metrics, fixture.id).not.toBeNull();
        expect(metrics!.rgbMae, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.rgbMae);
        expect(metrics!.rgbRmse, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.rgbRmse);
        expect(metrics!.rgbP95, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.rgbP95);
        expect(metrics!.rgbMax, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.rgbMax);
        expect(metrics!.alphaMae, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.alphaMae);
        expect(metrics!.alphaP95, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.alphaP95);
        expect(metrics!.alphaMax, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.alphaMax);
        expect(metrics!.alphaCoverageDelta, fixture.id).toBe(0);
        expect(metrics!.transparentRgbMax, fixture.id).toBe(0);
        expect(metrics!.cornerRgbMae, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.cornerRgbMae);
        expect(metrics!.candidateLumaStddev, fixture.id).toBeGreaterThan(1);
        const lumaRatio = metrics!.candidateLumaStddev / metrics!.referenceLumaStddev;
        expect(lumaRatio, fixture.id).toBeGreaterThanOrEqual(QUALITY_LIMITS.minimumLumaRatio);
        expect(lumaRatio, fixture.id).toBeLessThanOrEqual(QUALITY_LIMITS.maximumLumaRatio);

        const byteRatio = fixture.candidateBytes / fixture.pureBytes;
        if (byteRatio > 1.1) {
          const namedLimit = NAMED_BYTE_OUTLIERS[
            fixture.id as keyof typeof NAMED_BYTE_OUTLIERS
          ];
          expect(namedLimit, `${fixture.id} must name its >1.10x byte outlier`).toBeDefined();
          expect(byteRatio, fixture.id).toBeLessThanOrEqual(namedLimit!);
        }
      }
    }

    const reportPath = testInfo.outputPath("raster-quality-report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await testInfo.attach("raster-quality-report", {
      path: reportPath,
      contentType: "application/json",
    });

    for (const scale of [1, 4] as const) {
      await harness.page.evaluate((value) => window.atlcliRasterQuality.renderContactSheet(value), scale);
      const path = testInfo.outputPath(`raster-quality-contact-sheet-${scale}x.png`);
      await harness.page.getByTestId("quality-sheet").screenshot({ path });
      await testInfo.attach(`raster-quality-contact-sheet-${scale}x`, {
        path,
        contentType: "image/png",
      });
    }

    console.log(`ATLCLI_RASTER_QUALITY_RESULT\n${JSON.stringify(report, null, 2)}`);
  } finally {
    await closeHarness(harness);
  }
});
