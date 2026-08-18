#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export interface SanitizedTurboTask {
  taskId: string;
  task: string;
  package: string;
  hash?: string;
  cacheStatus: string;
  localCache: boolean;
  remoteCache: boolean;
  timeSavedMs: number;
  durationMs?: number;
  exitCode?: number;
}

export interface SanitizedTurboRun {
  id: string;
  turboVersion: string;
  tasks: SanitizedTurboTask[];
}

export interface SanitizedTurboTelemetry {
  schema: 1;
  source: string;
  runs: SanitizedTurboRun[];
}

export interface AggregatedTurboTelemetry {
  runs: number;
  tasks: number;
  cacheHits: number;
  cacheMisses: number;
  cacheSkipped: number;
  localHits: number;
  remoteHits: number;
  executionDurationMs: number;
  timeSavedMs: number;
  executions: Array<SanitizedTurboTask & { source: string; runId: string }>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function text(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function identifier(value: unknown, fallback = "unknown"): string {
  const candidate = text(value, fallback);
  return candidate.length <= 256 &&
      (candidate === "//" ||
        (!candidate.startsWith("/") && !candidate.includes("..") && /^[a-z0-9@_./:#-]+$/i.test(candidate)))
    ? candidate
    : fallback;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8,128}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function sanitizeTask(value: unknown): SanitizedTurboTask | undefined {
  const task = record(value);
  if (!task) return undefined;
  const cache = record(task.cache) ?? {};
  const execution = record(task.execution) ?? {};
  const startTime = finite(execution.startTime);
  const endTime = finite(execution.endTime);
  const durationMs = startTime !== undefined && endTime !== undefined && endTime >= startTime
    ? endTime - startTime
    : undefined;
  const exitCode = finite(execution.exitCode);
  const hash = safeHash(task.hash);

  return {
    taskId: identifier(task.taskId),
    task: identifier(task.task),
    package: identifier(task.package),
    ...(hash ? { hash } : {}),
    cacheStatus: text(cache.status, "UNKNOWN").toUpperCase(),
    localCache: cache.local === true,
    remoteCache: cache.remote === true,
    timeSavedMs: Math.max(0, finite(cache.timeSaved) ?? 0),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

export function sanitizeTurboRunDocuments(
  source: string,
  documents: readonly unknown[],
): SanitizedTurboTelemetry {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source)) {
    throw new Error("Turbo telemetry source must be a short identifier");
  }

  const runs = documents.flatMap((value): SanitizedTurboRun[] => {
    const run = record(value);
    if (!run || !Array.isArray(run.tasks)) return [];
    return [{
      id: identifier(run.id),
      turboVersion: identifier(run.turboVersion),
      tasks: run.tasks
        .map(sanitizeTask)
        .filter((task): task is SanitizedTurboTask => task !== undefined)
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    }];
  });

  return {
    schema: 1,
    source,
    runs: [...new Map(runs.map((run) => [run.id, run])).values()]
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function aggregateTurboTelemetry(
  artifacts: readonly SanitizedTurboTelemetry[],
): AggregatedTurboTelemetry {
  const executions = artifacts.flatMap((artifact) => artifact.runs.flatMap((run) =>
    run.tasks.map((task) => ({ ...task, source: artifact.source, runId: run.id }))
  )).sort((left, right) =>
    left.source.localeCompare(right.source) ||
    left.runId.localeCompare(right.runId) ||
    left.taskId.localeCompare(right.taskId)
  );
  const hits = executions.filter((task) => task.cacheStatus === "HIT");
  const misses = executions.filter((task) => task.cacheStatus === "MISS");

  return {
    runs: artifacts.reduce((total, artifact) => total + artifact.runs.length, 0),
    tasks: executions.length,
    cacheHits: hits.length,
    cacheMisses: misses.length,
    cacheSkipped: executions.length - hits.length - misses.length,
    localHits: hits.filter((task) => task.localCache).length,
    remoteHits: hits.filter((task) => task.remoteCache).length,
    executionDurationMs: executions.reduce((total, task) => total + (task.durationMs ?? 0), 0),
    timeSavedMs: executions.reduce((total, task) => total + task.timeSavedMs, 0),
    executions,
  };
}

function filesRecursively(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesRecursively(path));
    else if (entry.isFile() && extname(path) === ".json") result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

export function readSanitizedTurboArtifacts(directory: string): SanitizedTurboTelemetry[] {
  return filesRecursively(directory).flatMap((path): SanitizedTurboTelemetry[] => {
    const value = parseSanitizedTurboTelemetry(JSON.parse(readFileSync(path, "utf8")));
    return value ? [value] : [];
  });
}

export function parseSanitizedTurboTelemetry(value: unknown): SanitizedTurboTelemetry | undefined {
  const artifact = record(value);
  if (artifact?.schema !== 1 || typeof artifact.source !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(artifact.source) || !Array.isArray(artifact.runs)) {
    return undefined;
  }

  return {
    schema: 1,
    source: artifact.source,
    runs: artifact.runs.flatMap((value): SanitizedTurboRun[] => {
      const run = record(value);
      if (!run || !Array.isArray(run.tasks)) return [];
      return [{
        id: identifier(run.id),
        turboVersion: identifier(run.turboVersion),
        tasks: run.tasks.flatMap((value): SanitizedTurboTask[] => {
          const task = record(value);
          if (!task) return [];
          const hash = safeHash(task.hash);
          const durationMs = finite(task.durationMs);
          const exitCode = finite(task.exitCode);
          return [{
            taskId: identifier(task.taskId),
            task: identifier(task.task),
            package: identifier(task.package),
            ...(hash ? { hash } : {}),
            cacheStatus: identifier(task.cacheStatus, "UNKNOWN").toUpperCase(),
            localCache: task.localCache === true,
            remoteCache: task.remoteCache === true,
            timeSavedMs: Math.max(0, finite(task.timeSavedMs) ?? 0),
            ...(durationMs === undefined ? {} : { durationMs: Math.max(0, durationMs) }),
            ...(exitCode === undefined ? {} : { exitCode }),
          }];
        }),
      }];
    }),
  };
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runsDirectory = option(args, "--runs");
  const outPath = option(args, "--out");
  const source = option(args, "--source");
  const documents = filesRecursively(runsDirectory).map((path) =>
    JSON.parse(readFileSync(path, "utf8")) as unknown
  );
  const summary = sanitizeTurboRunDocuments(source, documents);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.main) await main();
