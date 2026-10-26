/**
 * Output files written while a command runs: reports and exports from
 * `atlcli.output()` in scripts and from `audit … --output`. Text goes to a
 * temporary file next to the target and replaces the target only on commit,
 * so a failed run leaves no file and an existing one unchanged.
 */
import { createHash, type Hash } from "node:crypto";
import { closeSync, existsSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { initJinja, streamJinja } from "@atlcli/jinja";
import { createTemplateScope } from "@atlcli/core";
import type { OutputFileView, OutputRenderInput, ScriptPort, TemplateWarningView } from "@atlcli/script-runtime";

/** A file being written: a temporary sibling until `commit`. */
export class AtomicFile {
  readonly tmp: string;
  private fd: number | undefined;
  private readonly hash: Hash = createHash("sha256");
  bytes = 0;

  constructor(readonly target: string) {
    this.tmp = join(dirname(target), `.${basename(target)}.atlcli-tmp-${process.pid}`);
    this.fd = openSync(this.tmp, "w", 0o644);
    pending.add(this);
  }

  write(chunk: string): void {
    if (this.fd === undefined) throw new Error(`${this.target} is closed`);
    const data = Buffer.from(chunk, "utf8");
    writeSync(this.fd, data);
    this.hash.update(data);
    this.bytes += data.length;
  }

  /** Replaces the target with what was written. */
  commit(): { bytes: number; sha256: string } {
    if (this.fd === undefined) throw new Error(`${this.target} is closed`);
    closeSync(this.fd);
    this.fd = undefined;
    renameSync(this.tmp, this.target);
    pending.delete(this);
    return { bytes: this.bytes, sha256: this.hash.digest("hex") };
  }

  /** Drops what was written; the target stays as it was. */
  abort(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    try {
      unlinkSync(this.tmp);
    } catch {
      // already gone
    }
    pending.delete(this);
  }
}

/** Files not committed when the process ends (a failed run, `fail()`, Ctrl-C) are removed. */
const pending = new Set<AtomicFile>();
process.on("exit", () => {
  for (const file of [...pending]) file.abort();
});

/** Parses `--max-output` sizes: 512k, 300m, 2g or bytes. */
export function parseSize(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(text.trim());
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g"];
  return Math.floor(Number(m[1]) * unit);
}

export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MAX_OUTPUT_FILES = 50;

/**
 * The output files of one CLI run (all `--each` jobs share it): below
 * `root`, at most `maxBytes` and MAX_OUTPUT_FILES files, each path once.
 */
export class OutputFiles {
  private readonly open = new Map<string, { path: string; file: AtomicFile }>();
  private readonly paths = new Set<string>();
  readonly written: OutputFileView[] = [];
  private total = 0;
  private next = 0;

  constructor(
    readonly root: string,
    private readonly maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
    private readonly profile?: string,
  ) {}

  /** `path` passed checkLocalPath (relative, no ".."). */
  async openFile(path: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    if (this.paths.has(path)) throw new Error(`${path} is already written by this run`);
    if (this.paths.size >= MAX_OUTPUT_FILES) throw new Error(`A run writes at most ${MAX_OUTPUT_FILES} output files`);
    const target = resolve(this.root, path);
    await makeDirInside(this.root, dirname(target));
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new Error(`${path} is a symbolic link; not written`);
    if (existing?.isDirectory()) throw new Error(`${path} is a directory`);
    this.paths.add(path);
    const handle = `out${++this.next}`;
    this.open.set(handle, { path, file: new AtomicFile(target) });
    return handle;
  }

  write(handle: string, chunk: string): void {
    const { path, file } = this.entry(handle);
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (this.total + bytes > this.maxBytes) {
      this.abort();
      throw new Error(`Output files exceed ${formatSize(this.maxBytes)} (at ${path}); raise the limit with --max-output`);
    }
    this.total += bytes;
    file.write(chunk);
  }

  render(handle: string, template: string, o: OutputRenderInput): Promise<TemplateWarningView[]> {
    return renderInto((chunk) => this.write(handle, chunk), this.entry(handle).path, template, o, this.profile);
  }

  close(handle: string): OutputFileView {
    const { path, file } = this.entry(handle);
    this.open.delete(handle);
    const view = { path, ...file.commit() };
    this.written.push(view);
    return view;
  }

  /** Paths opened but not closed. */
  unclosed(): string[] {
    return [...this.open.values()].map((e) => e.path);
  }

  /** Drops every file not closed yet. */
  abort(): void {
    for (const { file } of this.open.values()) file.abort();
    this.open.clear();
  }

  /**
   * Port methods for one script run (one `--each` job): its files can be
   * checked for being closed, or dropped, without touching other runs'.
   */
  scope(): OutputScope {
    const mine = new Set<string>();
    return {
      port: {
        outputOpen: async (path) => {
          const handle = await this.openFile(path);
          mine.add(handle);
          return handle;
        },
        outputWrite: async (handle, chunk) => this.write(this.own(mine, handle), chunk),
        outputRender: (handle, template, options) => this.render(this.own(mine, handle), template, options),
        outputClose: async (handle) => this.close(this.own(mine, handle)),
      },
      unclosed: () => [...mine].filter((h) => this.open.has(h)).map((h) => this.open.get(h)!.path),
      abort: () => {
        for (const handle of mine) {
          this.open.get(handle)?.file.abort();
          this.open.delete(handle);
        }
      },
    };
  }

  private own(mine: Set<string>, handle: string): string {
    if (!mine.has(handle)) throw new Error("This output file belongs to another run");
    return handle;
  }

  private entry(handle: string): { path: string; file: AtomicFile } {
    const entry = this.open.get(handle);
    if (!entry) throw new Error("This output file is closed");
    return entry;
  }
}

/** Streams `template` (with the built-in variables) into `write`; strict mode throws a RenderError on warnings. */
export async function renderInto(write: (chunk: string) => void, unit: string, template: string, o: OutputRenderInput, profile?: string): Promise<TemplateWarningView[]> {
  await initJinja();
  const scope = createTemplateScope({ vars: o.vars, now: new Date(o.now), profile });
  const { warnings } = streamJinja(template, scope.vars, write, { lines: o.lines, templates: o.templates });
  if (o.strict && warnings.length) {
    const error = new Error(`${unit}: ${warnings.map((w) => w.message).join("; ")}`);
    error.name = "RenderError";
    throw error;
  }
  return warnings.map((w) => ({ code: w.code, message: w.message, unit, ...(w.line !== undefined ? { line: w.line, column: w.column ?? 0 } : {}) }));
}

/**
 * Output port methods writing into one destination the host chose (the audit
 * report's file or stdout): whatever path the script names, at most one open.
 */
export function singleOutputPort(write: (chunk: string) => void, name: string): OutputScope["port"] {
  let state: "closed" | "open" | "done" = "closed";
  let bytes = 0;
  const hash = createHash("sha256");
  const put = (chunk: string) => {
    if (state !== "open") throw new Error(`${name} is not open`);
    bytes += Buffer.byteLength(chunk, "utf8");
    hash.update(chunk, "utf8");
    write(chunk);
  };
  return {
    outputOpen: async () => {
      if (state !== "closed") throw new Error(`${name} can be opened once`);
      state = "open";
      return "out1";
    },
    outputWrite: async (_handle, chunk) => put(chunk),
    outputRender: (_handle, template, options) => renderInto(put, name, template, options),
    outputClose: async () => {
      if (state !== "open") throw new Error(`${name} is not open`);
      state = "done";
      return { path: name, bytes, sha256: hash.digest("hex") };
    },
  };
}

export interface OutputScope {
  port: Pick<ScriptPort, "outputOpen" | "outputWrite" | "outputRender" | "outputClose">;
  /** Files this run opened and did not close. */
  unclosed(): string[];
  /** Drops this run's files that are not closed. */
  abort(): void;
}

/** Creates `dir` (and parents) after checking that its deepest existing ancestor is inside `root`. */
async function makeDirInside(root: string, dir: string): Promise<void> {
  const base = await realpath(root);
  let existing = dir;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = await realpath(existing);
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`${relative(root, dir) || "."} leads outside the output directory`);
  await mkdir(dir, { recursive: true });
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${bytes} bytes`;
}
