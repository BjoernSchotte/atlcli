#!/usr/bin/env bun

import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLI_TARGETS,
  canonicalJson,
  cliAssetName,
  createReleaseIdentity,
  decidePublication,
  type ExistingDevRelease,
  type PublicationDecision,
  type ReleaseIdentity,
} from "../release-artifacts.js";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

interface ExistingMetadata {
  channel?: string;
  sourceSha?: string;
  buildId?: string;
  releaseTag?: string;
}

export interface DevPublicationResolution {
  schema: "atlcli.dev-publication-decision/v1";
  sourceSha: string;
  requestedTag: string;
  forceRebuild: boolean;
  decision: PublicationDecision["decision"];
  selectedTag: string;
  reason: string | null;
  inspectedDevReleases: number;
}

function expectedNames(buildId: string): string[] {
  return [
    ...CLI_TARGETS.map(cliAssetName),
    `atlcli-extension-chrome-mv3-${buildId}.zip`,
    "checksums.txt",
    "build-metadata.json",
    "security-attestation.json",
    "source-eligibility.json",
  ].sort();
}

function exactSet(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export async function resolveDevPublication(input: {
  requested: ReleaseIdentity;
  forceRebuild: boolean;
  releases: GitHubRelease[];
  loadMetadata: (asset: GitHubAsset) => Promise<ExistingMetadata>;
}): Promise<DevPublicationResolution> {
  const devReleases = input.releases.filter(({ tag_name }) => tag_name.startsWith("dev-"));
  const existing: ExistingDevRelease[] = [];
  for (const release of devReleases) {
    const metadataAsset = release.assets.find(({ name }) => name === "build-metadata.json");
    let metadata: ExistingMetadata | null = null;
    if (metadataAsset) {
      try {
        metadata = await input.loadMetadata(metadataAsset);
      } catch {
        metadata = null;
      }
    }
    const validIdentity =
      metadata?.channel === "dev" &&
      metadata.buildId === release.tag_name &&
      metadata.releaseTag === release.tag_name &&
      typeof metadata.sourceSha === "string" &&
      /^[0-9a-f]{40}$/.test(metadata.sourceSha);
    if (validIdentity) {
      existing.push({
        tag: release.tag_name,
        sourceSha: metadata!.sourceSha!,
        complete:
          !release.draft &&
          release.prerelease &&
          exactSet(release.assets.map(({ name }) => name), expectedNames(release.tag_name)),
      });
    } else if (
      release.tag_name === input.requested.releaseTag ||
      release.tag_name.endsWith(`-${input.requested.shortSha}`)
    ) {
      existing.push({ tag: release.tag_name, sourceSha: "unknown", complete: false });
    }
  }
  const uncertainCollision = existing.find(({ sourceSha }) => sourceSha === "unknown");
  if (uncertainCollision) {
    return {
      schema: "atlcli.dev-publication-decision/v1",
      sourceSha: input.requested.sourceSha,
      requestedTag: input.requested.releaseTag,
      forceRebuild: input.forceRebuild,
      decision: "hard-conflict",
      selectedTag: uncertainCollision.tag,
      reason: "same-short-SHA release metadata is unreadable or inconsistent",
      inspectedDevReleases: devReleases.length,
    };
  }
  const decision = decidePublication({
    requested: input.requested,
    existing,
    forceRebuild: input.forceRebuild,
  });
  return {
    schema: "atlcli.dev-publication-decision/v1",
    sourceSha: input.requested.sourceSha,
    requestedTag: input.requested.releaseTag,
    forceRebuild: input.forceRebuild,
    decision: decision.decision,
    selectedTag: decision.tag,
    reason: "reason" in decision ? decision.reason : null,
    inspectedDevReleases: devReleases.length,
  };
}

class GitHubReleaseClient {
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "atlcli-dev-release-decision",
    };
  }

  async listReleases(): Promise<GitHubRelease[]> {
    const response = await fetch(`${this.apiUrl}/repos/${this.repository}/releases?per_page=100`, {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`GitHub releases API returned ${response.status}`);
    const releases = await response.json() as GitHubRelease[];
    if (releases.length === 100) throw new Error("release inventory reached bounded page size");
    return releases;
  }

  async loadMetadata(asset: GitHubAsset): Promise<ExistingMetadata> {
    const response = await fetch(asset.browser_download_url, { headers: this.headers(), redirect: "follow" });
    if (!response.ok) throw new Error(`metadata asset returned ${response.status}`);
    return await response.json() as ExistingMetadata;
  }
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const required = (name: string): string => {
    const result = value(args, name);
    if (!result) throw new Error(`missing ${name}`);
    return result;
  };
  const channel = "dev" as const;
  const requested = createReleaseIdentity({
    channel,
    rootVersion: required("--version"),
    sourceSha: required("--source-sha"),
    sourceReachableFromMain: true,
    timestamp: required("--created-at"),
    runNumber: Number(required("--run-number")),
    runAttempt: Number(required("--run-attempt")),
  });
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  }
  const client = new GitHubReleaseClient(repository, token, process.env.GITHUB_API_URL);
  const result = await resolveDevPublication({
    requested,
    forceRebuild: required("--force-rebuild") === "true",
    releases: await client.listReleases(),
    loadMetadata: (asset) => client.loadMetadata(asset),
  });
  const outputPath = resolve(value(args, "--out") ?? "dev-publication-decision.json");
  writeFileSync(outputPath, canonicalJson(result));
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `decision=${result.decision}\nselected_tag=${result.selectedTag}\n`);
  }
  process.stdout.write(`${result.decision}: ${result.selectedTag}${result.reason ? ` (${result.reason})` : ""}\n`);
  if (result.decision === "hard-conflict") process.exit(1);
}
