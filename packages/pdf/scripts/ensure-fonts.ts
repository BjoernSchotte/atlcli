import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const SOURCE_SANS_COMMIT = "ed1808970eb3c7301c9a523bee26473ba0bb62fa";
const SOURCE_SERIF_COMMIT = "2823e993c53fca27c5c8749f529b56a5a7c77b6b";
const SOURCE_CODE_PRO_COMMIT = "d3f1a5962cde503f9409c21e58527611d4a19ef1";

function adobeRaw(repo: string, commit: string, fileName: string): string {
  return `https://raw.githubusercontent.com/adobe-fonts/${repo}/${commit}/TTF/${fileName}`;
}

export const PDF_FONT_ASSETS: readonly PdfFontAsset[] = [
  {
    fileName: "SourceSans3-Regular.ttf",
    url: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-Regular.ttf"),
    sha256: "4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f",
  },
  {
    fileName: "SourceSans3-It.ttf",
    url: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-It.ttf"),
    sha256: "192afd78f0f54a3c69eaf02d43f4d9a821e9d6110e41d3d25d61a7385cd580e4",
  },
  {
    fileName: "SourceSans3-Semibold.ttf",
    url: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-Semibold.ttf"),
    sha256: "a3f4f8dcf343a8f24dc61951de93f3ba1558b15cd250ba24af8a40e957081b7d",
  },
  {
    fileName: "SourceSans3-Bold.ttf",
    url: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-Bold.ttf"),
    sha256: "9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a",
  },
  {
    fileName: "SourceSerif4-Regular.ttf",
    url: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-Regular.ttf"),
    sha256: "e5a4ee6a3d87bb9024796be390c6771e2a0eb1883dae25effaf57ca01668e24b",
  },
  {
    fileName: "SourceSerif4-It.ttf",
    url: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-It.ttf"),
    sha256: "9d2950a8f1da66e21502c35d646a1d2148e79f9ea43fd2158cf02f5232e7f430",
  },
  {
    fileName: "SourceSerif4-Semibold.ttf",
    url: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-Semibold.ttf"),
    sha256: "36db62940cb5728b12b1802476dc7fcf4c6c519a7bdd476ba23a4e555fc4655f",
  },
  {
    fileName: "SourceSerif4-Bold.ttf",
    url: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-Bold.ttf"),
    sha256: "7cf4f4e1ad74f45058d5bc61716b82560442fbdcd9d3654d2dea96bf6c683d86",
  },
  {
    fileName: "SourceCodePro-Regular.ttf",
    url: adobeRaw("source-code-pro", SOURCE_CODE_PRO_COMMIT, "SourceCodePro-Regular.ttf"),
    sha256: "74bd80d3e42a08517cd7e1108ba3d86f2da29ac0f3065be95e0357956ab9db37",
  },
  {
    fileName: "SourceCodePro-Bold.ttf",
    url: adobeRaw("source-code-pro", SOURCE_CODE_PRO_COMMIT, "SourceCodePro-Bold.ttf"),
    sha256: "b2095e0d657e6d28dc32444a9dacabab0c9241d0bf39d96371756cc9bdbc3a5f",
  },
];

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
