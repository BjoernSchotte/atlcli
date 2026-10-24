/**
 * The command log: every write the TUI makes, with the `atlcli` commands
 * that do the same, so what you did here can go into a script. `!` shows it.
 */
import type { Command, Ctx } from "./keymap.js";
import { pushOverlay, type LogEntry } from "./state.js";

/** An `atlcli` command line, without `atlcli` and `--profile`. */
export type Argv = string[];

/**
 * One argument for `sh`/`zsh`: as is when safe, otherwise single-quoted. A
 * leading `=` is quoted too: zsh expands `=word` to a command path.
 */
export function shellQuote(arg: string): string {
  return /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The flags the log's commands use without a value; every other `--flag` takes the next element. */
const SWITCHES = new Set(["confirm", "delete-filter", "favourite", "edit"]);

/**
 * The shell line for `argv`, or undefined when it cannot be written safely.
 * Values come from Jira and Confluence, and atlcli reads a value that starts
 * with `-` as a flag: a summary `--profile=prod` would switch the profile of
 * the pasted line. So flag values are joined (`--summary=…`, which atlcli
 * reads as the value whatever follows the `=`), and a positional value that
 * starts with `-` (a label, a comment) leaves the line out.
 */
export function formatCommand(argv: Argv, profile: string): string | undefined {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg.startsWith("--") && !arg.includes("=") ? arg.slice(2) : undefined;
    if (flag !== undefined && !SWITCHES.has(flag) && i + 1 < argv.length) out.push(`${arg}=${argv[++i]}`);
    else if (flag !== undefined || !arg.startsWith("-")) out.push(arg);
    else return undefined;
  }
  return ["atlcli", ...out, `--profile=${profile}`].map(shellQuote).join(" ");
}

/** JQL for exactly these issues, for `jira bulk …`. */
export const keysJql = (keys: string[]) => `key in (${keys.join(", ")})`;

const LOG_SIZE = 200;
let seq = 0;

const time = (d: Date) => d.toTimeString().slice(0, 8);

export function record(ctx: Ctx, ok: boolean, text: string, argvs: Argv[]): void {
  const lines = argvs.map((a) => formatCommand(a, ctx.opts.profile));
  const commands = lines.filter((l): l is string => l !== undefined);
  const note = commands.length < lines.length ? ' (no CLI command shown: a value starts with "-")' : "";
  const entry: LogEntry = { id: ++seq, at: time(new Date()), ok, text: `${text}${note}`, commands };
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
