#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CLI_TARGETS, canonicalJson, cliAssetName } from "../release-artifacts.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TAG_PATTERN = /^dev-[0-9]{8}\.[1-9][0-9]*\.[1-9][0-9]*-[0-9a-f]{8}$/;
const EXTENSION_MARKER_SUFFIX = ".atlcli-release-extraction-v1";

export interface ShadowAsset {
  filename: string;
  size: number;
  sha256: string;
}

export interface PlannedPublicationMutation {
  order: number;
  system: "github" | "homebrew-tap";
  operation: string;
  target: string;
  precondition: string;
}

export interface DevReleaseShadowPlan {
  schema: "atlcli.dev-release-shadow-plan/v1";
  mode: "shadow";
  sourceSha: string;
  tag: string;
  stableLatestBefore: string;
  stableLatestExpectedAfter: string;
  assets: ShadowAsset[];
  publishHomebrew: boolean;
  plannedPublicationMutations: PlannedPublicationMutation[];
  executedPublicationMutations: [];
}

function expectedAssetNames(tag: string): string[] {
  return [
    ...CLI_TARGETS.map(cliAssetName),
    `atlcli-extension-chrome-mv3-${tag}.zip`,
    "checksums.txt",
    "build-metadata.json",
    "security-attestation.json",
    "source-eligibility.json",
  ].sort();
}

export function collectShadowAssets(directory: string): ShadowAsset[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(EXTENSION_MARKER_SUFFIX))
    .map((entry) => {
      const path = join(directory, entry.name);
      return { filename: basename(path), size: statSync(path).size, sha256: digestFile(path) };
    });
}

export function createDevReleaseShadowPlan(input: {
  sourceSha: string;
  tag: string;
  stableLatestBefore: string;
  assets: ShadowAsset[];
  publishHomebrew: boolean;
}): DevReleaseShadowPlan {
  if (!SHA_PATTERN.test(input.sourceSha)) throw new Error("source SHA must be a lowercase full SHA");
  if (!TAG_PATTERN.test(input.tag) || !input.tag.endsWith(input.sourceSha.slice(0, 8))) {
    throw new Error("dev tag must be immutable and bound to the source SHA");
  }
  if (!input.stableLatestBefore) throw new Error("stable latest baseline is required");
  const assets = [...input.assets].sort((left, right) => left.filename.localeCompare(right.filename));
  const actualNames = assets.map(({ filename }) => filename);
  const expectedNames = expectedAssetNames(input.tag);
  if (new Set(actualNames).size !== actualNames.length || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    const actualSet = new Set(actualNames);
    const expectedSet = new Set(expectedNames);
    const missing = expectedNames.filter((name) => !actualSet.has(name));
    const extra = actualNames.filter((name) => !expectedSet.has(name));
    throw new Error(
      `shadow release asset contract mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    );
  }
  for (const asset of assets) {
    if (!asset.filename || !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error(`invalid shadow asset: ${asset.filename || "<empty>"}`);
    }
  }

  const mutations: PlannedPublicationMutation[] = [
    {
      order: 1,
      system: "github",
      operation: "create-tag",
      target: `refs/tags/${input.tag}`,
      precondition: "tag absent and exact source eligibility still green",
    },
    {
      order: 2,
      system: "github",
      operation: "create-exclusive-draft",
      target: input.tag,
      precondition: "stable latest equals frozen baseline",
    },
    ...assets.map((asset, index) => ({
      order: index + 3,
      system: "github" as const,
      operation: "upload-release-asset",
      target: `${input.tag}/${asset.filename}`,
      precondition: `server digest must equal sha256:${asset.sha256}`,
    })),
    {
      order: assets.length + 3,
      system: "github",
      operation: "publish-prerelease",
      target: input.tag,
      precondition: "all downloaded and native consumer gates successful; make_latest=false",
    },
  ];
  if (input.publishHomebrew) {
    const firstHomebrewOrder = assets.length + 4;
    mutations.push(
      {
        order: firstHomebrewOrder,
        system: "homebrew-tap",
        operation: "dispatch-update-dev-formula",
        target: "BjoernSchotte/homebrew-tap/.github/workflows/update-dev-formula.yml",
        precondition: "public immutable prerelease reverified and scoped App token available",
      },
      {
        order: firstHomebrewOrder + 1,
        system: "homebrew-tap",
        operation: "commit-formula-and-pointer",
        target: "Formula/atlcli-dev.rb,metadata/atlcli-dev.json",
        precondition: "four native Homebrew consumers green and stable formula digest unchanged",
      },
    );
  }

  return {
    schema: "atlcli.dev-release-shadow-plan/v1",
    mode: "shadow",
    sourceSha: input.sourceSha,
    tag: input.tag,
    stableLatestBefore: input.stableLatestBefore,
    stableLatestExpectedAfter: input.stableLatestBefore,
    assets,
    publishHomebrew: input.publishHomebrew,
    plannedPublicationMutations: mutations,
    executedPublicationMutations: [],
  };
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(args: string[], name: string): string {
  const value = argument(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const directory = resolve(required(args, "--dir"));
  const assets = collectShadowAssets(directory);
  const result = createDevReleaseShadowPlan({
    sourceSha: required(args, "--source-sha"),
    tag: required(args, "--tag"),
    stableLatestBefore: required(args, "--stable-latest-before"),
    assets,
    publishHomebrew: required(args, "--publish-homebrew") === "true",
  });
  writeFileSync(resolve(argument(args, "--out") ?? "dev-release-shadow-plan.json"), canonicalJson(result));
  console.log(`Shadow plan: ${result.plannedPublicationMutations.length} publication mutations planned, 0 executed`);
}
