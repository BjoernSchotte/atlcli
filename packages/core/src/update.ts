/**
 * Auto-update functionality for atlcli.
 *
 * Provides version checking, update downloading, and installation.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rename, rm, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir, tmpdir, platform, arch } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

// GitHub repository for releases
const GITHUB_REPO = "BjoernSchotte/atlcli";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

// Config directory (same as config.ts)
const CONFIG_DIR = join(homedir(), ".atlcli");
const UPDATE_STATE_PATH = join(CONFIG_DIR, "update-state.json");

// Check interval: 6 hours
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Installation method detection.
 */
export type InstallMethod = "script" | "homebrew" | "source" | "unknown";

/**
 * Update state persisted to disk.
 */
export interface UpdateState {
  lastCheck: string | null;
  latestVersion: string | null;
  currentVersion: string;
  installMethod: InstallMethod;
}

/**
 * Update information returned from check.
 */
export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl: string | null;
  checksum: string | null;
  installMethod: InstallMethod;
}

/**
 * GitHub release asset structure.
 */
interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

/**
 * GitHub release structure.
 */
interface GitHubRelease {
  tag_name: string;
  name: string;
  prerelease: boolean;
  assets: GitHubAsset[];
}

// Version injected at build time via --define
declare const __ATLCLI_VERSION__: string;

/**
 * Get the current atlcli version.
 * Injected at build time from package.json.
 */
export function getCurrentVersion(): string {
  // __ATLCLI_VERSION__ is defined at build time via bun build --define
  // Falls back to "dev" when running directly from source without building
  return typeof __ATLCLI_VERSION__ !== "undefined" ? __ATLCLI_VERSION__ : "dev";
}

/**
 * Detect how atlcli was installed.
 */
export function detectInstallMethod(): InstallMethod {
  const binPath = process.execPath;

  // Homebrew: /opt/homebrew/bin/atlcli or /usr/local/bin/atlcli (symlink to Cellar)
  if (binPath.includes("/homebrew/") || binPath.includes("/Cellar/")) {
    return "homebrew";
  }

  // Script install: ~/.atlcli/bin/atlcli
  if (binPath.includes("/.atlcli/bin/")) {
    return "script";
  }

  // Development: running via bun in source directory
  if (binPath.includes("bun") || binPath.includes("/dist/")) {
    return "source";
  }

  return "unknown";
}

/**
 * Detect the current platform for release asset matching.
 * Returns format like "linux-x64", "darwin-arm64".
 */
export function detectPlatform(): string {
  const os = platform();
  const cpu = arch();

  let osName: string;
  switch (os) {
    case "darwin":
      osName = "darwin";
      break;
    case "linux":
      osName = "linux";
      break;
    default:
      throw new Error(`Unsupported operating system: ${os}`);
  }

  let archName: string;
  switch (cpu) {
    case "x64":
      archName = "x64";
      break;
    case "arm64":
      archName = "arm64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${cpu}`);
  }

  return `${osName}-${archName}`;
}

/**
 * Load update state from disk.
 */
export async function loadUpdateState(): Promise<UpdateState> {
  const defaultState: UpdateState = {
    lastCheck: null,
    latestVersion: null,
    currentVersion: getCurrentVersion(),
    installMethod: detectInstallMethod(),
  };

  if (!existsSync(UPDATE_STATE_PATH)) {
    return defaultState;
  }

  try {
    const raw = await readFile(UPDATE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateState>;
    return {
      ...defaultState,
      ...parsed,
    };
  } catch {
    return defaultState;
  }
}

/**
 * Save update state to disk.
 */
export async function saveUpdateState(state: Partial<UpdateState>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });

  const current = await loadUpdateState();
  const updated = { ...current, ...state };

  await writeFile(UPDATE_STATE_PATH, JSON.stringify(updated, null, 2), "utf8");
}

/**
 * Check if we should check for updates (based on last check time).
 */
export function shouldCheckForUpdates(state: UpdateState): boolean {
  if (!state.lastCheck) {
    return true;
  }

  const lastCheck = new Date(state.lastCheck).getTime();
  const now = Date.now();

  return now - lastCheck >= CHECK_INTERVAL_MS;
}

/**
 * Fetch the latest release from GitHub.
 */
async function fetchLatestRelease(): Promise<GitHubRelease> {
  const response = await fetch(`${RELEASES_API}/latest`, {
    headers: {
      "User-Agent": "atlcli",
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest release: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch a specific release by tag from GitHub.
 */
async function fetchRelease(tag: string): Promise<GitHubRelease> {
  // Ensure tag starts with 'v'
  const normalizedTag = tag.startsWith("v") ? tag : `v${tag}`;

  const response = await fetch(`${RELEASES_API}/tags/${normalizedTag}`, {
    headers: {
      "User-Agent": "atlcli",
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch release ${normalizedTag}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Parse version string to extract numeric version (strips 'v' prefix).
 */
function parseVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

/**
 * Compare two semantic versions.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a).split(".").map(Number);
  const partsB = parseVersion(b).split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] || 0;
    const partB = partsB[i] || 0;

    if (partA < partB) return -1;
    if (partA > partB) return 1;
  }

  return 0;
}

/**
 * Check for available updates.
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const currentVersion = getCurrentVersion();
  const installMethod = detectInstallMethod();
  const platform = detectPlatform();

  // For non-script installs, we can still check but won't provide download info
  if (installMethod !== "script") {
    try {
      const release = await fetchLatestRelease();
      const latestVersion = parseVersion(release.tag_name);
      const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;

      return {
        currentVersion,
        latestVersion,
        updateAvailable,
        downloadUrl: null,
        checksum: null,
        installMethod,
      };
    } catch {
      // If we can't check, return no update available
      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        downloadUrl: null,
        checksum: null,
        installMethod,
      };
    }
  }

  // For script installs, get full download info
  const release = await fetchLatestRelease();
  const latestVersion = parseVersion(release.tag_name);
  const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;

  // Find the appropriate asset for this platform
  const assetName = `atlcli-${platform}.tar.gz`;
  const asset = release.assets.find((a) => a.name === assetName);

  // Find checksums file
  const checksumsAsset = release.assets.find((a) => a.name === "checksums.txt");
  let checksum: string | null = null;

  if (checksumsAsset) {
    try {
      const response = await fetch(checksumsAsset.browser_download_url, {
        headers: { "User-Agent": "atlcli" },
      });
      if (response.ok) {
        const text = await response.text();
        // Parse checksums.txt format: "hash  filename"
        const lines = text.split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && parts[1] === assetName) {
            checksum = parts[0];
            break;
          }
        }
      }
    } catch {
      // Ignore checksum fetch errors
    }
  }

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    downloadUrl: asset?.browser_download_url || null,
    checksum,
    installMethod,
  };
}

/**
 * Download a file to a local path.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "atlcli" },
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const fileStream = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

/**
 * Verify SHA256 checksum of a file.
 */
async function verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
  const content = await readFile(filePath);
  const hash = createHash("sha256").update(content).digest("hex");
  return hash === expectedChecksum;
}

/**
 * Extract a tar.gz file to a directory.
 * Uses the system tar command for simplicity.
 */
async function extractTar(tarPath: string, destDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xzf", tarPath, "-C", destDir], {
      stdio: "pipe",
    });

    tar.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extraction failed with code ${code}`));
      }
    });

    tar.on("error", reject);
  });
}

/**
 * Install an update.
 *
 * @param version - Optional specific version to install. If not provided, installs latest.
 */
export async function installUpdate(version?: string): Promise<string> {
  const installMethod = detectInstallMethod();

  if (installMethod !== "script") {
    throw new Error(
      `Cannot auto-update: installed via ${installMethod}. ` +
        (installMethod === "homebrew"
          ? "Run: brew upgrade atlcli"
          : installMethod === "source"
            ? "Run: git pull && bun run build"
            : "Please reinstall using the install script.")
    );
  }

  const platform = detectPlatform();
  const release = version ? await fetchRelease(version) : await fetchLatestRelease();
  const targetVersion = parseVersion(release.tag_name);

  // Find the appropriate asset
  const assetName = `atlcli-${platform}.tar.gz`;
  const asset = release.assets.find((a) => a.name === assetName);

  if (!asset) {
    throw new Error(`No release asset found for platform: ${platform}`);
  }

  // Find and parse checksums
  const checksumsAsset = release.assets.find((a) => a.name === "checksums.txt");
  let expectedChecksum: string | null = null;

  if (checksumsAsset) {
    const response = await fetch(checksumsAsset.browser_download_url, {
      headers: { "User-Agent": "atlcli" },
    });
    if (response.ok) {
      const text = await response.text();
      const lines = text.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === assetName) {
          expectedChecksum = parts[0];
          break;
        }
      }
    }
  }

  // Create temp directory for download
  const { mkdtemp } = await import("node:fs/promises");
  const tempDir = await mkdtemp(join(tmpdir(), "atlcli-update-"));
  const tarPath = join(tempDir, assetName);

  try {
    // Download the release
    await downloadFile(asset.browser_download_url, tarPath);

    // Verify checksum if available
    if (expectedChecksum) {
      const valid = await verifyChecksum(tarPath, expectedChecksum);
      if (!valid) {
        throw new Error("Checksum verification failed. Download may be corrupted.");
      }
    }

    // Prepare installation paths
    const binDir = join(homedir(), ".atlcli", "bin");
    const targetPath = join(binDir, "atlcli");
    const backupPath = join(binDir, "atlcli.bak");

    // Ensure bin directory exists
    await mkdir(binDir, { recursive: true });

    // Backup current binary
    if (existsSync(targetPath)) {
      try {
        await rename(targetPath, backupPath);
      } catch {
        // If rename fails, try copy + delete
        const { copyFile, unlink } = await import("node:fs/promises");
        await copyFile(targetPath, backupPath);
        await unlink(targetPath);
      }
    }

    // Extract new binary
    await extractTar(tarPath, binDir);

    // Make executable
    await chmod(targetPath, 0o755);

    // Update state
    await saveUpdateState({
      currentVersion: targetVersion,
      latestVersion: targetVersion,
      lastCheck: new Date().toISOString(),
    });

    return targetVersion;
  } finally {
    // Cleanup temp directory
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
