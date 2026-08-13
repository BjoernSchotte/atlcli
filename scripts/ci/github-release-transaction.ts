#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  canonicalJson,
  createReleaseIdentity,
  expectedReleaseAssetNames,
  expectedStableReleaseAssetNames,
  type ReleaseChannel,
} from "../release-artifacts.js";

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  state: string;
  url: string;
  browser_download_url: string;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  html_url: string;
  upload_url: string;
  assets: ReleaseAsset[];
}

interface GitReference {
  ref: string;
  object: { type: string; sha: string; url: string };
}

interface GitTag {
  object: { type: string; sha: string; url: string };
}

export interface ReleaseTransactionReceipt {
  schema: "atlcli.github-release-transaction/v1";
  operation:
    | "create-draft"
    | "download-draft"
    | "download-native-asset"
    | "publish-draft"
    | "rollback-draft"
    | "verify-published";
  releaseId: number;
  releaseUrl: string;
  channel: ReleaseChannel;
  tag: string;
  sourceSha: string;
  draft: boolean;
  prerelease: boolean;
  makeLatest: boolean;
  immutable: boolean;
  assets: { name: string; size: number; sha256: string }[];
  stableLatestBefore: string | null;
  stableLatestAfter: string | null;
  run: { id: number | null; attempt: number | null };
}

export interface ReleaseApi {
  reference(tag: string): Promise<GitReference | null>;
  referenceCommit(reference: GitReference): Promise<string>;
  createReference(tag: string, sourceSha: string): Promise<GitReference>;
  createDraft(input: {
    tag: string;
    sourceSha: string;
    title: string;
    body: string;
    prerelease: boolean;
  }): Promise<GitHubRelease>;
  deleteDraft(releaseId: number): Promise<void>;
  deleteReference(tag: string): Promise<void>;
  uploadAsset(uploadUrl: string, name: string, bytes: Uint8Array): Promise<ReleaseAsset>;
  release(releaseId: number): Promise<GitHubRelease>;
  publish(releaseId: number, prerelease: boolean, makeLatest: boolean): Promise<GitHubRelease>;
  latestStable(): Promise<GitHubRelease | null>;
  downloadAsset(asset: ReleaseAsset): Promise<Uint8Array>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentType(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  return "application/octet-stream";
}

function exactNames(actual: string[], expected: string[]): void {
  const sorted = [...actual].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    throw new Error(`release asset contract mismatch; expected=${expected}; actual=${sorted}`);
  }
}

export class GitHubReleaseApi implements ReleaseApi {
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly apiUrl = "https://api.github.com",
    private readonly request: typeof fetch = fetch,
  ) {}

  private headers(accept = "application/vnd.github+json"): Record<string, string> {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "atlcli-release-transaction",
    };
  }

  private async response<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(`${this.apiUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${init.method ?? "GET"} ${path}`);
    return await response.json() as T;
  }

  private async delete(path: string): Promise<void> {
    const response = await this.request(`${this.apiUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for DELETE ${path}`);
  }

  async reference(tag: string): Promise<GitReference | null> {
    const path = `/repos/${this.repository}/git/ref/tags/${encodeURIComponent(tag)}`;
    const response = await this.request(`${this.apiUrl}${path}`, { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${response.status} for GET ${path}`);
    return await response.json() as GitReference;
  }

  async createReference(tag: string, sourceSha: string): Promise<GitReference> {
    return this.response(`/repos/${this.repository}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: sourceSha }),
    });
  }

  async referenceCommit(reference: GitReference): Promise<string> {
    let object = reference.object;
    for (let depth = 0; depth < 8; depth++) {
      if (object.type === "commit") return object.sha;
      if (object.type !== "tag") throw new Error(`unsupported tag target type: ${object.type}`);
      const tag = await this.response<GitTag>(`/repos/${this.repository}/git/tags/${object.sha}`);
      object = tag.object;
    }
    throw new Error("annotated tag chain exceeds the safety limit");
  }

  async createDraft(input: {
    tag: string;
    sourceSha: string;
    title: string;
    body: string;
    prerelease: boolean;
  }): Promise<GitHubRelease> {
    return this.response(`/repos/${this.repository}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: input.tag,
        target_commitish: input.sourceSha,
        name: input.title,
        body: input.body,
        draft: true,
        prerelease: input.prerelease,
        make_latest: "false",
      }),
    });
  }

  async uploadAsset(uploadUrl: string, name: string, bytes: Uint8Array): Promise<ReleaseAsset> {
    const endpoint = uploadUrl.replace("{?name,label}", "");
    const body = Uint8Array.from(bytes).buffer;
    const response = await this.request(`${endpoint}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": contentType(name) },
      body,
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 500);
      throw new Error(`GitHub upload API ${response.status} for ${name}${detail ? `: ${detail}` : ""}`);
    }
    return await response.json() as ReleaseAsset;
  }

  async deleteDraft(releaseId: number): Promise<void> {
    await this.delete(`/repos/${this.repository}/releases/${releaseId}`);
  }

  async deleteReference(tag: string): Promise<void> {
    await this.delete(`/repos/${this.repository}/git/refs/tags/${encodeURIComponent(tag)}`);
  }

  async release(releaseId: number): Promise<GitHubRelease> {
    return this.response(`/repos/${this.repository}/releases/${releaseId}`);
  }

  async publish(releaseId: number, prerelease: boolean, makeLatest: boolean): Promise<GitHubRelease> {
    return this.response(`/repos/${this.repository}/releases/${releaseId}`, {
      method: "PATCH",
      body: JSON.stringify({ draft: false, prerelease, make_latest: makeLatest ? "true" : "false" }),
    });
  }

  async latestStable(): Promise<GitHubRelease | null> {
    const path = `/repos/${this.repository}/releases/latest`;
    const response = await this.request(`${this.apiUrl}${path}`, { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${response.status} for GET ${path}`);
    return await response.json() as GitHubRelease;
  }

  async downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
    const response = await this.request(asset.url, {
      headers: this.headers("application/octet-stream"),
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`GitHub asset API ${response.status} for ${asset.name}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function expectedNames(channel: ReleaseChannel, version: string, tag: string, sourceSha: string): string[] {
  if (channel === "stable") return expectedStableReleaseAssetNames(version);
  const identity = createReleaseIdentity({
    channel,
    rootVersion: version,
    sourceSha,
    sourceReachableFromMain: true,
    timestamp: tag.slice(4, 12).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3T00:00:00Z"),
    runNumber: Number(tag.split(".")[1]),
    runAttempt: Number(tag.split(".")[2]?.split("-")[0]),
  });
  if (identity.releaseTag !== tag) throw new Error("dev tag does not match derived source identity");
  return expectedReleaseAssetNames(identity);
}

function localAssets(directory: string, expected: string[]): { name: string; bytes: Uint8Array }[] {
  const root = resolve(directory);
  const names = readdirSync(root).filter((name) => statSync(join(root, name)).isFile()).sort();
  exactNames(names, expected);
  return names.map((name) => ({ name, bytes: readFileSync(join(root, name)) }));
}

function assetReceipt(assets: { name: string; size: number; digest?: string | null; bytes?: Uint8Array }[]) {
  return assets.map((asset) => {
    const digest = asset.digest?.replace(/^sha256:/, "") ?? (asset.bytes ? sha256(asset.bytes) : "");
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`missing sha256 digest for ${asset.name}`);
    return { name: asset.name, size: asset.size, sha256: digest };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function actionsRun(): ReleaseTransactionReceipt["run"] {
  const read = (name: string): number | null => {
    const raw = process.env[name];
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
    return parsed;
  };
  return { id: read("GITHUB_RUN_ID"), attempt: read("GITHUB_RUN_ATTEMPT") };
}

function assertRelease(input: {
  release: GitHubRelease;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  expectedNames: string[];
}): void {
  const { release } = input;
  if (
    release.tag_name !== input.tag ||
    release.draft !== input.draft ||
    release.prerelease !== input.prerelease
  ) {
    throw new Error("release state does not match the requested transaction");
  }
  exactNames(release.assets.map(({ name }) => name), input.expectedNames);
  for (const asset of release.assets) {
    if (asset.state !== "uploaded" || asset.size < 1 || !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "")) {
      throw new Error(`release asset is incomplete or lacks a server digest: ${asset.name}`);
    }
  }
}

export async function createDraftRelease(input: {
  api: ReleaseApi;
  channel: ReleaseChannel;
  version: string;
  tag: string;
  sourceSha: string;
  directory: string;
  title: string;
  body: string;
  stableLatestBefore: string | null;
}): Promise<ReleaseTransactionReceipt> {
  const expected = expectedNames(input.channel, input.version, input.tag, input.sourceSha);
  const assets = localAssets(input.directory, expected);
  const existingRef = await input.api.reference(input.tag);
  const createdReference = !existingRef;
  if (createdReference) {
    await input.api.createReference(input.tag, input.sourceSha);
  } else if (input.channel === "dev") {
    throw new Error(`immutable dev tag already exists: ${input.tag}`);
  } else if (await input.api.referenceCommit(existingRef) !== input.sourceSha) {
    throw new Error("stable release tag does not point at the exact source SHA");
  }
  let draft: GitHubRelease | null = null;
  try {
    draft = await input.api.createDraft({
      tag: input.tag,
      sourceSha: input.sourceSha,
      title: input.title,
      body: input.body,
      prerelease: input.channel === "dev",
    });
    if (!draft.draft || draft.tag_name !== input.tag || draft.assets.length !== 0) {
      throw new Error("new release was not an empty exclusive draft");
    }
    for (const asset of assets) {
      const uploaded = await input.api.uploadAsset(draft.upload_url, asset.name, asset.bytes);
      const digest = uploaded.digest?.replace(/^sha256:/, "");
      if (uploaded.name !== asset.name || uploaded.size !== asset.bytes.byteLength || digest !== sha256(asset.bytes)) {
        throw new Error(`server upload digest mismatch: ${asset.name}`);
      }
    }
  } catch (error) {
    try {
      const reference = await input.api.reference(input.tag);
      if (!createdReference || !reference || await input.api.referenceCommit(reference) !== input.sourceSha) {
        throw new Error("rollback refused because the release tag is not owned by this transaction");
      }
      if (draft) {
        const current = await input.api.release(draft.id);
        if (!current.draft || current.tag_name !== input.tag || current.id !== draft.id) {
          throw new Error("rollback refused because the release draft is no longer exclusively owned");
        }
        await input.api.deleteDraft(draft.id);
      }
      await input.api.deleteReference(input.tag);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "release creation failed and safe rollback did not complete");
    }
    throw error;
  }
  if (!draft) throw new Error("release draft was not created");
  const complete = await input.api.release(draft.id);
  assertRelease({
    release: complete,
    tag: input.tag,
    draft: true,
    prerelease: input.channel === "dev",
    expectedNames: expected,
  });
  const latest = (await input.api.latestStable())?.tag_name ?? null;
  if (latest !== input.stableLatestBefore) {
    throw new Error("stable latest changed while creating release draft");
  }
  return {
    schema: "atlcli.github-release-transaction/v1",
    operation: "create-draft",
    releaseId: complete.id,
    releaseUrl: complete.html_url,
    channel: input.channel,
    tag: input.tag,
    sourceSha: input.sourceSha,
    draft: true,
    prerelease: input.channel === "dev",
    makeLatest: false,
    immutable: complete.immutable,
    assets: assetReceipt(complete.assets),
    stableLatestBefore: input.stableLatestBefore,
    stableLatestAfter: latest,
    run: actionsRun(),
  };
}

export async function downloadAndVerifyRelease(input: {
  api: ReleaseApi;
  channel: ReleaseChannel;
  version: string;
  tag: string;
  sourceSha: string;
  releaseId: number;
  directory: string;
  expectDraft: boolean;
  stableLatestBefore: string | null;
  operation: "download-draft" | "verify-published";
}): Promise<ReleaseTransactionReceipt> {
  const expected = expectedNames(input.channel, input.version, input.tag, input.sourceSha);
  const release = await input.api.release(input.releaseId);
  assertRelease({
    release,
    tag: input.tag,
    draft: input.expectDraft,
    prerelease: input.channel === "dev",
    expectedNames: expected,
  });
  if (input.operation === "verify-published" && input.channel === "dev" && release.immutable !== true) {
    throw new Error("published dev release is not immutable");
  }
  const ref = await input.api.reference(input.tag);
  if (!ref || await input.api.referenceCommit(ref) !== input.sourceSha) {
    throw new Error("release tag is not bound to the exact source SHA");
  }
  const latest = (await input.api.latestStable())?.tag_name ?? null;
  const expectedLatest = input.channel === "stable" && !input.expectDraft
    ? input.tag
    : input.stableLatestBefore;
  if (latest !== expectedLatest) {
    throw new Error("stable latest does not match the release transaction state");
  }
  const directory = resolve(input.directory);
  mkdirSync(directory, { recursive: true });
  const downloaded = [];
  for (const asset of release.assets) {
    const bytes = await input.api.downloadAsset(asset);
    const digest = asset.digest!.replace(/^sha256:/, "");
    if (bytes.byteLength !== asset.size || sha256(bytes) !== digest) {
      throw new Error(`downloaded release asset digest mismatch: ${asset.name}`);
    }
    writeFileSync(join(directory, asset.name), bytes);
    downloaded.push({ name: asset.name, size: bytes.byteLength, bytes });
  }
  return {
    schema: "atlcli.github-release-transaction/v1",
    operation: input.operation,
    releaseId: release.id,
    releaseUrl: release.html_url,
    channel: input.channel,
    tag: input.tag,
    sourceSha: input.sourceSha,
    draft: release.draft,
    prerelease: release.prerelease,
    makeLatest: input.channel === "stable" && !release.draft,
    immutable: release.immutable,
    assets: assetReceipt(downloaded),
    stableLatestBefore: input.stableLatestBefore,
    stableLatestAfter: latest,
    run: actionsRun(),
  };
}

export async function downloadNativeReleaseAsset(input: {
  api: ReleaseApi;
  channel: ReleaseChannel;
  version: string;
  tag: string;
  sourceSha: string;
  releaseId: number;
  assetName: string;
  directory: string;
  stableLatestBefore: string | null;
}): Promise<ReleaseTransactionReceipt> {
  const expected = expectedNames(input.channel, input.version, input.tag, input.sourceSha);
  if (!expected.includes(input.assetName) || !/^atlcli-(?:linux|darwin|windows)-/.test(input.assetName)) {
    throw new Error(`requested native asset is outside the CLI contract: ${input.assetName}`);
  }
  const release = await input.api.release(input.releaseId);
  assertRelease({
    release,
    tag: input.tag,
    draft: true,
    prerelease: input.channel === "dev",
    expectedNames: expected,
  });
  const ref = await input.api.reference(input.tag);
  if (!ref || await input.api.referenceCommit(ref) !== input.sourceSha) {
    throw new Error("release tag is not bound to the exact source SHA");
  }
  const latest = (await input.api.latestStable())?.tag_name ?? null;
  if (latest !== input.stableLatestBefore) {
    throw new Error("stable latest changed before native CLI verification");
  }
  const asset = release.assets.find(({ name }) => name === input.assetName)!;
  const bytes = await input.api.downloadAsset(asset);
  const digest = asset.digest!.replace(/^sha256:/, "");
  if (bytes.byteLength !== asset.size || sha256(bytes) !== digest) {
    throw new Error(`downloaded release asset digest mismatch: ${asset.name}`);
  }
  const directory = resolve(input.directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, asset.name), bytes);
  return {
    schema: "atlcli.github-release-transaction/v1",
    operation: "download-native-asset",
    releaseId: release.id,
    releaseUrl: release.html_url,
    channel: input.channel,
    tag: input.tag,
    sourceSha: input.sourceSha,
    draft: true,
    prerelease: input.channel === "dev",
    makeLatest: false,
    immutable: release.immutable,
    assets: assetReceipt([{ name: asset.name, size: bytes.byteLength, bytes }]),
    stableLatestBefore: input.stableLatestBefore,
    stableLatestAfter: latest,
    run: actionsRun(),
  };
}

export async function publishDraftRelease(input: {
  api: ReleaseApi;
  channel: ReleaseChannel;
  version: string;
  tag: string;
  sourceSha: string;
  releaseId: number;
  stableLatestBefore: string | null;
  immutablePollIntervalMs?: number;
  immutableTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ReleaseTransactionReceipt> {
  const ref = await input.api.reference(input.tag);
  if (!ref || await input.api.referenceCommit(ref) !== input.sourceSha) {
    throw new Error("release tag is not bound to the exact source SHA before publish");
  }
  const before = await input.api.release(input.releaseId);
  assertRelease({
    release: before,
    tag: input.tag,
    draft: true,
    prerelease: input.channel === "dev",
    expectedNames: expectedNames(input.channel, input.version, input.tag, input.sourceSha),
  });
  let published = await input.api.publish(
    input.releaseId,
    input.channel === "dev",
    input.channel === "stable",
  );
  assertRelease({
    release: published,
    tag: input.tag,
    draft: false,
    prerelease: input.channel === "dev",
    expectedNames: expectedNames(input.channel, input.version, input.tag, input.sourceSha),
  });
  if (input.channel === "dev" && published.immutable !== true) {
    const sleep = input.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
    const deadline = Date.now() + (input.immutableTimeoutMs ?? 2 * 60 * 1_000);
    do {
      if (Date.now() >= deadline) throw new Error("published dev release did not become immutable before timeout");
      await sleep(input.immutablePollIntervalMs ?? 5_000);
      published = await input.api.release(input.releaseId);
      assertRelease({
        release: published,
        tag: input.tag,
        draft: false,
        prerelease: true,
        expectedNames: expectedNames(input.channel, input.version, input.tag, input.sourceSha),
      });
    } while (published.immutable !== true);
  }
  const latest = (await input.api.latestStable())?.tag_name ?? null;
  if (input.channel === "dev" && latest !== input.stableLatestBefore) {
    throw new Error("stable latest changed while publishing dev prerelease");
  }
  if (input.channel === "stable" && latest !== input.tag) {
    throw new Error("published stable release did not become latest");
  }
  return {
    schema: "atlcli.github-release-transaction/v1",
    operation: "publish-draft",
    releaseId: published.id,
    releaseUrl: published.html_url,
    channel: input.channel,
    tag: input.tag,
    sourceSha: input.sourceSha,
    draft: false,
    prerelease: input.channel === "dev",
    makeLatest: input.channel === "stable",
    immutable: published.immutable,
    assets: assetReceipt(published.assets),
    stableLatestBefore: input.stableLatestBefore,
    stableLatestAfter: latest,
    run: actionsRun(),
  };
}

export async function rollbackDraftRelease(input: {
  api: ReleaseApi;
  channel: ReleaseChannel;
  version: string;
  tag: string;
  sourceSha: string;
  releaseId: number;
  stableLatestBefore: string | null;
}): Promise<ReleaseTransactionReceipt> {
  const reference = await input.api.reference(input.tag);
  if (!reference || await input.api.referenceCommit(reference) !== input.sourceSha) {
    throw new Error("rollback refused because the release tag is not owned by this transaction");
  }
  const draft = await input.api.release(input.releaseId);
  assertRelease({
    release: draft,
    tag: input.tag,
    draft: true,
    prerelease: input.channel === "dev",
    expectedNames: expectedNames(input.channel, input.version, input.tag, input.sourceSha),
  });
  const latestBefore = (await input.api.latestStable())?.tag_name ?? null;
  if (latestBefore !== input.stableLatestBefore) {
    throw new Error("stable latest changed before draft rollback");
  }
  await input.api.deleteDraft(input.releaseId);
  await input.api.deleteReference(input.tag);
  if (await input.api.reference(input.tag)) {
    throw new Error("release tag still exists after draft rollback");
  }
  const latestAfter = (await input.api.latestStable())?.tag_name ?? null;
  if (latestAfter !== input.stableLatestBefore) {
    throw new Error("stable latest changed during draft rollback");
  }
  return {
    schema: "atlcli.github-release-transaction/v1",
    operation: "rollback-draft",
    releaseId: draft.id,
    releaseUrl: draft.html_url,
    channel: input.channel,
    tag: input.tag,
    sourceSha: input.sourceSha,
    draft: true,
    prerelease: input.channel === "dev",
    makeLatest: false,
    immutable: false,
    assets: assetReceipt(draft.assets),
    stableLatestBefore: input.stableLatestBefore,
    stableLatestAfter: latestAfter,
    run: actionsRun(),
  };
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const required = (name: string): string => {
    const result = value(args, name);
    if (!result) throw new Error(`missing ${name}`);
    return result;
  };
  const channelValue = required("--channel");
  if (channelValue !== "stable" && channelValue !== "dev") throw new Error("invalid channel");
  const channel: ReleaseChannel = channelValue;
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!repository.includes("/") || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const api = new GitHubReleaseApi(repository, token, process.env.GITHUB_API_URL);
  const common = {
    api,
    channel,
    version: required("--version"),
    tag: required("--tag"),
    sourceSha: required("--source-sha"),
    stableLatestBefore: value(args, "--stable-latest-before") || null,
  };
  let result: ReleaseTransactionReceipt;
  if (command === "create-draft") {
    result = await createDraftRelease({
      ...common,
      directory: required("--dir"),
      title: required("--title"),
      body: value(args, "--body-file") ? readFileSync(resolve(required("--body-file")), "utf8") : "",
    });
  } else if (command === "download-draft" || command === "verify-published") {
    result = await downloadAndVerifyRelease({
      ...common,
      releaseId: Number(required("--release-id")),
      directory: required("--dir"),
      expectDraft: command === "download-draft",
      operation: command,
    });
  } else if (command === "download-native-asset") {
    result = await downloadNativeReleaseAsset({
      ...common,
      releaseId: Number(required("--release-id")),
      assetName: required("--asset"),
      directory: required("--dir"),
    });
  } else if (command === "publish-draft") {
    result = await publishDraftRelease({
      ...common,
      releaseId: Number(required("--release-id")),
    });
  } else if (command === "rollback-draft") {
    result = await rollbackDraftRelease({
      ...common,
      releaseId: Number(required("--release-id")),
    });
  } else {
    throw new Error(
      "command must be create-draft, download-draft, download-native-asset, publish-draft, rollback-draft, or verify-published",
    );
  }
  const output = canonicalJson(result);
  writeFileSync(resolve(value(args, "--out") ?? `${command}-receipt.json`), output);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${result.releaseId}\nrelease_url=${result.releaseUrl}\n`);
  }
  process.stdout.write(output);
}
