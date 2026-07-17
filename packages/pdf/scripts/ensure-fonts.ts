import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDF_RUNTIME_ASSETS } from "../src/runtime-assets.js";

export interface PdfFontAsset {
  fileName: string;
  url: string;
  sha256: string;
}

export interface EnsurePdfFontsOptions {
  cacheDir?: string;
  assets?: readonly PdfFontAsset[];
  fetchImpl?: typeof fetch;
  logger?: (message: string) => void;
}

export interface EnsurePdfFontsResult {
  cacheDir: string;
  downloaded: string[];
  reused: string[];
}

export const PDF_FONT_ASSETS: readonly PdfFontAsset[] = PDF_RUNTIME_ASSETS.fonts.map((font) => ({
  fileName: font.fileName,
  url: font.sourceUrl,
  sha256: font.sha256,
}));

export const PDF_FONT_CACHE_DIR = fileURLToPath(new URL("../.fonts/", import.meta.url));

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function cachedChecksum(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function downloadVerified(
  asset: PdfFontAsset,
  targetPath: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(asset.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download ${asset.fileName} (${response.status} ${response.statusText}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    throw new Error(
      `Checksum mismatch for ${asset.fileName}: expected ${asset.sha256}, received ${actual}.`,
    );
  }

  const temporaryPath = join(
    dirname(targetPath),
    `.${asset.fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, bytes, { mode: 0o644 });
  try {
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function ensurePdfFonts(
  options: EnsurePdfFontsOptions = {},
): Promise<EnsurePdfFontsResult> {
  const cacheDir = options.cacheDir ?? PDF_FONT_CACHE_DIR;
  const assets = options.assets ?? PDF_FONT_ASSETS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console.log;
  await mkdir(cacheDir, { recursive: true });

  const downloaded: string[] = [];
  const reused: string[] = [];
  await Promise.all(
    assets.map(async (asset) => {
      const targetPath = join(cacheDir, asset.fileName);
      if ((await cachedChecksum(targetPath)) === asset.sha256) {
        reused.push(asset.fileName);
        return;
      }
      await downloadVerified(asset, targetPath, fetchImpl);
      downloaded.push(asset.fileName);
    }),
  );

  downloaded.sort();
  reused.sort();
  logger(
    downloaded.length > 0
      ? `PDF fonts ready: downloaded and verified ${downloaded.length} file(s).`
      : `PDF fonts ready: verified ${reused.length} cached file(s).`,
  );
  return { cacheDir, downloaded, reused };
}

if (import.meta.main) {
  await ensurePdfFonts();
}
