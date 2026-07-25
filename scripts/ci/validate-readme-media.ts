import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const README_MEDIA_POLICY = {
  allowedExtensions: new Set([".png", ".pdf"]),
  maxFileBytes: 10 * 1024 * 1024,
  maxAggregateBytes: 25 * 1024 * 1024,
  maxPngWidth: 4_096,
  maxPngHeight: 4_096,
  maxPdfPages: 20,
} as const;

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/iu;

export interface ReadmeMediaIssue {
  file: string;
  message: string;
}

export interface ValidateReadmeMediaOptions {
  repoRoot: string;
  readme?: string;
  trackedFiles: ReadonlySet<string>;
}

function localMediaLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/(!?)\[[^\]]*\]\(\s*(?:<([^>]+)>|([^) \t]+))(?:\s+["'][^"']*["'])?\s*\)/gu)) {
    const link = match[2] ?? match[3]!;
    if (match[1] === "!" || extname(link.split(/[?#]/u, 1)[0]!).toLowerCase() === ".pdf") {
      links.push(link);
    }
  }
  for (const match of markdown.matchAll(/<(img|a)\b[^>]+(?:src|href)=["']([^"']+)["'][^>]*>/giu)) {
    const link = match[2]!;
    if (match[1]!.toLowerCase() === "img" || extname(link.split(/[?#]/u, 1)[0]!).toLowerCase() === ".pdf") {
      links.push(link);
    }
  }
  return links.filter((link) => !EXTERNAL.test(link));
}

function displayBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  if (new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function detectablePdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return text.match(/\/Type\s*\/Page\b/gu)?.length ?? 0;
}

export async function validateReadmeMedia(
  options: ValidateReadmeMediaOptions
): Promise<ReadmeMediaIssue[]> {
  const readme = resolve(options.repoRoot, options.readme ?? "README.md");
  const markdown = await readFile(readme, "utf8");
  const issues: ReadmeMediaIssue[] = [];
  let aggregateBytes = 0;

  for (const href of [...new Set(localMediaLinks(markdown))]) {
    let cleanHref: string;
    try {
      cleanHref = decodeURIComponent(href.split(/[?#]/u, 1)[0]!);
    } catch {
      issues.push({ file: href, message: "README media link contains invalid percent-encoding" });
      continue;
    }
    const absolute = resolve(dirname(readme), cleanHref);
    const repoPath = relative(options.repoRoot, absolute).replaceAll("\\", "/");
    const extension = extname(repoPath).toLowerCase();

    if (isAbsolute(cleanHref) || repoPath.startsWith("../") || repoPath === "..") {
      issues.push({ file: href, message: "local README media must stay inside the repository" });
      continue;
    }
    if (!README_MEDIA_POLICY.allowedExtensions.has(extension)) {
      issues.push({
        file: repoPath,
        message: `unsupported media extension ${extension || "(none)"}; allowed: .png, .pdf`,
      });
      continue;
    }
    if (!options.trackedFiles.has(repoPath)) {
      issues.push({ file: repoPath, message: "referenced README media is not committed" });
      continue;
    }

    let bytes: Uint8Array;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error("not a regular file");
      bytes = new Uint8Array(await readFile(absolute));
    } catch {
      issues.push({ file: repoPath, message: "referenced README media does not exist" });
      continue;
    }

    aggregateBytes += bytes.byteLength;
    if (bytes.byteLength > README_MEDIA_POLICY.maxFileBytes) {
      issues.push({
        file: repoPath,
        message:
          `size ${displayBytes(bytes.byteLength)} exceeds the per-file limit ` +
          `${displayBytes(README_MEDIA_POLICY.maxFileBytes)}`,
      });
    }

    if (extension === ".png") {
      const dimensions = pngDimensions(bytes);
      if (!dimensions) {
        issues.push({ file: repoPath, message: "invalid PNG signature or IHDR header" });
      } else if (
        dimensions.width === 0 ||
        dimensions.height === 0 ||
        dimensions.width > README_MEDIA_POLICY.maxPngWidth ||
        dimensions.height > README_MEDIA_POLICY.maxPngHeight
      ) {
        issues.push({
          file: repoPath,
          message:
            `PNG dimensions ${dimensions.width}x${dimensions.height} exceed the non-zero ` +
            `${README_MEDIA_POLICY.maxPngWidth}x${README_MEDIA_POLICY.maxPngHeight} limit`,
        });
      }
    } else {
      const header = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
      if (header !== "%PDF-") {
        issues.push({ file: repoPath, message: "invalid PDF header; expected %PDF-" });
      }
      const pages = detectablePdfPages(bytes);
      if (pages > README_MEDIA_POLICY.maxPdfPages) {
        issues.push({
          file: repoPath,
          message: `detectable PDF page count ${pages} exceeds the ${README_MEDIA_POLICY.maxPdfPages}-page limit`,
        });
      }
    }
  }

  if (aggregateBytes > README_MEDIA_POLICY.maxAggregateBytes) {
    issues.push({
      file: "README.md",
      message:
        `referenced media totals ${displayBytes(aggregateBytes)}, exceeding the aggregate limit ` +
        `${displayBytes(README_MEDIA_POLICY.maxAggregateBytes)}`,
    });
  }
  return issues;
}

async function trackedFiles(repoRoot: string): Promise<ReadonlySet<string>> {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
  }
  return new Set(result.stdout.toString().split("\0").filter(Boolean));
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const issues = await validateReadmeMedia({ repoRoot, trackedFiles: await trackedFiles(repoRoot) });
  if (issues.length > 0) {
    for (const issue of issues) console.error(`README media: ${issue.file}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log("README media: all local PNG and PDF references are valid");
}

if (import.meta.main) await main();
