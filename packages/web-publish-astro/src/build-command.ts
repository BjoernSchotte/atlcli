import { spawn } from "node:child_process";
import { resolve } from "node:path";

export type AstroBuildCommandFailureKindV1 = "spawn" | "exit" | "timeout" | "aborted" | "output-limit";

export class AstroBuildCommandErrorV1 extends Error {
  constructor(
    public readonly kind: AstroBuildCommandFailureKindV1,
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "AstroBuildCommandErrorV1";
  }
}

export interface RunAstroBuildCommandOptionsV1 {
  /** Absolute, operator-owned Astro project directory. */
  projectDirectory: string;
  /** Executable plus literal arguments; never parsed by a shell. */
  command: readonly [string, ...string[]];
  /** Explicit, non-secret additions only. They replace no ambient variables. */
  environment?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface AstroBuildCommandResultV1 {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
}

function safeBaseEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of process.platform === "win32" ? ["PATH", "SystemRoot", "ComSpec", "TEMP", "TMP"] : ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function collect(buffer: Buffer[], bytes: number, chunk: Buffer, maximum: number): number {
  const next = bytes + chunk.byteLength;
  if (next > maximum) throw new RangeError("astro build command output exceeds the configured byte limit");
  buffer.push(chunk);
  return next;
}

/** Run an operator-selected Astro build command without a shell or ambient secrets. */
export async function runAstroBuildCommandV1(
  options: RunAstroBuildCommandOptionsV1,
): Promise<AstroBuildCommandResultV1> {
  if (!Array.isArray(options.command) || options.command.length === 0 || options.command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new TypeError("command must contain a non-empty executable and literal string arguments");
  }
  if (typeof options.projectDirectory !== "string" || options.projectDirectory.length === 0) {
    throw new TypeError("projectDirectory must be a non-empty path");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  assertPositive(timeoutMs, "timeoutMs");
  assertPositive(maxOutputBytes, "maxOutputBytes");
  if (options.signal?.aborted) throw new AstroBuildCommandErrorV1("aborted", "Astro build command was aborted before start", "", "");

  const [executable, ...arguments_] = options.command;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminalKind: AstroBuildCommandFailureKindV1 | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");
  const kill = (): void => { child?.kill("SIGTERM"); };

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => { terminalKind = "timeout"; kill(); }, timeoutMs);
    const abort = (): void => { terminalKind = "aborted"; kill(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const spawned = spawn(executable, arguments_, {
        cwd: resolve(options.projectDirectory),
        env: { ...safeBaseEnvironment(), ...options.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
      if (spawned.stdout === null || spawned.stderr === null) throw new Error("build command output pipes are unavailable");
      spawned.stdout.on("data", (chunk: Buffer) => {
        try { stdoutBytes = collect(stdout, stdoutBytes, chunk, maxOutputBytes); }
        catch { terminalKind = "output-limit"; kill(); }
      });
      spawned.stderr.on("data", (chunk: Buffer) => {
        try { stderrBytes = collect(stderr, stderrBytes, chunk, maxOutputBytes); }
        catch { terminalKind = "output-limit"; kill(); }
      });
      spawned.once("error", () => { terminalKind = "spawn"; });
      spawned.once("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        const capturedOut = text(stdout);
        const capturedErr = text(stderr);
        if (terminalKind !== undefined) {
          reject(new AstroBuildCommandErrorV1(terminalKind, `Astro build command ${terminalKind}`, capturedOut, capturedErr));
        } else if (code !== 0) {
          reject(new AstroBuildCommandErrorV1("exit", `Astro build command exited with ${code ?? "signal"}`, capturedOut, capturedErr));
        } else resolvePromise();
      });
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    }
  });
  return { stdout: text(stdout), stderr: text(stderr) };
}
