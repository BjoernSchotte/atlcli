#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLI_TARGETS,
  canonicalJson,
  createReleaseIdentity,
  type ReleaseChannel,
} from "../release-artifacts.js";

interface NativeReleaseInfo {
  schema: string;
  version: string;
  channel: string;
  sourceSha: string;
  buildId: string;
  releaseTag: string | null;
  homebrewVersion: string | null;
}

export interface NativeCliReceipt {
  schema: "atlcli.native-cli-verification/v1";
  target: (typeof CLI_TARGETS)[number];
  runner: { platform: NodeJS.Platform; arch: string };
  releaseInfo: NativeReleaseInfo;
}

const RUNTIME_BY_TARGET: Record<(typeof CLI_TARGETS)[number], [NodeJS.Platform, string]> = {
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "x64"],
  "linux-arm64": ["linux", "arm64"],
  "linux-x64": ["linux", "x64"],
  "windows-x64": ["win32", "x64"],
};

function devTimestamp(tag: string): string {
  const match = /^dev-(\d{4})(\d{2})(\d{2})\.\d+\.\d+-[0-9a-f]{8}$/.exec(tag);
  if (!match) throw new Error(`invalid dev tag: ${tag}`);
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
}

export function verifyNativeCli(input: {
  releaseInfo: NativeReleaseInfo;
  channel: ReleaseChannel;
  rootVersion: string;
  tag: string;
  sourceSha: string;
  target: (typeof CLI_TARGETS)[number];
  platform: NodeJS.Platform;
  arch: string;
}): NativeCliReceipt {
  const expectedRuntime = RUNTIME_BY_TARGET[input.target];
  if (input.platform !== expectedRuntime[0] || input.arch !== expectedRuntime[1]) {
    throw new Error(
      `native target ${input.target} cannot be proven on ${input.platform}-${input.arch}`,
    );
  }
  const identity = input.channel === "dev"
    ? createReleaseIdentity({
        channel: "dev",
        rootVersion: input.rootVersion,
        sourceSha: input.sourceSha,
        sourceReachableFromMain: true,
        timestamp: devTimestamp(input.tag),
        runNumber: Number(input.tag.split(".")[1]),
        runAttempt: Number(input.tag.split(".")[2]?.split("-")[0]),
      })
    : null;
  if (identity && identity.releaseTag !== input.tag) {
    throw new Error("dev release tag does not match the requested source identity");
  }
  const expected = {
    schema: "atlcli.release-info/v1",
    version: identity?.cliVersion ?? input.rootVersion,
    channel: input.channel,
    sourceSha: input.sourceSha,
    buildId: identity?.buildId ?? input.tag,
    releaseTag: input.tag,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (input.releaseInfo[field as keyof typeof input.releaseInfo] !== value) {
      throw new Error(`native CLI release identity mismatch: ${field}`);
    }
  }
  if (
    input.channel === "stable"
      ? input.releaseInfo.homebrewVersion !== input.rootVersion
      : !/^\d{14}\.\d+\.\d+$/.test(input.releaseInfo.homebrewVersion ?? "")
  ) {
    throw new Error("native CLI Homebrew version is invalid for the release channel");
  }
  return {
    schema: "atlcli.native-cli-verification/v1",
    target: input.target,
    runner: { platform: input.platform, arch: input.arch },
    releaseInfo: input.releaseInfo,
  };
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
  const channelValue = required("--channel");
  if (channelValue !== "stable" && channelValue !== "dev") throw new Error("invalid channel");
  const targetValue = required("--target");
  if (!CLI_TARGETS.includes(targetValue as (typeof CLI_TARGETS)[number])) {
    throw new Error(`invalid target: ${targetValue}`);
  }
  const releaseInfo = JSON.parse(
    (await Bun.file(resolve(required("--input"))).text()).replace(/^\uFEFF/, ""),
  ) as NativeReleaseInfo;
  const receipt = verifyNativeCli({
    releaseInfo,
    channel: channelValue,
    rootVersion: required("--version"),
    tag: required("--tag"),
    sourceSha: required("--source-sha"),
    target: targetValue as (typeof CLI_TARGETS)[number],
    platform: process.platform,
    arch: process.arch,
  });
  const output = canonicalJson(receipt);
  writeFileSync(resolve(value(args, "--out") ?? "native-cli-verification.json"), output);
  process.stdout.write(output);
}
