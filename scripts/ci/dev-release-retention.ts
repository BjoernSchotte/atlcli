#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../release-artifacts.js";

export interface RetentionRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable?: boolean;
  created_at: string;
}

export interface RetentionPlan {
  schema: "atlcli.dev-release-retention/v1";
  generatedAt: string;
  dryRun: boolean;
  policy: { retainSuccessful: number; retainDays: number };
  protected: { stableLatest: string; homebrewDev: string };
  keep: { id: number; tag: string; reason: string }[];
  delete: { id: number; tag: string; reason: "expired-and-beyond-count" }[];
}

const DEV_TAG = /^dev-\d{8}\.\d+\.\d+-[0-9a-f]{8}$/;

export function planDevReleaseRetention(input: {
  releases: RetentionRelease[];
  now: string | Date;
  stableLatest: string;
  homebrewDevTag: string;
  retainSuccessful?: number;
  retainDays?: number;
}): RetentionPlan {
  const now = input.now instanceof Date ? input.now : new Date(input.now);
  if (Number.isNaN(now.getTime())) throw new Error("retention now must be a valid date");
  const retainSuccessful = input.retainSuccessful ?? 14;
  const retainDays = input.retainDays ?? 30;
  if (!Number.isSafeInteger(retainSuccessful) || retainSuccessful < 1) throw new Error("retainSuccessful must be positive");
  if (!Number.isSafeInteger(retainDays) || retainDays < 1) throw new Error("retainDays must be positive");
  if (!input.stableLatest.startsWith("v")) throw new Error("stable latest tag is invalid");
  if (!DEV_TAG.test(input.homebrewDevTag)) throw new Error("Homebrew dev tag is missing or invalid");

  const dev = input.releases
    .filter(({ tag_name }) => DEV_TAG.test(tag_name))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id);
  const protectedTags = new Set([input.stableLatest, input.homebrewDevTag]);
  const keep: RetentionPlan["keep"] = [];
  const remove: RetentionPlan["delete"] = [];
  const cutoff = now.getTime() - retainDays * 24 * 60 * 60 * 1_000;
  let successfulIndex = 0;
  for (const release of dev) {
    if (!Number.isSafeInteger(release.id) || release.id < 1) throw new Error(`invalid release id: ${release.tag_name}`);
    const created = Date.parse(release.created_at);
    if (Number.isNaN(created)) throw new Error(`invalid release date: ${release.tag_name}`);
    if (protectedTags.has(release.tag_name)) {
      keep.push({ id: release.id, tag: release.tag_name, reason: "protected-live-reference" });
      continue;
    }
    if (release.draft) {
      keep.push({ id: release.id, tag: release.tag_name, reason: "failed-draft-requires-operator-review" });
      continue;
    }
    if (!release.prerelease) {
      throw new Error(`dev tag is not a prerelease: ${release.tag_name}`);
    }
    if (release.immutable !== true) {
      keep.push({ id: release.id, tag: release.tag_name, reason: "mutable-release-requires-operator-review" });
      continue;
    }
    successfulIndex++;
    if (successfulIndex <= retainSuccessful) {
      keep.push({ id: release.id, tag: release.tag_name, reason: "within-success-count" });
    } else if (created >= cutoff) {
      keep.push({ id: release.id, tag: release.tag_name, reason: "within-retention-days" });
    } else {
      remove.push({ id: release.id, tag: release.tag_name, reason: "expired-and-beyond-count" });
    }
  }
  return {
    schema: "atlcli.dev-release-retention/v1",
    generatedAt: now.toISOString(),
    dryRun: true,
    policy: { retainSuccessful, retainDays },
    protected: { stableLatest: input.stableLatest, homebrewDev: input.homebrewDevTag },
    keep: keep.sort((left, right) => left.tag.localeCompare(right.tag)),
    delete: remove.sort((left, right) => left.tag.localeCompare(right.tag)),
  };
}

class CleanupApi {
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  private async mutate(path: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "atlcli-dev-release-retention",
      },
    });
    if (response.status !== 204) throw new Error(`GitHub cleanup API ${response.status} for ${path}`);
  }

  async deleteRelease(id: number): Promise<void> {
    await this.mutate(`/repos/${this.repository}/releases/${id}`);
  }

  async deleteTag(tag: string): Promise<void> {
    await this.mutate(`/repos/${this.repository}/git/refs/tags/${encodeURIComponent(tag)}`);
  }
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const inputPath = value(args, "--input");
  const outputPath = value(args, "--out") ?? "dev-release-retention.json";
  if (!inputPath) throw new Error("--input is required");
  const releases = JSON.parse(await Bun.file(resolve(inputPath)).text()) as RetentionRelease[];
  const plan = planDevReleaseRetention({
    releases,
    now: value(args, "--now") ?? new Date(),
    stableLatest: value(args, "--stable-latest") ?? "",
    homebrewDevTag: value(args, "--homebrew-dev-tag") ?? "",
    retainSuccessful: Number(value(args, "--retain-successful") ?? 14),
    retainDays: Number(value(args, "--retain-days") ?? 30),
  });
  if (args.includes("--apply")) {
    const expectedPlanPath = value(args, "--expected-plan");
    if (!expectedPlanPath) throw new Error("--apply requires --expected-plan");
    const expectedPlan = JSON.parse(await Bun.file(resolve(expectedPlanPath)).text()) as RetentionPlan;
    if (canonicalJson(expectedPlan) !== canonicalJson(plan)) {
      throw new Error("recomputed retention plan differs from the frozen reviewed plan");
    }
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const token = process.env.GITHUB_TOKEN ?? "";
    if (!repository.includes("/") || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required for --apply");
    const api = new CleanupApi(repository, token, process.env.GITHUB_API_URL);
    for (const release of plan.delete) {
      if (release.tag === plan.protected.homebrewDev || release.tag === plan.protected.stableLatest) {
        throw new Error(`refusing to delete protected release: ${release.tag}`);
      }
      await api.deleteRelease(release.id);
      await api.deleteTag(release.tag);
    }
    plan.dryRun = false;
  }
  writeFileSync(resolve(outputPath), canonicalJson(plan));
  process.stdout.write(canonicalJson(plan));
}
