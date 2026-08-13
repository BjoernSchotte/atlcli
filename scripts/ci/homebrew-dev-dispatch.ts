#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { canonicalJson } from "../release-artifacts.js";

const TAP_REPOSITORY = "BjoernSchotte/homebrew-tap";
const TAP_WORKFLOW = "update-dev-formula.yml";

interface WorkflowRun {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  display_title: string;
  html_url: string;
}

interface WorkflowArtifact {
  id: number;
  name: string;
  expired: boolean;
  archive_download_url: string;
}

interface HomebrewPointer {
  schema: "atlcli.homebrew-dev-pointer/v1";
  sourceRepository: string;
  tag: string;
  sourceSha: string;
  formulaVersion: string;
  upstreamHomebrewVersion: string;
  metadataSha256: string;
  checksumsSha256: string;
  requestId: string;
  releaseUrl: string;
  releasePublishedAt: string;
  rollbackFromTag: string | null;
  archives: Record<string, string>;
}

interface PublicationReceipt {
  schema: "atlcli.homebrew-dev-publication/v1";
  commit: string;
  formulaSha256: string;
  pointer: HomebrewPointer;
}

export interface HomebrewDispatchReceipt {
  schema: "atlcli.homebrew-dev-dispatch/v1";
  requestId: string;
  workflow: { id: number; attempt: number; url: string; conclusion: "success" };
  tapCommit: string;
  formulaSha256: string;
  pointer: HomebrewPointer;
}

export interface TapApi {
  dispatch(inputs: Record<string, string>): Promise<void>;
  runs(): Promise<WorkflowRun[]>;
  artifacts(runId: number): Promise<WorkflowArtifact[]>;
  downloadArtifact(artifact: WorkflowArtifact): Promise<Uint8Array>;
  content(path: string, ref: string): Promise<string>;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateRequest(input: {
  tag: string;
  sourceSha: string;
  requestId: string;
  metadataSha256: string;
  checksumsSha256: string;
  rollbackFromTag?: string;
}): void {
  if (!/^dev-\d{8}\.\d+\.\d+-[0-9a-f]{8}$/.test(input.tag)) throw new Error("invalid dev tag");
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha)) throw new Error("invalid source SHA");
  if (input.tag.slice(-8) !== input.sourceSha.slice(0, 8)) throw new Error("tag/source SHA mismatch");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.requestId)) throw new Error("invalid request ID");
  if (!/^[0-9a-f]{64}$/.test(input.metadataSha256)) throw new Error("invalid metadata SHA-256");
  if (!/^[0-9a-f]{64}$/.test(input.checksumsSha256)) throw new Error("invalid checksums SHA-256");
  if (input.rollbackFromTag && !/^dev-\d{8}\.\d+\.\d+-[0-9a-f]{8}$/.test(input.rollbackFromTag)) {
    throw new Error("invalid rollback fence tag");
  }
}

function assertPublishedContent(input: {
  receipt: PublicationReceipt;
  pointerText: string;
  formula: string;
  tag: string;
  sourceSha: string;
  requestId: string;
  metadataSha256: string;
  checksumsSha256: string;
  rollbackFromTag?: string;
}): void {
  const { receipt } = input;
  if (receipt.schema !== "atlcli.homebrew-dev-publication/v1") throw new Error("tap receipt schema mismatch");
  if (!/^[0-9a-f]{40}$/.test(receipt.commit)) throw new Error("tap receipt commit is invalid");
  const pointer = JSON.parse(input.pointerText) as HomebrewPointer;
  if (canonicalJson(pointer) !== canonicalJson(receipt.pointer)) throw new Error("tap pointer differs from publication receipt");
  if (
    pointer.schema !== "atlcli.homebrew-dev-pointer/v1" ||
    pointer.sourceRepository !== "BjoernSchotte/atlcli" ||
    pointer.tag !== input.tag ||
    pointer.sourceSha !== input.sourceSha ||
    pointer.requestId !== input.requestId ||
    pointer.metadataSha256 !== input.metadataSha256 ||
    pointer.checksumsSha256 !== input.checksumsSha256 ||
    pointer.rollbackFromTag !== (input.rollbackFromTag || null)
  ) {
    throw new Error("published Homebrew pointer does not match the dispatched release");
  }
  if (sha256(input.formula) !== receipt.formulaSha256) throw new Error("published formula digest mismatch");
  for (const [name, digest] of Object.entries(pointer.archives)) {
    const url = `https://github.com/BjoernSchotte/atlcli/releases/download/${pointer.tag}/${name}`;
    if (!input.formula.includes(url) || !input.formula.includes(`sha256 "${digest}"`)) {
      throw new Error(`published formula is not bound to ${name}`);
    }
  }
  for (const contract of ["class AtlcliDev < Formula", 'conflicts_with "atlcli"', `version "${pointer.formulaVersion}"`]) {
    if (!input.formula.includes(contract)) throw new Error(`published formula contract missing: ${contract}`);
  }
}

export async function dispatchAndVerifyHomebrewDev(input: {
  api: TapApi;
  tag: string;
  sourceSha: string;
  requestId: string;
  metadataSha256: string;
  checksumsSha256: string;
  rollbackFromTag?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<HomebrewDispatchReceipt> {
  validateRequest(input);
  const title = `atlcli-dev ${input.requestId}`;
  if ((await input.api.runs()).some(({ display_title }) => display_title === title)) {
    throw new Error("Homebrew request ID has already been used");
  }
  await input.api.dispatch({
    source_repository: "BjoernSchotte/atlcli",
    dev_tag: input.tag,
    source_sha: input.sourceSha,
    request_id: input.requestId,
    metadata_sha256: input.metadataSha256,
    checksums_sha256: input.checksumsSha256,
    rollback_from_tag: input.rollbackFromTag ?? "",
  });
  const sleep = input.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const timeoutMs = input.timeoutMs ?? 60 * 60 * 1_000;
  const deadline = Date.now() + timeoutMs;
  let run: WorkflowRun | undefined;
  do {
    const matches = (await input.api.runs()).filter(({ display_title }) => display_title === title);
    if (matches.length > 1) throw new Error("ambiguous Homebrew workflow correlation");
    run = matches[0];
    if (run?.status === "completed") break;
    if (Date.now() >= deadline) throw new Error("Homebrew workflow timed out");
    await sleep(input.pollIntervalMs ?? 15_000);
  } while (true);
  if (run.conclusion !== "success") throw new Error(`Homebrew workflow failed: ${run.conclusion ?? "unknown"}`);

  const expectedArtifact = `atlcli-dev-publication-${input.requestId}-${run.id}-${run.run_attempt}`;
  const matches = (await input.api.artifacts(run.id)).filter(({ name, expired }) => name === expectedArtifact && !expired);
  if (matches.length !== 1) throw new Error("Homebrew publication receipt artifact is missing or ambiguous");
  const archive = await JSZip.loadAsync(await input.api.downloadArtifact(matches[0]!), { checkCRC32: true });
  const receiptFile = archive.file("homebrew-dev-publication.json");
  if (!receiptFile) throw new Error("Homebrew publication receipt file is missing");
  const receipt = JSON.parse(await receiptFile.async("text")) as PublicationReceipt;
  const [pointerText, formula] = await Promise.all([
    input.api.content("metadata/atlcli-dev.json", receipt.commit),
    input.api.content("Formula/atlcli-dev.rb", receipt.commit),
  ]);
  assertPublishedContent({ receipt, pointerText, formula, ...input });
  return {
    schema: "atlcli.homebrew-dev-dispatch/v1",
    requestId: input.requestId,
    workflow: { id: run.id, attempt: run.run_attempt, url: run.html_url, conclusion: "success" },
    tapCommit: receipt.commit,
    formulaSha256: receipt.formulaSha256,
    pointer: receipt.pointer,
  };
}

export class GitHubTapApi implements TapApi {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  private headers(accept = "application/vnd.github+json") {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "atlcli-homebrew-dev-dispatch",
    };
  }

  private async response<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(`${this.apiUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`GitHub tap API ${response.status} for ${init.method ?? "GET"} ${path}`);
    return await response.json() as T;
  }

  async dispatch(inputs: Record<string, string>): Promise<void> {
    const path = `/repos/${TAP_REPOSITORY}/actions/workflows/${TAP_WORKFLOW}/dispatches`;
    const response = await this.request(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ref: "main", inputs }),
    });
    if (response.status !== 204) throw new Error(`GitHub tap API ${response.status} for workflow dispatch`);
  }

  async runs(): Promise<WorkflowRun[]> {
    const result = await this.response<{ workflow_runs: WorkflowRun[] }>(
      `/repos/${TAP_REPOSITORY}/actions/workflows/${TAP_WORKFLOW}/runs?event=workflow_dispatch&per_page=50`,
    );
    return result.workflow_runs;
  }

  async artifacts(runId: number): Promise<WorkflowArtifact[]> {
    const result = await this.response<{ artifacts: WorkflowArtifact[] }>(
      `/repos/${TAP_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    return result.artifacts;
  }

  async downloadArtifact(artifact: WorkflowArtifact): Promise<Uint8Array> {
    const response = await this.request(artifact.archive_download_url, {
      headers: this.headers(),
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`GitHub tap artifact download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async content(path: string, ref: string): Promise<string> {
    const result = await this.response<{ encoding: string; content: string }>(
      `/repos/${TAP_REPOSITORY}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    );
    if (result.encoding !== "base64") throw new Error(`unexpected GitHub content encoding for ${path}`);
    return Buffer.from(result.content.replaceAll("\n", ""), "base64").toString("utf8");
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
  const token = process.env.HOMEBREW_TAP_TOKEN ?? "";
  if (!token) throw new Error("HOMEBREW_TAP_TOKEN is required");
  const receipt = await dispatchAndVerifyHomebrewDev({
    api: new GitHubTapApi(token, fetch, process.env.GITHUB_API_URL),
    tag: required("--tag"),
    sourceSha: required("--source-sha"),
    requestId: required("--request-id"),
    metadataSha256: required("--metadata-sha256"),
    checksumsSha256: required("--checksums-sha256"),
    rollbackFromTag: value(args, "--rollback-from-tag") || undefined,
  });
  const output = canonicalJson(receipt);
  writeFileSync(resolve(value(args, "--out") ?? "homebrew-dev-dispatch.json"), output);
  process.stdout.write(output);
}
