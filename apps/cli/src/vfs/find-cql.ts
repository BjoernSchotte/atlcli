import type { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { posix } from "node:path";

const DAY = 86_400_000;
type Time = { kind: "-mtime" | "-newer" | "-newermt"; value: string };

/** Only page-file queries can use CQL without claiming to search virtual files. */
export function parseIndexedFind(args: string[]): { paths: string[]; times: Time[]; separator: string } | undefined {
  const paths: string[] = [];
  const times: Time[] = [];
  let files = false;
  let markdown = false;
  let predicates = false;
  let separator = "\n";
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!predicates && !arg.startsWith("-") && !["!", "("].includes(arg)) { paths.push(arg); continue; }
    predicates = true;
    if (arg === "-type" && args[++i] === "f") files = true;
    else if (arg === "-name" && args[++i] === "*.md") markdown = true;
    else if (arg === "-mtime" || arg === "-newer" || arg === "-newermt") {
      const value = args[++i];
      if (!value || (arg === "-mtime" && !/^[+-]?\d+$/.test(value))) return undefined;
      times.push({ kind: arg, value });
    } else if (arg === "-print" || arg === "-print0") {
      if (print) return undefined;
      print = true;
      separator = arg === "-print0" ? "\0" : "\n";
    }
    else return undefined;
  }
  return files && markdown && times.length && paths.length <= 100
    ? { paths: paths.length ? paths : ["."], times, separator } : undefined;
}

/** CQL dates have minute precision in the account timezone: widen, then verify. */
export function findTimeBounds(time: Time, now: number, reference?: number): {
  query: string; matches: (mtime: number) => boolean;
} {
  let lower: number | undefined;
  let upper: number | undefined;
  let matches: (mtime: number) => boolean;
  if (time.kind === "-mtime") {
    const days = Number(time.value.replace(/^[+-]/, ""));
    if (!Number.isSafeInteger(days)) throw new Error("invalid -mtime day count");
    if (time.value.startsWith("-")) {
      lower = now - days * DAY;
      matches = (mtime) => (now - mtime) / DAY < days;
    } else if (time.value.startsWith("+")) {
      upper = now - days * DAY;
      // Match the bundled just-bash find, whose +N uses the unrounded age.
      matches = (mtime) => (now - mtime) / DAY > days;
    } else {
      lower = now - (days + 1) * DAY;
      upper = now - days * DAY;
      matches = (mtime) => Math.floor((now - mtime) / DAY) === days;
    }
  } else {
    lower = time.kind === "-newer" ? reference : Date.parse(time.value);
    if (lower === undefined || !Number.isFinite(lower)) throw new Error(`invalid ${time.kind} reference`);
    const threshold = lower;
    matches = (mtime) => mtime > threshold;
  }
  const format = (value: number) => new Date(value).toISOString().slice(0, 16).replace("T", " ");
  // ponytail: one-day padding covers timezone offsets/precision; tighter bounds require the account timezone.
  const query = [lower === undefined ? undefined : `lastmodified >= "${format(lower - DAY)}"`,
    upper === undefined ? undefined : `lastmodified <= "${format(upper + DAY)}"`].filter(Boolean).join(" AND ");
  return { query, matches };
}

export async function runIndexedFind(args: string[], options: {
  vfs: ConfluenceVfsImpl; cwd: string; spaces: string[]; diagnostic: (line: string) => void; now?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
  const plan = parseIndexedFind(args);
  if (!plan) return undefined;
  const { vfs, cwd, spaces, diagnostic } = options;
  try {
    const scopes: string[] = [];
    for (const path of plan.paths) {
      const absolute = posix.resolve(cwd, path);
      const space = absolute.split("/")[1];
      if (!space || !spaces.includes(space)) return undefined;
      const stat = await vfs.stat(absolute);
      if (!stat.isDirectory || !["space", "page", "folder"].includes(stat.kind)) return undefined;
      const root = stat.kind === "space" ? await vfs.index.getHomepageId(space) : stat.id;
      if (!root || !/^\d+$/.test(root)) return undefined;
      scopes.push(`(id = ${root} OR ancestor = ${root})`);
    }
    const bounds = [];
    const now = options.now ?? Date.now();
    for (const time of plan.times) {
      const stat = time.kind === "-newer" ? await vfs.stat(posix.resolve(cwd, time.value)) : undefined;
      const modified = stat ? vfs.index.node(stat.id)?.lastModified : undefined;
      const reference = modified ? Date.parse(modified) : stat?.mtime.getTime();
      bounds.push(findTimeBounds(time, now, reference));
    }
    const found = await vfs.searchExcerpts(`(${bounds.map((bound) => bound.query).join(" AND ")}) AND (${scopes.join(" OR ")})`, { spaces, maxResults: 1000 });
    diagnostic(`find: CQL-indexed page files only; virtual files and attachments excluded; index delay may omit matches; ${found.results.length} candidates, 0 bodies`);
    if (found.truncated) return { stdout: "", stderr: "find: indexed candidates exceed the search limit; narrow the path or time range\n", exitCode: 2 };
    for (const row of found.results) {
      const node = vfs.index.node(row.id);
      if (!node?.lastModified || node.version === undefined) vfs.index.upsert({ id: row.id, title: row.title, type: "page", spaceKey: row.spaceKey, version: row.version ?? 0, metaCheckedAt: 0 });
    }
    await vfs.index.revalidatePages(found.results.map((row) => row.id));
    const paths: string[] = [];
    for (const row of found.results) {
      const mtime = Date.parse(vfs.index.node(row.id)?.lastModified ?? "");
      if (!Number.isFinite(mtime)) throw new Error("candidate has no modification timestamp");
      if (bounds.every((bound) => bound.matches(mtime))) paths.push(row.path);
    }
    return { stdout: paths.map((path) => path + plan.separator).join(""), stderr: "", exitCode: 0 };
  } catch (error) {
    // Do not silently turn unsupported -newermt into a successful partial result.
    if (plan.times.some((time) => time.kind === "-newermt")) return { stdout: "", stderr: `find: ${String(error)}\n`, exitCode: 2 };
    diagnostic("find: CQL unavailable; falling back to filesystem metadata");
    return undefined;
  }
}
