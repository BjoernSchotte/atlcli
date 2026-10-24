/**
 * The command log: every write the TUI makes, with the `atlcli` commands
 * that do the same, so what you did here can go into a script. `!` shows it.
 */
import type { Command, Ctx } from "./keymap.js";
import { pushOverlay, type LogEntry } from "./state.js";

/** An `atlcli` command line, without `atlcli` and `--profile`. */
export type Argv = string[];

/** One argument for `sh`/`zsh`: as is when safe, otherwise single-quoted. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(argv: Argv, profile: string): string {
  return ["atlcli", ...argv, "--profile", profile].map(shellQuote).join(" ");
}

/** JQL for exactly these issues, for `jira bulk …`. */
export const keysJql = (keys: string[]) => `key in (${keys.join(", ")})`;

const LOG_SIZE = 200;
let seq = 0;

const time = (d: Date) => d.toTimeString().slice(0, 8);

export function record(ctx: Ctx, ok: boolean, text: string, argvs: Argv[]): void {
  const entry: LogEntry = { id: ++seq, at: time(new Date()), ok, text, commands: argvs.map((a) => formatCommand(a, ctx.opts.profile)) };
  ctx.store.set((s) => ({ ...s, log: [...s.log.slice(-(LOG_SIZE - 1)), entry] }));
}

/**
 * Runs a write and logs it: its result text (a string result) on success,
 * the error on failure. Rethrows, so the caller's error handling stays.
 */
export async function logged<T>(ctx: Ctx, argvs: Argv[], work: () => Promise<T>): Promise<T> {
  try {
    const result = await work();
    record(ctx, true, typeof result === "string" ? result : "done", argvs);
    return result;
  } catch (err) {
    record(ctx, false, err instanceof Error ? err.message : String(err), argvs);
    throw err;
  }
}

export const logCommands: Command[] = [
  {
    id: "app.log",
    title: "Command log: what this session changed, as atlcli commands",
    keys: ["!"],
    run: (ctx) => ctx.store.set((s) => pushOverlay(s, { kind: "log", selected: 0 })),
  },
];
