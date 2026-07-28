#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { PDF_RUNTIME_ASSETS } from "@atlcli/pdf/browser";

const NODE_SPECIFIER_RE = /["'`](?:node|bun):[A-Za-z0-9_./-]*["'`]/g;
const NODE_RUNTIME_RE = /(?<![\w.])Buffer\.[A-Za-z_$]|\bprocess\.(?:env|versions)\b|\brequire\s*\(\s*["'`]|\b__dirname\b|\b__filename\b/g;
const DYNAMIC_CODE_RES = [
  /\bnew\s+Function\s*\(/g,
  /(?:^|[=(:,!&|?;{}])\s*Function\s*\(\s*["'`]/g,
  /(?:^|[^\w.])eval\s*\(/g,
];
const REMOTE_EXECUTABLE_RES = [
  /\bimport\s*(?:[^"'`()]*\bfrom\s*)?["'`]https?:\/\/[^"'`]+["'`]/g,
  /\bimport\s*\(\s*["'`]https?:\/\/[^"'`]+["'`]/g,
  /\bimportScripts\s*\(\s*["'`]https?:\/\/[^"'`]+["'`]/g,
  /<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[^"'\s>]+/gi,
  /\b(?:fetch|Worker|SharedWorker|URL)\s*\(\s*["'`]https?:\/\/[^"'`]+\.(?:js|mjs|wasm|ttf|otf|woff2?|txt)(?:[?#][^"'`]*)?["'`]/g,
];
const EXTENSION_RUNTIME_RE = /\bchrome\.|chrome-extension:\/\/|\bwxt(?:\/|["'`])|["'`](?:pdf:compile|pdf:cancel)["'`]/g;
const ROOT_RELATIVE_RES = [
  /\b(?:src|href)\s*=\s*["']\/(?!\/)[^"']+["']/gi,
  /url\(\s*["']?\/(?!\/)[^)"']+/gi,
  /\b(?:fetch|Worker|SharedWorker|URL|importScripts)\s*\(\s*["'`]\/(?!\/)[^"'`]+["'`]/g,
  /["'`]\/assets\/[^"'`]+\.(?:js|mjs|wasm|ttf|otf|woff2?|txt)["'`]/g,
];
const ONIGURUMA_RUNTIME_RES = [
  /\bfindNextOnigScannerMatch\b/g,
  /Must invoke loadWasm first[.]/g,
];
const AGGREGATE_SHIKI_RUNTIME_RES = [
  /\bbundle_full_exports\b/g,
  /\blangs-bundle-full\b/g,
  /["'`]shiki(?:\/(?:langs|themes))?["'`]/g,
];
const DOCX_CODE_FONT_SHA256 =
  "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f";

export interface OutputFinding {
  file: string;
  findings: string[];
}

export interface OutputArtifact {
  path: string;
  size: number;
  sha256?: string;
}

function matches(text: string, expressions: RegExp[]): string[] {
  const findings = new Set<string>();
  for (const expression of expressions) {
    for (const match of text.matchAll(expression)) findings.add(match[0].trim());
  }
  return [...findings];
}

export function scanHarnessText(text: string): string[] {
  const findings = [
    ...matches(text, [NODE_SPECIFIER_RE, NODE_RUNTIME_RE]),
    ...matches(text, DYNAMIC_CODE_RES),
    ...matches(text, REMOTE_EXECUTABLE_RES),
    ...matches(text, [EXTENSION_RUNTIME_RE]),
    ...matches(text, ROOT_RELATIVE_RES),
    ...matches(text, ONIGURUMA_RUNTIME_RES),
    ...matches(text, AGGREGATE_SHIKI_RUNTIME_RES),
  ];
  // Shiki grammar chunks are inert JSON payloads. Some grammars list Node
  // globals as source-language keywords; those strings are not runtime use.
  if (
    text.includes("Object.freeze(JSON.parse(`") &&
    text.includes('"scopeName"')
  ) {
    return findings.filter(
      (finding) => finding !== "__dirname" && finding !== "__filename",
    );
  }
  return findings;
}

function walk(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

export function collectArtifacts(root: string): OutputArtifact[] {
  return walk(root).map((path) => {
    const extension = extname(path).toLowerCase();
    const bytes = readFileSync(path);
    return {
      path: relative(root, path),
      size: bytes.byteLength,
      sha256: extension === ".wasm" || extension === ".ttf"
        ? createHash("sha256").update(bytes).digest("hex")
        : undefined,
    };
  });
}

export function scanHarnessOutput(root: string): OutputFinding[] {
  const findings: OutputFinding[] = [];
  for (const path of walk(root)) {
    if (!/[.](?:html|js|mjs|css)$/i.test(path)) continue;
    const hits = scanHarnessText(readFileSync(path, "utf8"));
    if (hits.length > 0) findings.push({ file: relative(root, path), findings: hits });
  }
  return findings;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashedAssetPattern(fileName: string): RegExp {
  const extension = extname(fileName);
  const stem = basename(fileName, extension);
  return new RegExp(`(?:^|/)assets/${escaped(stem)}-[^/]+${escaped(extension)}$`);
}

function requireOne(
  artifacts: OutputArtifact[],
  label: string,
  pattern: RegExp,
  expectedSha256?: string,
): string[] {
  const matches = artifacts.filter((artifact) => pattern.test(artifact.path));
  if (matches.length !== 1) return [`${label}: expected exactly one artifact, found ${matches.length}`];
  if (expectedSha256 && matches[0]!.sha256 !== expectedSha256) {
    return [`${label}: SHA-256 does not match the canonical manifest`];
  }
  return [];
}

export function validateHarnessInventory(artifacts: OutputArtifact[]): string[] {
  const issues: string[] = [];
  for (const artifact of artifacts) {
    if (/(?:^|\/)engine-oniguruma-[^/]+[.]js$/i.test(artifact.path)) {
      issues.push(`Oniguruma engine: unexpected browser artifact ${artifact.path}`);
    }
    if (/(?:^|\/)(?:onig|shiki)[^/]*[.]wasm$/i.test(artifact.path)) {
      issues.push(`Oniguruma WASM: unexpected browser artifact ${artifact.path}`);
    }
    if (
      /(?:^|\/)(?:langs|themes|bundle-full|bundle-web)-[^/]+[.]js$/i.test(
        artifact.path,
      )
    ) {
      issues.push(`aggregate Shiki catalogue: unexpected browser artifact ${artifact.path}`);
    }
  }
  if (!artifacts.some((artifact) => artifact.path === "index.html")) {
    issues.push("entry HTML: missing index.html");
  }
  if (!artifacts.some((artifact) => artifact.path === "topology.html")) {
    issues.push("topology HTML: missing topology.html");
  }
  issues.push(...requireOne(
    artifacts,
    "PDF compiler Worker",
    /(?:^|\/)assets\/pdf-worker-[^/]+\.js$/,
  ));
  issues.push(...requireOne(
    artifacts,
    "Typst compiler WASM",
    /(?:^|\/)assets\/typst_ts_web_compiler_bg-[^/]+\.wasm$/,
  ));
  issues.push(...requireOne(
    artifacts,
    "DOCX code font",
    /(?:^|\/)assets\/JetBrainsMono-Regular-[^/]+\.ttf$/,
    DOCX_CODE_FONT_SHA256,
  ));
  for (const font of PDF_RUNTIME_ASSETS.fonts) {
    issues.push(...requireOne(artifacts, font.fileName, hashedAssetPattern(font.fileName), font.sha256));
  }
  for (const license of PDF_RUNTIME_ASSETS.licenses) {
    issues.push(...requireOne(artifacts, license.fileName, hashedAssetPattern(license.fileName)));
  }
  const compilerLicense = PDF_RUNTIME_ASSETS.compilerLicense.fileName;
  issues.push(...requireOne(
    artifacts,
    "compiler license",
    new RegExp(`(?:^|/)assets/${escaped(compilerLicense)}-[A-Za-z0-9_-]+\\.?$`),
  ));
  return issues;
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? join(import.meta.dir, "..", "dist");
  try {
    const contentFindings = scanHarnessOutput(root);
    const inventoryFindings = validateHarnessInventory(collectArtifacts(root));
    if (contentFindings.length === 0 && inventoryFindings.length === 0) {
      console.log(`✓ browser export harness output is local, relative, and complete in ${root}`);
      return;
    }
    console.error("✗ browser export harness output scan FAILED:");
    for (const finding of contentFindings) {
      console.error(`  ${finding.file}: ${finding.findings.join(", ")}`);
    }
    for (const finding of inventoryFindings) console.error(`  ${finding}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(`✗ cannot scan harness output '${root}': ${error instanceof Error ? error.message : String(error)}`);
    console.error("  run the production harness build first.");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
