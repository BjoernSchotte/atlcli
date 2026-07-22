#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import AjvDraft04 from "ajv-draft-04";
import {
  ADF_COVERAGE,
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
  PINNED_ADF_SCHEMA_PACKAGE,
  PINNED_ADF_SCHEMA_VERSION,
  validateAdf,
  type AdfCoverageProvenance,
} from "@atlcli/confluence/browser";

const repositoryRoot = resolve(import.meta.dir, "..");
export const ADF_FIXTURE_DIR = resolve(
  repositoryRoot,
  "packages/confluence/test-fixtures/adf",
);
export const ADF_SCHEMA_PATH = resolve(ADF_FIXTURE_DIR, "upstream-schema.json");
export const ADF_BASELINE_PATH = resolve(ADF_FIXTURE_DIR, "upstream-baseline.json");
export const ADF_FIXTURE_MANIFEST_PATH = resolve(ADF_FIXTURE_DIR, "fixtures.json");

export const PINNED_PACKAGE_METADATA = Object.freeze({
  name: PINNED_ADF_SCHEMA_PACKAGE,
  version: PINNED_ADF_SCHEMA_VERSION,
  integrity: "sha512-ZOPvvSUhty+m/ZgdgKm86hrsvGfq0VcleUoZv78EnPLEwvXn+obWzwTasKtNvl/44ANS4PCHFS1UUubKvvlBsQ==",
  shasum: "453e67828b1f602233640cca9bb2b97fe21186a1",
  tarball: "https://registry.npmjs.org/@atlaskit/adf-schema/-/adf-schema-56.1.13.tgz",
  schemaPath: "package/dist/json-schema/v1/full.json",
});

export const PINNED_REFERENCE_INDEX = Object.freeze({
  nodes: [
    "blockTaskItem", "blockquote", "bodiedSyncBlock", "bulletList", "codeBlock",
    "date", "doc", "emoji", "expand", "extensionFrame", "hardBreak", "heading",
    "inlineCard", "listItem", "media", "mediaGroup", "mediaInline", "mediaSingle",
    "mention", "multiBodiedExtension", "nestedExpand", "orderedList", "panel",
    "paragraph", "rule", "status", "syncBlock", "table", "table_cell",
    "table_header", "table_row", "text",
  ],
  marks: [
    "backgroundColor", "border", "code", "em", "link", "strike", "strong",
    "subsup", "textColor", "underline",
  ],
});

export interface AdfSchemaInventory {
  nodes: string[];
  marks: string[];
  definitions: string[];
  definitionSha256: Record<string, string>;
}

export interface AdfUpstreamBaseline {
  schemaVersion: 1;
  reviewedAt: string;
  canonicalUrl: string;
  resolvedVersionedUrl: string;
  package: {
    name: string;
    version: string;
    integrity: string;
    shasum: string;
    tarball: string;
    schemaPath: string;
  };
  hashes: { rawSha256: string; canonicalSha256: string };
  inventory: AdfSchemaInventory;
  coverageSha256: string;
  fixturesSha256: string;
  referenceIndex: { nodes: string[]; marks: string[] };
  restContract: {
    pagePath: string;
    bodyFormatParameter: string;
    representation: string;
  };
}

export interface AdfFixtureManifest {
  schemaVersion: 1;
  fixtures: Array<{
    file: string;
    provenance: AdfCoverageProvenance;
    schemaExpectation: "valid" | "invalid";
  }>;
}

export type AdfDriftClassification =
  | "no-drift"
  | "new-upstream-version"
  | "node-added"
  | "node-removed"
  | "mark-added"
  | "mark-removed"
  | "definition-changed"
  | "constraint-tightened"
  | "constraint-relaxed"
  | "reference-index-drift"
  | "rest-contract-drift"
  | "integrity-mismatch"
  | "propagation-mismatch"
  | "watch-unavailable";

export interface AdfDriftFinding {
  classification: AdfDriftClassification;
  detail: string;
}

export interface AdfPinnedCheckReport {
  ok: boolean;
  findings: AdfDriftFinding[];
  hashes: { rawSha256: string; canonicalSha256: string };
  inventory: AdfSchemaInventory;
  fixturesChecked: number;
}

export interface AdfFixtureSchemaResult {
  file: string;
  expected: "valid" | "invalid";
  valid: boolean;
  errors: string[];
}

export interface BoundedFetchResult {
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
  bytes: Uint8Array;
  contentType?: string;
}

export interface AdfUpstreamObservation {
  packageVersion: string;
  packageMetadata: AdfUpstreamBaseline["package"];
  canonicalSchema: string;
  versionedSchema: string;
  packageSchema: string;
  canonicalRedirects: string[];
  canonicalFinalUrl: string;
  referenceIndex: { nodes: string[]; marks: string[] };
  restContractOk: boolean;
}

export interface AdfUpstreamReport {
  ok: boolean;
  checkedAt: string;
  findings: AdfDriftFinding[];
  transientFindings: AdfDriftFinding[];
  observation?: Omit<AdfUpstreamObservation, "canonicalSchema" | "versionedSchema" | "packageSchema"> & {
    canonicalHashes: { rawSha256: string; canonicalSha256: string };
    versionedHashes: { rawSha256: string; canonicalSha256: string };
    packageHashes: { rawSha256: string; canonicalSha256: string };
  };
}

export interface AdfObservedCloudReport {
  ok: boolean;
  skipped: boolean;
  checkedAt: string;
  classification:
    | "no-drift"
    | "watch-unavailable"
    | "node-added"
    | "mark-added"
    | "definition-changed";
  detail: string;
  pageCount?: number;
  pageVersions?: number[];
  currentUpstreamVersion?: string;
  pinnedSchemaValid?: boolean;
  currentSchemaValid?: boolean;
  structuralHash?: string;
  nodeTypes?: string[];
  markTypes?: string[];
  nodeAttributeKeys?: Record<string, string[]>;
  markAttributeKeys?: Record<string, string[]>;
  extensionCategories?: string[];
  mediaCategories?: string[];
}

interface AdfStructuralSignature {
  nodeTypes: string[];
  markTypes: string[];
  nodeAttributeKeys: Record<string, string[]>;
  markAttributeKeys: Record<string, string[]>;
  extensionCategories: string[];
  mediaCategories: string[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const allowedWatchHosts = new Set([
  "go.atlassian.com",
  "unpkg.com",
  "registry.npmjs.org",
  "developer.atlassian.com",
]);

const MAX_SCHEMA_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVED_CLOUD_PAGES = 16;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_TARBALL_BYTES = 12 * 1024 * 1024;
const MAX_UNPACKED_TARBALL_BYTES = 32 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response declares ${declared} bytes, over the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response size limit exceeded");
        throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function fetchBounded(
  requestedUrl: string,
  options: {
    fetch?: FetchLike;
    maxBytes: number;
    maxRedirects?: number;
    retries?: number;
    timeoutMs?: number;
  },
): Promise<BoundedFetchResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const retries = options.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      let current = new URL(requestedUrl);
      const redirects: string[] = [];
      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        if (current.protocol !== "https:" || !allowedWatchHosts.has(current.hostname)) {
          throw new Error(`ADF watch refused URL ${current.toString()}.`);
        }
        const response = await fetcher(current, {
          method: "GET",
          redirect: "manual",
          headers: { Accept: "application/json,text/html;q=0.8,*/*;q=0.1" },
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error(`Redirect from ${current.toString()} has no Location header.`);
          if (redirectCount === maxRedirects) throw new Error("ADF watch redirect limit exceeded.");
          await response.body?.cancel("redirect followed without reading body");
          redirects.push(current.toString());
          current = new URL(location, current);
          continue;
        }
        if (!response.ok) throw new Error(`ADF watch request failed with HTTP ${response.status}.`);
        return {
          requestedUrl,
          finalUrl: current.toString(),
          redirects,
          bytes: await readBoundedBody(response, options.maxBytes),
          contentType: response.headers.get("content-type") ?? undefined,
        };
      }
      throw new Error("ADF watch redirect loop exhausted.");
    } catch (error) {
      lastError = error;
      if (attempt < retries) await Bun.sleep(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ADF watch request failed.");
}

function parseJsonResult(result: BoundedFetchResult, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(decodeUtf8(result.bytes)) as unknown;
    if (!isRecord(value)) throw new Error("root is not an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function verifyPackageIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const [algorithm, expected] = integrity.split("-", 2);
  if (algorithm !== "sha512" || !expected) return false;
  const actual = createHash("sha512").update(bytes).digest("base64");
  return actual === expected;
}

function readTarString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return decodeUtf8(nul >= 0 ? bytes.subarray(0, nul) : bytes);
}

/** Extract one regular file from a bounded npm tarball without writing it. */
export function extractTarFile(gzipBytes: Uint8Array, wantedPath: string): Uint8Array {
  const tar = new Uint8Array(gunzipSync(gzipBytes, {
    maxOutputLength: MAX_UNPACKED_TARBALL_BYTES,
  }));
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("Package tarball contains an unsafe path.");
    }
    const sizeText = readTarString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Package tarball contains an invalid size.");
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.byteLength) throw new Error("Package tarball is truncated.");
    const typeFlag = header[156];
    if (path === wantedPath) {
      if (typeFlag !== 0 && typeFlag !== 48) throw new Error("Pinned schema member is not a regular file.");
      return tar.slice(bodyStart, bodyEnd);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Package tarball does not contain ${wantedPath}.`);
}

export function extractReferenceIndex(html: string): { nodes: string[]; marks: string[] } {
  const nodes = new Set<string>();
  const marks = new Set<string>();
  const pattern = /href=["'][^"']*\/apis\/document\/(nodes|marks)\/([^/"'?#]+)\/?["']/gu;
  for (const match of html.matchAll(pattern)) {
    const collection = match[1] === "nodes" ? nodes : marks;
    collection.add(decodeURIComponent(match[2]!));
  }
  return { nodes: [...nodes].sort(), marks: [...marks].sort() };
}

export function propagationFindings(
  sources: Array<{ name: string; raw: string }>,
): AdfDriftFinding[] {
  const canonicalHashes = new Map<string, string[]>();
  for (const source of sources) {
    const hash = schemaHashes(source.raw).canonicalSha256;
    canonicalHashes.set(hash, [...(canonicalHashes.get(hash) ?? []), source.name]);
  }
  if (canonicalHashes.size <= 1) return [];
  return [{
    classification: "propagation-mismatch",
    detail: `Schema sources disagree: ${sources.map(({ name }) => name).join(", ")}.`,
  }];
}

function metadataPackage(value: Record<string, unknown>): AdfUpstreamBaseline["package"] {
  if (value.name !== PINNED_ADF_SCHEMA_PACKAGE || typeof value.version !== "string" || !isRecord(value.dist)) {
    throw new Error("npm package metadata has an unexpected shape.");
  }
  const dist = value.dist;
  for (const key of ["integrity", "shasum", "tarball"] as const) {
    if (typeof dist[key] !== "string") throw new Error(`npm package metadata is missing dist.${key}.`);
  }
  return {
    name: value.name,
    version: value.version,
    integrity: dist.integrity as string,
    shasum: dist.shasum as string,
    tarball: dist.tarball as string,
    schemaPath: "package/dist/json-schema/v1/full.json",
  };
}

export async function observeUpstream(
  options: { fetch?: FetchLike } = {},
): Promise<AdfUpstreamObservation> {
  const fetcher = options.fetch;
  const [canonical, latestMetadataResult, referenceResult, restResult] = await Promise.all([
    fetchBounded("https://go.atlassian.com/adf-json-schema", { fetch: fetcher, maxBytes: MAX_SCHEMA_BYTES }),
    fetchBounded("https://registry.npmjs.org/%40atlaskit%2Fadf-schema/latest", { fetch: fetcher, maxBytes: MAX_METADATA_BYTES }),
    fetchBounded("https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/", { fetch: fetcher, maxBytes: MAX_HTML_BYTES }),
    fetchBounded("https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/", { fetch: fetcher, maxBytes: MAX_HTML_BYTES }),
  ]);
  const latestMetadata = parseJsonResult(latestMetadataResult, "npm latest metadata");
  const packageMetadata = metadataPackage(latestMetadata);
  const exactMetadataResult = await fetchBounded(
    `https://registry.npmjs.org/%40atlaskit%2Fadf-schema/${encodeURIComponent(packageMetadata.version)}`,
    { fetch: fetcher, maxBytes: MAX_METADATA_BYTES },
  );
  const exactPackage = metadataPackage(parseJsonResult(exactMetadataResult, "npm exact-version metadata"));
  if (canonicalJson(packageMetadata) !== canonicalJson(exactPackage)) {
    const error = new Error("npm latest and exact-version metadata disagree.");
    error.name = "AdfPropagationError";
    throw error;
  }
  const [tarballResult, versionedResult] = await Promise.all([
    fetchBounded(packageMetadata.tarball, { fetch: fetcher, maxBytes: MAX_TARBALL_BYTES }),
    fetchBounded(
      `https://unpkg.com/@atlaskit/adf-schema@${packageMetadata.version}/dist/json-schema/v1/full.json`,
      { fetch: fetcher, maxBytes: MAX_SCHEMA_BYTES },
    ),
  ]);
  if (!verifyPackageIntegrity(tarballResult.bytes, packageMetadata.integrity)) {
    const error = new Error("Package tarball does not match npm integrity.");
    error.name = "AdfIntegrityError";
    throw error;
  }
  const packageSchema = decodeUtf8(extractTarFile(tarballResult.bytes, packageMetadata.schemaPath));
  const canonicalSchema = decodeUtf8(canonical.bytes);
  const versionedSchema = decodeUtf8(versionedResult.bytes);
  for (const [label, raw] of [["canonical", canonicalSchema], ["versioned", versionedSchema], ["package", packageSchema]] as const) {
    inventoryAdfSchema(JSON.parse(raw) as unknown);
    if (raw.length === 0) throw new Error(`${label} schema is empty.`);
  }
  const restHtml = decodeUtf8(restResult.bytes);
  return {
    packageVersion: packageMetadata.version,
    packageMetadata,
    canonicalSchema,
    versionedSchema,
    packageSchema,
    canonicalRedirects: canonical.redirects,
    canonicalFinalUrl: canonical.finalUrl,
    referenceIndex: extractReferenceIndex(decodeUtf8(referenceResult.bytes)),
    restContractOk:
      restHtml.includes("body-format") &&
      restHtml.includes("atlas_doc_format") &&
      restHtml.includes("PrimaryBodyRepresentation"),
  };
}

async function findingsForObservation(
  baseline: AdfUpstreamBaseline,
  pinnedSchema: unknown,
  observation: AdfUpstreamObservation,
): Promise<AdfDriftFinding[]> {
  const findings: AdfDriftFinding[] = [];
  if (observation.packageVersion !== baseline.package.version) {
    findings.push({
      classification: "new-upstream-version",
      detail: `Published package is ${observation.packageVersion}; pin is ${baseline.package.version}.`,
    });
  }
  if (
    observation.packageVersion === baseline.package.version &&
    observation.packageMetadata.integrity !== baseline.package.integrity
  ) {
    findings.push({ classification: "integrity-mismatch", detail: "Exact package integrity differs from the reviewed baseline." });
  }
  const expectedVersionedSuffix = `/@atlaskit/adf-schema@${observation.packageVersion}/dist/json-schema/v1/full.json`;
  if (!new URL(observation.canonicalFinalUrl).pathname.endsWith(expectedVersionedSuffix)) {
    findings.push({ classification: "propagation-mismatch", detail: "Canonical redirect does not resolve to the published exact version." });
  }
  findings.push(...propagationFindings([
    { name: "canonical-link", raw: observation.canonicalSchema },
    { name: "versioned-cdn", raw: observation.versionedSchema },
    { name: "verified-package", raw: observation.packageSchema },
  ]));
  findings.push(...classifySchemaDrift(pinnedSchema, JSON.parse(observation.packageSchema) as unknown)
    .filter(({ classification }) => classification !== "no-drift"));
  if (canonicalJson(observation.referenceIndex) !== canonicalJson(baseline.referenceIndex)) {
    findings.push({ classification: "reference-index-drift", detail: "Official ADF node/mark link slugs changed." });
  }
  if (!observation.restContractOk) {
    findings.push({ classification: "rest-contract-drift", detail: "Official Confluence page docs no longer expose the expected ADF body contract." });
  }
  const candidateSchema = JSON.parse(observation.packageSchema) as unknown;
  const fixtureResults = await checkFixtureCorpusAgainstSchema(candidateSchema);
  for (const result of fixtureResults) {
    const matches = result.expected === "valid" ? result.valid : !result.valid;
    if (!matches) {
      findings.push({
        classification: "definition-changed",
        detail: `Candidate schema changed fixture ${result.file} from expected ${result.expected} to ${result.valid ? "valid" : "invalid"}.`,
      });
    }
  }
  if (findings.length === 0) findings.push({ classification: "no-drift", detail: "No upstream ADF drift detected." });
  return findings;
}

function findingKey(finding: AdfDriftFinding): string {
  return `${finding.classification}\0${finding.detail}`;
}

export async function checkUpstream(options: {
  observe?: () => Promise<AdfUpstreamObservation>;
  baselinePath?: string;
  schemaPath?: string;
} = {}): Promise<AdfUpstreamReport> {
  const [baselineRaw, pinnedRaw] = await Promise.all([
    readFile(options.baselinePath ?? ADF_BASELINE_PATH, "utf8"),
    readFile(options.schemaPath ?? ADF_SCHEMA_PATH, "utf8"),
  ]);
  const baseline = JSON.parse(baselineRaw) as AdfUpstreamBaseline;
  const pinnedSchema = JSON.parse(pinnedRaw) as unknown;
  const inspect = options.observe ?? (() => observeUpstream());
  try {
    const first = await inspect();
    const firstFindings = await findingsForObservation(baseline, pinnedSchema, first);
    let observation = first;
    let findings = firstFindings;
    let transientFindings: AdfDriftFinding[] = [];
    if (firstFindings.some(({ classification }) => classification !== "no-drift")) {
      const second = await inspect();
      const secondFindings = await findingsForObservation(baseline, pinnedSchema, second);
      const secondKeys = new Set(secondFindings.map(findingKey));
      transientFindings = firstFindings.filter((finding) => !secondKeys.has(findingKey(finding)));
      observation = second;
      findings = secondFindings;
    }
    const canonicalHashes = schemaHashes(observation.canonicalSchema);
    const versionedHashes = schemaHashes(observation.versionedSchema);
    const packageHashes = schemaHashes(observation.packageSchema);
    return {
      ok: findings.every(({ classification }) => classification === "no-drift"),
      checkedAt: new Date().toISOString(),
      findings,
      transientFindings,
      observation: {
        packageVersion: observation.packageVersion,
        packageMetadata: observation.packageMetadata,
        canonicalRedirects: observation.canonicalRedirects,
        canonicalFinalUrl: observation.canonicalFinalUrl,
        referenceIndex: observation.referenceIndex,
        restContractOk: observation.restContractOk,
        canonicalHashes,
        versionedHashes,
        packageHashes,
      },
    };
  } catch (error) {
    const classification: AdfDriftClassification =
      error instanceof Error && error.name === "AdfIntegrityError"
        ? "integrity-mismatch"
        : error instanceof Error && error.name === "AdfPropagationError"
          ? "propagation-mismatch"
        : "watch-unavailable";
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      findings: [{
        classification,
        detail: error instanceof Error ? error.message : String(error),
      }],
      transientFindings: [],
    };
  }
}

export function renderUpstreamMarkdown(report: AdfUpstreamReport): string {
  const lines = [
    "# ADF drift watch",
    "",
    `- Status: **${report.ok ? "no drift" : "attention required"}**`,
    `- Checked: ${report.checkedAt}`,
    `- Package: ${report.observation?.packageVersion ?? "unavailable"}`,
    "",
    "## Findings",
    "",
    ...report.findings.map((finding) => `- \`${finding.classification}\`: ${finding.detail}`),
  ];
  if (report.transientFindings.length > 0) {
    lines.push("", "## Transient findings", "", ...report.transientFindings.map(
      (finding) => `- \`${finding.classification}\`: ${finding.detail}`,
    ));
  }
  return `${lines.join("\n")}\n`;
}

function collectStructuralSignature(document: {
  type: string;
  content: unknown[];
}): AdfStructuralSignature {
  const nodeTypes = new Set<string>();
  const markTypes = new Set<string>();
  const nodeAttributes = new Map<string, Set<string>>();
  const markAttributes = new Map<string, Set<string>>();
  const extensionCategories = new Set<string>();
  const mediaCategories = new Set<string>();
  const stack: Array<Record<string, unknown>> = [document as unknown as Record<string, unknown>];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const type = typeof node.type === "string" ? node.type : "invalid";
    nodeTypes.add(type);
    if (isRecord(node.attrs)) {
      const keys = nodeAttributes.get(type) ?? new Set<string>();
      for (const key of Object.keys(node.attrs)) keys.add(key);
      nodeAttributes.set(type, keys);
      if (type === "extension" || type === "inlineExtension" || type === "bodiedExtension") {
        const extensionType = node.attrs.extensionType;
        extensionCategories.add(typeof extensionType === "string" ? extensionType : "unspecified");
      }
      if (type === "media" || type === "mediaInline") {
        const mediaType = node.attrs.type;
        mediaCategories.add(typeof mediaType === "string" ? mediaType : "unspecified");
      }
    }
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (!isRecord(mark) || typeof mark.type !== "string") continue;
        markTypes.add(mark.type);
        if (isRecord(mark.attrs)) {
          const keys = markAttributes.get(mark.type) ?? new Set<string>();
          for (const key of Object.keys(mark.attrs)) keys.add(key);
          markAttributes.set(mark.type, keys);
        }
      }
    }
    if (Array.isArray(node.content)) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        if (isRecord(node.content[index])) stack.push(node.content[index] as Record<string, unknown>);
      }
    }
  }
  const mapSets = (source: Map<string, Set<string>>): Record<string, string[]> => Object.fromEntries(
    [...source.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([type, keys]) => [type, [...keys].sort()],
    ),
  );
  return {
    nodeTypes: [...nodeTypes].sort(),
    markTypes: [...markTypes].sort(),
    nodeAttributeKeys: mapSets(nodeAttributes),
    markAttributeKeys: mapSets(markAttributes),
    extensionCategories: [...extensionCategories].sort(),
    mediaCategories: [...mediaCategories].sort(),
  };
}

function mergeStructuralSignatures(signatures: AdfStructuralSignature[]): AdfStructuralSignature {
  const nodeTypes = new Set<string>();
  const markTypes = new Set<string>();
  const nodeAttributeKeys = new Map<string, Set<string>>();
  const markAttributeKeys = new Map<string, Set<string>>();
  const extensionCategories = new Set<string>();
  const mediaCategories = new Set<string>();
  const mergeAttributes = (
    target: Map<string, Set<string>>,
    source: Record<string, string[]>,
  ): void => {
    for (const [type, keys] of Object.entries(source)) {
      const merged = target.get(type) ?? new Set<string>();
      for (const key of keys) merged.add(key);
      target.set(type, merged);
    }
  };
  for (const signature of signatures) {
    for (const type of signature.nodeTypes) nodeTypes.add(type);
    for (const type of signature.markTypes) markTypes.add(type);
    mergeAttributes(nodeAttributeKeys, signature.nodeAttributeKeys);
    mergeAttributes(markAttributeKeys, signature.markAttributeKeys);
    for (const category of signature.extensionCategories) extensionCategories.add(category);
    for (const category of signature.mediaCategories) mediaCategories.add(category);
  }
  const sortedAttributes = (source: Map<string, Set<string>>): Record<string, string[]> => Object.fromEntries(
    [...source.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([type, keys]) => [type, [...keys].sort()],
    ),
  );
  return {
    nodeTypes: [...nodeTypes].sort(),
    markTypes: [...markTypes].sort(),
    nodeAttributeKeys: sortedAttributes(nodeAttributeKeys),
    markAttributeKeys: sortedAttributes(markAttributeKeys),
    extensionCategories: [...extensionCategories].sort(),
    mediaCategories: [...mediaCategories].sort(),
  };
}

function observedPageIds(env: Record<string, string | undefined>): string[] {
  const configured = env.ADF_WATCH_PAGE_IDS?.trim() || env.ADF_WATCH_PAGE_ID || "";
  const pageIds = [...new Set(configured.split(",").map((value) => value.trim()).filter(Boolean))];
  if (pageIds.length > MAX_OBSERVED_CLOUD_PAGES) {
    throw new Error(`Observed-Cloud watch accepts at most ${MAX_OBSERVED_CLOUD_PAGES} pages.`);
  }
  if (pageIds.some((pageId) => pageId.length > 256)) {
    throw new Error("Observed-Cloud watch received an invalid page reference.");
  }
  return pageIds;
}

function compileAdfSchema(schema: unknown): (document: unknown) => boolean {
  const ajv = new AjvDraft04({ allErrors: true, strict: false, validateSchema: true });
  const validate = ajv.compile(schema as object);
  return (document: unknown): boolean => Boolean(validate(document));
}

export async function checkObservedCloud(options: {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  observeSchema?: () => Promise<AdfUpstreamObservation>;
} = {}): Promise<AdfObservedCloudReport> {
  const env = options.env ?? process.env;
  const baseUrl = env.ADF_WATCH_BASE_URL;
  const email = env.ADF_WATCH_EMAIL;
  const token = env.ADF_WATCH_API_TOKEN;
  const checkedAt = new Date().toISOString();
  let pageIds: string[];
  try {
    pageIds = observedPageIds(env);
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      checkedAt,
      classification: "watch-unavailable",
      detail: error instanceof Error ? error.message : "Observed-Cloud page configuration is invalid.",
    };
  }
  if (!baseUrl || !email || !token || pageIds.length === 0) {
    return {
      ok: true,
      skipped: true,
      checkedAt,
      classification: "no-drift",
      detail: "Observed-Cloud watch skipped because its optional credentials are not configured.",
    };
  }
  try {
    const origin = new URL(baseUrl);
    if (origin.protocol !== "https:") throw new Error("Observed-Cloud base URL must use HTTPS.");
    const upstream = await (options.observeSchema ?? (() => observeUpstream()))();
    const pinnedSchemaRaw = await readFile(ADF_SCHEMA_PATH, "utf8");
    const pinnedSchema = JSON.parse(pinnedSchemaRaw) as unknown;
    const currentSchema = JSON.parse(upstream.packageSchema) as unknown;
    const candidateInventory = inventoryAdfSchema(currentSchema);
    const validatePinnedSchema = compileAdfSchema(pinnedSchema);
    const validateCurrentSchema = compileAdfSchema(currentSchema);
    const signatures: AdfStructuralSignature[] = [];
    const pageVersions: number[] = [];
    const diagnostics: ReturnType<typeof validateAdf>["diagnostics"] = [];
    let pinnedSchemaValid = true;
    let currentSchemaValid = true;
    for (const pageId of pageIds) {
      const url = new URL(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, origin);
      url.searchParams.set("body-format", "atlas_doc_format");
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`,
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new Error("Observed-Cloud page read failed before receiving a response.");
      }
      if (!response.ok) throw new Error(`Observed-Cloud page read failed with HTTP ${response.status}.`);
      const bytes = await readBoundedBody(response, MAX_SCHEMA_BYTES * 4);
      let payload: unknown;
      try {
        payload = JSON.parse(decodeUtf8(bytes)) as unknown;
      } catch {
        throw new Error("Observed-Cloud response is not valid JSON.");
      }
      if (!isRecord(payload) || !isRecord(payload.version) || !Number.isInteger(payload.version.number)) {
        throw new Error("Observed-Cloud response has no valid version envelope.");
      }
      if (!isRecord(payload.body) || !isRecord(payload.body.atlas_doc_format)) {
        throw new Error("Observed-Cloud response has no ADF body envelope.");
      }
      const body = payload.body.atlas_doc_format;
      if (body.representation !== "atlas_doc_format" || typeof body.value !== "string") {
        throw new Error("Observed-Cloud response has an unexpected body representation.");
      }
      const validated = validateAdf(body.value);
      signatures.push(collectStructuralSignature(validated.document));
      pageVersions.push(payload.version.number as number);
      diagnostics.push(...validated.diagnostics);
      pinnedSchemaValid = validatePinnedSchema(validated.document) && pinnedSchemaValid;
      currentSchemaValid = validateCurrentSchema(validated.document) && currentSchemaValid;
    }
    const signature = mergeStructuralSignatures(signatures);
    const pinnedNodes = new Set<string>(PINNED_ADF_NODE_TYPES);
    const pinnedMarks = new Set<string>(PINNED_ADF_MARK_TYPES);
    const candidateNodes = new Set(candidateInventory.nodes);
    const candidateMarks = new Set(candidateInventory.marks);
    const unknownNodes = signature.nodeTypes.filter((type) => !pinnedNodes.has(type) || !candidateNodes.has(type));
    const unknownMarks = signature.markTypes.filter((type) => !pinnedMarks.has(type) || !candidateMarks.has(type));
    const unknownAttributes = diagnostics.filter(({ kind }) => kind === "unknown-attribute");
    const classification = unknownNodes.length > 0
      ? "node-added"
      : unknownMarks.length > 0
        ? "mark-added"
        : unknownAttributes.length > 0 || !pinnedSchemaValid || !currentSchemaValid
          ? "definition-changed"
          : "no-drift";
    pageVersions.sort((left, right) => left - right);
    const structuralHash = sha256(canonicalJson({ pageVersions, ...signature }));
    return {
      ok: classification === "no-drift",
      skipped: false,
      checkedAt,
      classification,
      detail: classification === "no-drift"
        ? "Observed Cloud structures are covered by both pinned and current upstream inventories."
        : classification === "definition-changed"
          ? "At least one observed structure does not validate against both reviewed schema contracts."
          : `Observed structures are not covered by both inventories: ${[...unknownNodes, ...unknownMarks].join(", ")}.`,
      pageCount: pageIds.length,
      pageVersions,
      currentUpstreamVersion: upstream.packageVersion,
      pinnedSchemaValid,
      currentSchemaValid,
      structuralHash,
      ...signature,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      checkedAt,
      classification: "watch-unavailable",
      detail: error instanceof Error && error.message.startsWith("Observed-Cloud")
        ? error.message
        : "Observed-Cloud watch failed before a safe structural report could be produced.",
    };
  }
}

export function renderObservedMarkdown(report: AdfObservedCloudReport): string {
  return [
    "# ADF observed-Cloud watch",
    "",
    `- Status: **${report.skipped ? "skipped" : report.ok ? "no drift" : "attention required"}**`,
    `- Classification: \`${report.classification}\``,
    `- Checked: ${report.checkedAt}`,
    `- Detail: ${report.detail}`,
    ...(report.pageCount !== undefined ? [`- Pages inventoried: ${report.pageCount}`] : []),
    ...(report.currentUpstreamVersion ? [`- Current upstream package: ${report.currentUpstreamVersion}`] : []),
    ...(report.pinnedSchemaValid !== undefined ? [`- Pinned schema valid: ${report.pinnedSchemaValid}`] : []),
    ...(report.currentSchemaValid !== undefined ? [`- Current schema valid: ${report.currentSchemaValid}`] : []),
    ...(report.structuralHash ? [`- Structural hash: \`${report.structuralHash}\``] : []),
    "",
  ].join("\n");
}

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Canonical JSON rejects cycles.");
    ancestors.add(value);
    const result = `[${value.map((entry) => canonicalValue(entry, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) throw new TypeError("Canonical JSON rejects cycles.");
    ancestors.add(value);
    const result = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalValue(value[key], ancestors)}`
    )).join(",")}}`;
    ancestors.delete(value);
    return result;
  }
  throw new TypeError("Canonical JSON accepts only JSON values.");
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set());
}

function definitionType(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.properties) || !isRecord(value.properties.type)) {
    return undefined;
  }
  const type = value.properties.type;
  if (Array.isArray(type.enum) && typeof type.enum[0] === "string") return type.enum[0];
  if (typeof type.const === "string") return type.const;
  return undefined;
}

export function inventoryAdfSchema(schema: unknown): AdfSchemaInventory {
  if (!isRecord(schema) || !isRecord(schema.definitions)) {
    throw new TypeError("ADF schema must contain a definitions object.");
  }
  const definitions = Object.keys(schema.definitions).sort();
  const nodes = new Set<string>();
  const marks = new Set<string>();
  const definitionSha256: Record<string, string> = {};
  for (const name of definitions) {
    const definition = schema.definitions[name];
    definitionSha256[name] = sha256(canonicalJson(definition));
    const type = definitionType(definition);
    if (!type) continue;
    if (name.endsWith("_node")) nodes.add(type);
    if (name.endsWith("_mark")) marks.add(type);
  }
  return {
    nodes: [...nodes].sort(),
    marks: [...marks].sort(),
    definitions,
    definitionSha256,
  };
}

export function schemaHashes(raw: string): { rawSha256: string; canonicalSha256: string } {
  const parsed = JSON.parse(raw) as unknown;
  return { rawSha256: sha256(raw), canonicalSha256: sha256(canonicalJson(parsed)) };
}

export function coverageHash(): string {
  return sha256(canonicalJson(ADF_COVERAGE));
}

export async function checkFixtureCorpusAgainstSchema(
  schema: unknown,
  fixtureManifestPath = ADF_FIXTURE_MANIFEST_PATH,
): Promise<AdfFixtureSchemaResult[]> {
  const manifest = JSON.parse(await readFile(fixtureManifestPath, "utf8")) as AdfFixtureManifest;
  const ajv = new AjvDraft04({ allErrors: true, strict: false, validateSchema: true });
  const validate = ajv.compile(schema as object);
  const fixtureRoot = dirname(fixtureManifestPath);
  const results: AdfFixtureSchemaResult[] = [];
  for (const fixture of manifest.fixtures) {
    const value = JSON.parse(await readFile(resolve(fixtureRoot, fixture.file), "utf8")) as unknown;
    const valid = Boolean(validate(value));
    results.push({
      file: fixture.file,
      expected: fixture.schemaExpectation,
      valid,
      errors: (validate.errors ?? []).slice(0, 20).map((error) => (
        `${error.instancePath || "$"} ${error.message ?? error.keyword}`
      )),
    });
  }
  return results;
}

export function classifySchemaDrift(
  pinnedSchema: unknown,
  candidateSchema: unknown,
): AdfDriftFinding[] {
  const pinned = inventoryAdfSchema(pinnedSchema);
  const candidate = inventoryAdfSchema(candidateSchema);
  const findings: AdfDriftFinding[] = [];
  compareSet(pinned.nodes, candidate.nodes, "node-added", "node-removed", findings);
  compareSet(pinned.marks, candidate.marks, "mark-added", "mark-removed", findings);
  const pinnedDefinitionSet = new Set(pinned.definitions);
  const candidateDefinitionSet = new Set(candidate.definitions);
  for (const name of candidate.definitions) {
    if (!pinnedDefinitionSet.has(name)) {
      findings.push({ classification: "definition-changed", detail: `Definition ${name} was added.` });
    }
  }
  for (const name of pinned.definitions) {
    if (!candidateDefinitionSet.has(name)) {
      findings.push({ classification: "definition-changed", detail: `Definition ${name} was removed.` });
    }
  }
  const sharedDefinitions = pinned.definitions.filter((name) => candidate.definitionSha256[name]);
  for (const name of sharedDefinitions) {
    if (pinned.definitionSha256[name] === candidate.definitionSha256[name]) continue;
    const relation = constraintRelation(
      (pinnedSchema as { definitions: Record<string, unknown> }).definitions[name],
      (candidateSchema as { definitions: Record<string, unknown> }).definitions[name],
    );
    findings.push({
      classification: relation,
      detail: `Definition ${name} changed.`,
    });
  }
  if (findings.length === 0) findings.push({ classification: "no-drift", detail: "Pinned and candidate schema semantics match." });
  return findings;
}

function compareSet(
  before: string[],
  after: string[],
  added: AdfDriftClassification,
  removed: AdfDriftClassification,
  findings: AdfDriftFinding[],
): void {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const value of after) if (!beforeSet.has(value)) findings.push({ classification: added, detail: value });
  for (const value of before) if (!afterSet.has(value)) findings.push({ classification: removed, detail: value });
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
}

function constraintRelation(before: unknown, after: unknown): AdfDriftClassification {
  let tightened = false;
  let relaxed = false;
  const stack: Array<[unknown, unknown]> = [[before, after]];
  while (stack.length > 0) {
    const [left, right] = stack.pop()!;
    if (!isRecord(left) || !isRecord(right)) continue;
    const beforeRequired = stringSet(left.required);
    const afterRequired = stringSet(right.required);
    if ([...afterRequired].some((key) => !beforeRequired.has(key))) tightened = true;
    if ([...beforeRequired].some((key) => !afterRequired.has(key))) relaxed = true;
    const beforeEnum = stringSet(left.enum);
    const afterEnum = stringSet(right.enum);
    if (beforeEnum.size > 0 && afterEnum.size > 0) {
      if ([...beforeEnum].some((value) => !afterEnum.has(value))) tightened = true;
      if ([...afterEnum].some((value) => !beforeEnum.has(value))) relaxed = true;
    }
    for (const key of ["minimum", "minItems", "minLength"] as const) {
      if (typeof left[key] === "number" && typeof right[key] === "number") {
        if (right[key] > left[key]) tightened = true;
        if (right[key] < left[key]) relaxed = true;
      }
    }
    for (const key of ["maximum", "maxItems", "maxLength"] as const) {
      if (typeof left[key] === "number" && typeof right[key] === "number") {
        if (right[key] < left[key]) tightened = true;
        if (right[key] > left[key]) relaxed = true;
      }
    }
    if (left.additionalProperties !== right.additionalProperties) {
      if (left.additionalProperties !== false && right.additionalProperties === false) tightened = true;
      if (left.additionalProperties === false && right.additionalProperties !== false) relaxed = true;
    }
    for (const key of Object.keys(left)) {
      if (key in right) stack.push([left[key], right[key]]);
    }
  }
  if (tightened && !relaxed) return "constraint-tightened";
  if (relaxed && !tightened) return "constraint-relaxed";
  return "definition-changed";
}

export async function checkPinned(paths: {
  schema?: string;
  baseline?: string;
  fixtures?: string;
} = {}): Promise<AdfPinnedCheckReport> {
  const schemaPath = paths.schema ?? ADF_SCHEMA_PATH;
  const baselinePath = paths.baseline ?? ADF_BASELINE_PATH;
  const fixtureManifestPath = paths.fixtures ?? ADF_FIXTURE_MANIFEST_PATH;
  const [rawSchema, rawBaseline, rawFixtures] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(baselinePath, "utf8"),
    readFile(fixtureManifestPath, "utf8"),
  ]);
  const schema = JSON.parse(rawSchema) as unknown;
  const baseline = JSON.parse(rawBaseline) as AdfUpstreamBaseline;
  const fixtureManifest = JSON.parse(rawFixtures) as AdfFixtureManifest;
  const hashes = schemaHashes(rawSchema);
  const inventory = inventoryAdfSchema(schema);
  const findings: AdfDriftFinding[] = [];
  if (hashes.rawSha256 !== baseline.hashes.rawSha256) {
    findings.push({ classification: "definition-changed", detail: "Pinned schema raw hash differs from its baseline." });
  }
  if (hashes.canonicalSha256 !== baseline.hashes.canonicalSha256) {
    findings.push({ classification: "definition-changed", detail: "Pinned schema canonical hash differs from its baseline." });
  }
  if (canonicalJson(inventory) !== canonicalJson(baseline.inventory)) {
    findings.push({ classification: "definition-changed", detail: "Pinned schema inventory differs from its baseline." });
  }
  if (
    baseline.package.name !== PINNED_ADF_SCHEMA_PACKAGE ||
    baseline.package.version !== PINNED_ADF_SCHEMA_VERSION
  ) {
    findings.push({ classification: "definition-changed", detail: "ADF baseline package pin differs from the reviewed source contract." });
  }
  if (coverageHash() !== baseline.coverageSha256) {
    findings.push({ classification: "definition-changed", detail: "ADF coverage manifest differs from its reviewed baseline." });
  }
  if (sha256(canonicalJson(fixtureManifest)) !== baseline.fixturesSha256) {
    findings.push({ classification: "definition-changed", detail: "ADF fixture manifest differs from its reviewed baseline." });
  }
  const expectedNodes = [...PINNED_ADF_NODE_TYPES].sort();
  const expectedMarks = [...PINNED_ADF_MARK_TYPES].sort();
  if (canonicalJson(inventory.nodes) !== canonicalJson(expectedNodes)) {
    findings.push({ classification: "definition-changed", detail: "Pinned node inventory is not classified exactly once." });
  }
  if (canonicalJson(inventory.marks) !== canonicalJson(expectedMarks)) {
    findings.push({ classification: "definition-changed", detail: "Pinned mark inventory is not classified exactly once." });
  }
  const fixtureRoot = dirname(fixtureManifestPath);
  for (const fixture of fixtureManifest.fixtures) {
    const raw = await readFile(resolve(fixtureRoot, fixture.file), "utf8");
    const result = validateAdf(raw);
    const hasUnknown = result.diagnostics.some(({ kind }) => kind === "unknown-node" || kind === "unknown-mark");
    if (fixture.schemaExpectation === "valid" && hasUnknown) {
      findings.push({ classification: "definition-changed", detail: `Schema-valid fixture ${fixture.file} contains unknown types.` });
    }
    if (fixture.schemaExpectation === "invalid" && !hasUnknown) {
      findings.push({ classification: "definition-changed", detail: `Schema-invalid fixture ${fixture.file} no longer exercises drift.` });
    }
  }
  const schemaFixtureResults = await checkFixtureCorpusAgainstSchema(schema, fixtureManifestPath);
  for (const result of schemaFixtureResults) {
    const matches = result.expected === "valid" ? result.valid : !result.valid;
    if (!matches) {
      findings.push({
        classification: "definition-changed",
        detail: `Fixture ${result.file} expected ${result.expected} under the pinned schema but was ${result.valid ? "valid" : "invalid"}.`,
      });
    }
  }
  if (findings.length === 0) findings.push({ classification: "no-drift", detail: "Committed ADF snapshot, inventory, coverage, and fixtures agree." });
  return {
    ok: findings.every(({ classification }) => classification === "no-drift"),
    findings,
    hashes,
    inventory,
    fixturesChecked: fixtureManifest.fixtures.length,
  };
}

export function makeBaseline(
  rawSchema: string,
  fixtureManifest: AdfFixtureManifest,
  packageMetadata: AdfUpstreamBaseline["package"],
  reviewedAt: string,
): AdfUpstreamBaseline {
  const schema = JSON.parse(rawSchema) as unknown;
  return {
    schemaVersion: 1,
    reviewedAt,
    canonicalUrl: "https://go.atlassian.com/adf-json-schema",
    resolvedVersionedUrl: `https://unpkg.com/@atlaskit/adf-schema@${packageMetadata.version}/dist/json-schema/v1/full.json`,
    package: packageMetadata,
    hashes: schemaHashes(rawSchema),
    inventory: inventoryAdfSchema(schema),
    coverageSha256: coverageHash(),
    fixturesSha256: sha256(canonicalJson(fixtureManifest)),
    referenceIndex: {
      nodes: [...PINNED_REFERENCE_INDEX.nodes],
      marks: [...PINNED_REFERENCE_INDEX.marks],
    },
    restContract: {
      pagePath: "/wiki/api/v2/pages/{id}",
      bodyFormatParameter: "body-format",
      representation: "atlas_doc_format",
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

async function runCli(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check-pinned") {
    const report = await checkPinned();
    console.log(JSON.stringify({
      ok: report.ok,
      findings: report.findings,
      nodes: report.inventory.nodes.length,
      marks: report.inventory.marks.length,
      definitions: report.inventory.definitions.length,
      fixturesChecked: report.fixturesChecked,
      hashes: report.hashes,
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "check-upstream") {
    const outFlag = args.find((arg) => arg.startsWith("--out-dir="));
    const outDir = resolve(repositoryRoot, outFlag?.slice("--out-dir=".length) || "artifacts/adf-drift");
    const report = await checkUpstream();
    await mkdir(outDir, { recursive: true });
    await Promise.all([
      writeJson(resolve(outDir, "adf-drift-report.json"), report),
      writeFile(resolve(outDir, "adf-drift-report.md"), renderUpstreamMarkdown(report), { encoding: "utf8", flag: "w" }),
    ]);
    console.log(renderUpstreamMarkdown(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "check-observed-cloud") {
    const outFlag = args.find((arg) => arg.startsWith("--out-dir="));
    const outDir = resolve(repositoryRoot, outFlag?.slice("--out-dir=".length) || "artifacts/adf-drift");
    const report = await checkObservedCloud();
    await mkdir(outDir, { recursive: true });
    await Promise.all([
      writeJson(resolve(outDir, "adf-observed-report.json"), report),
      writeFile(resolve(outDir, "adf-observed-report.md"), renderObservedMarkdown(report), { encoding: "utf8", flag: "w" }),
    ]);
    console.log(renderObservedMarkdown(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "update-candidate") {
    const outFlag = args.find((arg) => arg.startsWith("--out-dir="));
    const candidateDir = outFlag
      ? resolve(repositoryRoot, outFlag.slice("--out-dir=".length))
      : ADF_FIXTURE_DIR;
    const fixtures = JSON.parse(await readFile(ADF_FIXTURE_MANIFEST_PATH, "utf8")) as AdfFixtureManifest;
    const observation = await observeUpstream();
    const rawSchema = observation.packageSchema;
    const candidate = makeBaseline(rawSchema, fixtures, observation.packageMetadata, new Date().toISOString());
    candidate.resolvedVersionedUrl = observation.canonicalFinalUrl;
    candidate.referenceIndex = observation.referenceIndex;
    await mkdir(candidateDir, { recursive: true });
    await writeJson(resolve(candidateDir, "upstream-baseline.candidate.json"), candidate);
    await writeFile(resolve(candidateDir, "upstream-schema.candidate.json"), rawSchema, { encoding: "utf8", flag: "w" });
    console.log("Wrote candidate files only; review their diff before replacing the committed pin.");
    return;
  }
  throw new Error("Usage: bun scripts/adf-drift.ts <check-pinned|check-upstream|check-observed-cloud|update-candidate>");
}

if (import.meta.main) {
  await runCli();
}

export const PINNED_PACKAGE_CONTRACT = Object.freeze({
  name: PINNED_ADF_SCHEMA_PACKAGE,
  version: PINNED_ADF_SCHEMA_VERSION,
});
