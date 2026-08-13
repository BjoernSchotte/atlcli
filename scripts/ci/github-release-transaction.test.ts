import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReleaseIdentity,
  expectedReleaseAssetNames,
  expectedStableReleaseAssetNames,
} from "../release-artifacts";
import {
  createDraftRelease,
  downloadAndVerifyRelease,
  downloadNativeReleaseAsset,
  publishDraftRelease,
  type ReleaseApi,
} from "./github-release-transaction";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const STABLE = "v0.17.2";
const created: string[] = [];

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function identity() {
  return createReleaseIdentity({
    channel: "dev",
    rootVersion: "0.17.2",
    sourceSha: SHA,
    sourceReachableFromMain: true,
    timestamp: "2026-08-12T02:17:45Z",
    runNumber: 418,
    runAttempt: 2,
  });
}

function assetDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "atlcli-release-transaction-"));
  created.push(directory);
  for (const name of expectedReleaseAssetNames(identity())) {
    writeFileSync(join(directory, name), `fixture ${name}\n`);
  }
  return directory;
}

function stableAssetDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "atlcli-stable-transaction-"));
  created.push(directory);
  for (const name of expectedStableReleaseAssetNames("0.17.2")) {
    writeFileSync(join(directory, name), `fixture ${name}\n`);
  }
  return directory;
}

class FakeApi implements ReleaseApi {
  tag: { ref: string; object: { type: string; sha: string; url: string } } | null = null;
  draft = {
    id: 77,
    tag_name: identity().releaseTag,
    target_commitish: SHA,
    draft: true,
    prerelease: true,
    immutable: false,
    html_url: `https://github.com/BjoernSchotte/atlcli/releases/tag/${identity().releaseTag}`,
    upload_url: "https://uploads.github.test/releases/77/assets{?name,label}",
    assets: [] as any[],
  };
  latest = STABLE;
  publishCalls = 0;
  corruptUpload = false;
  corruptDownload = false;

  async reference() { return this.tag; }
  async referenceCommit(reference: NonNullable<FakeApi["tag"]>) { return reference.object.sha; }
  async createReference(tag: string, sourceSha: string) {
    this.tag = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: sourceSha, url: "api" } };
    return this.tag;
  }
  async createDraft() { return structuredClone(this.draft); }
  async uploadAsset(_uploadUrl: string, name: string, bytes: Uint8Array) {
    const stored = new Uint8Array(bytes);
    const asset = {
      id: this.draft.assets.length + 1,
      name,
      size: stored.byteLength,
      digest: this.corruptUpload ? `sha256:${"f".repeat(64)}` : digest(stored),
      state: "uploaded",
      url: `https://api.github.test/assets/${this.draft.assets.length + 1}`,
      browser_download_url: `https://github.test/${name}`,
      bytes: stored,
    };
    this.draft.assets.push(asset);
    return structuredClone(asset);
  }
  async release() { return structuredClone(this.draft); }
  async publish(_releaseId: number, _prerelease: boolean, makeLatest: boolean) {
    this.publishCalls++;
    this.draft.draft = false;
    this.draft.immutable = true;
    if (makeLatest) this.latest = this.draft.tag_name;
    return structuredClone(this.draft);
  }
  async latestStable() {
    return this.latest === null ? null : { ...structuredClone(this.draft), tag_name: this.latest, draft: false, prerelease: false };
  }
  async downloadAsset(asset: any) {
    const bytes = new Uint8Array(asset.bytes);
    if (this.corruptDownload) bytes[0] ^= 1;
    return bytes;
  }
}

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("exclusive GitHub release transaction", () => {
  test("creates a new dev tag and complete draft with exact server digests", async () => {
    const api = new FakeApi();
    const requested = identity();
    const result = await createDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "fixture",
      stableLatestBefore: STABLE,
    });
    expect(api.tag?.object.sha).toBe(SHA);
    expect(result).toMatchObject({
      operation: "create-draft",
      draft: true,
      prerelease: true,
      makeLatest: false,
      stableLatestBefore: STABLE,
      stableLatestAfter: STABLE,
    });
    expect(result.assets).toHaveLength(10);
  });

  test("never targets an existing dev tag or tolerates an upload digest mismatch", async () => {
    const requested = identity();
    const existing = new FakeApi();
    await existing.createReference(requested.releaseTag, SHA);
    await expect(createDraftRelease({
      api: existing,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    })).rejects.toThrow("already exists");

    const corrupt = new FakeApi();
    corrupt.corruptUpload = true;
    await expect(createDraftRelease({
      api: corrupt,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    })).rejects.toThrow("upload digest mismatch");
  });

  test("downloads every draft asset again and blocks byte or stable-latest drift", async () => {
    const api = new FakeApi();
    const requested = identity();
    await createDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    });
    const download = mkdtempSync(join(tmpdir(), "atlcli-release-download-"));
    created.push(download);
    const result = await downloadAndVerifyRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      directory: download,
      expectDraft: true,
      stableLatestBefore: STABLE,
      operation: "download-draft",
    });
    expect(result.assets).toHaveLength(10);
    expect(readFileSync(join(download, "build-metadata.json"), "utf8")).toContain("fixture");

    api.corruptDownload = true;
    await expect(downloadAndVerifyRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      directory: download,
      expectDraft: true,
      stableLatestBefore: STABLE,
      operation: "download-draft",
    })).rejects.toThrow("digest mismatch");
    api.corruptDownload = false;
    api.latest = "v0.17.3";
    await expect(downloadAndVerifyRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      directory: download,
      expectDraft: true,
      stableLatestBefore: STABLE,
      operation: "download-draft",
    })).rejects.toThrow("stable latest does not match");
  });

  test("publishes only the already complete draft and never edits a published release", async () => {
    const api = new FakeApi();
    const requested = identity();
    await createDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    });
    const result = await publishDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      stableLatestBefore: STABLE,
    });
    expect(result).toMatchObject({ draft: false, prerelease: true, makeLatest: false });
    expect(api.publishCalls).toBe(1);
    await expect(publishDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      stableLatestBefore: STABLE,
    })).rejects.toThrow("state");
    expect(api.publishCalls).toBe(1);
  });

  test("waits for GitHub to enforce dev release immutability and fails closed on timeout", async () => {
    const requested = identity();
    const delayed = new FakeApi();
    await createDraftRelease({
      api: delayed,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    });
    let polls = 0;
    delayed.publish = async function(_releaseId: number, _prerelease: boolean, _makeLatest: boolean) {
      this.publishCalls++;
      this.draft.draft = false;
      this.draft.immutable = false;
      return structuredClone(this.draft);
    };
    delayed.release = async function() {
      polls++;
      if (this.publishCalls > 0 && polls >= 2) this.draft.immutable = true;
      return structuredClone(this.draft);
    };
    const result = await publishDraftRelease({
      api: delayed,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      stableLatestBefore: STABLE,
      immutablePollIntervalMs: 0,
      immutableTimeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result.immutable).toBe(true);

    const never = new FakeApi();
    await createDraftRelease({
      api: never,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    });
    never.publish = delayed.publish;
    never.release = async function() { return structuredClone(this.draft); };
    await expect(publishDraftRelease({
      api: never,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      stableLatestBefore: STABLE,
      immutablePollIntervalMs: 0,
      immutableTimeoutMs: 0,
      sleep: async () => {},
    })).rejects.toThrow("did not become immutable");
  });

  test("downloads one native archive only after rechecking the complete draft", async () => {
    const api = new FakeApi();
    const requested = identity();
    await createDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    });
    const download = mkdtempSync(join(tmpdir(), "atlcli-native-download-"));
    created.push(download);
    const receipt = await downloadNativeReleaseAsset({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      assetName: "atlcli-linux-x64.tar.gz",
      directory: download,
      stableLatestBefore: STABLE,
    });
    expect(receipt.operation).toBe("download-native-asset");
    expect(receipt.assets.map(({ name }) => name)).toEqual(["atlcli-linux-x64.tar.gz"]);
    expect(readFileSync(join(download, "atlcli-linux-x64.tar.gz"), "utf8")).toContain("fixture");

    await expect(downloadNativeReleaseAsset({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      assetName: "build-metadata.json",
      directory: download,
      stableLatestBefore: STABLE,
    })).rejects.toThrow("outside the CLI contract");
  });

  test("blocks publication when the tag moves after draft verification", async () => {
    const api = new FakeApi();
    const requested = identity();
    await createDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      directory: assetDirectory(),
      title: requested.releaseTag,
      body: "",
      stableLatestBefore: STABLE,
    });
    api.tag!.object.sha = "f".repeat(40);
    await expect(publishDraftRelease({
      api,
      channel: "dev",
      version: "0.17.2",
      tag: requested.releaseTag,
      sourceSha: SHA,
      releaseId: 77,
      stableLatestBefore: STABLE,
    })).rejects.toThrow("exact source SHA before publish");
    expect(api.publishCalls).toBe(0);
  });

  test("creates a missing stable tag exclusively and makes only stable latest on publish", async () => {
    const api = new FakeApi();
    api.draft.tag_name = "v0.17.2";
    api.draft.target_commitish = SHA;
    api.draft.prerelease = false;
    api.latest = "v0.17.1";
    await createDraftRelease({
      api,
      channel: "stable",
      version: "0.17.2",
      tag: "v0.17.2",
      sourceSha: SHA,
      directory: stableAssetDirectory(),
      title: "v0.17.2",
      body: "",
      stableLatestBefore: "v0.17.1",
    });
    const result = await publishDraftRelease({
      api,
      channel: "stable",
      version: "0.17.2",
      tag: "v0.17.2",
      sourceSha: SHA,
      releaseId: 77,
      stableLatestBefore: "v0.17.1",
    });
    expect(result).toMatchObject({
      draft: false,
      prerelease: false,
      makeLatest: true,
      stableLatestAfter: "v0.17.2",
    });

    const download = mkdtempSync(join(tmpdir(), "atlcli-stable-download-"));
    created.push(download);
    const verified = await downloadAndVerifyRelease({
      api,
      channel: "stable",
      version: "0.17.2",
      tag: "v0.17.2",
      sourceSha: SHA,
      releaseId: 77,
      directory: download,
      expectDraft: false,
      stableLatestBefore: "v0.17.1",
      operation: "verify-published",
    });
    expect(verified.stableLatestAfter).toBe("v0.17.2");
  });

  test("accepts an existing annotated stable tag only when it resolves to the source commit", async () => {
    const api = new FakeApi();
    api.draft.tag_name = "v0.17.2";
    api.draft.target_commitish = SHA;
    api.draft.prerelease = false;
    api.latest = "v0.17.1";
    api.tag = {
      ref: "refs/tags/v0.17.2",
      object: { type: "tag", sha: SHA, url: "api" },
    };
    const result = await createDraftRelease({
      api,
      channel: "stable",
      version: "0.17.2",
      tag: "v0.17.2",
      sourceSha: SHA,
      directory: stableAssetDirectory(),
      title: "v0.17.2",
      body: "",
      stableLatestBefore: "v0.17.1",
    });
    expect(result.tag).toBe("v0.17.2");
  });
});
