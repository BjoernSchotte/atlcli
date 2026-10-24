/**
 * Commands and the keys that run them. One registry feeds the key handler,
 * the status bar, the help overlay and the command palette, so a command is
 * always reachable by name even when a terminal swallows its key.
 */
import type { TuiArea, TuiOptions } from "../index.js";
import type { AppState, Focus, Toast } from "./state.js";
import type { Store } from "./store.js";

export interface KeyLike {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const NAMED = new Set([
  "return", "escape", "tab", "space", "backspace", "delete", "up", "down", "left", "right",
  "pageup", "pagedown", "home", "end", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

/** A key as the keymap writes it: `j`, `G`, `?`, `ctrl+k`, `alt+x`, `shift+tab`, `return`. */
export function keyString(key: KeyLike): string {
  const prefix = `${key.ctrl ? "ctrl+" : ""}${key.meta ? "alt+" : ""}`;
  if (NAMED.has(key.name)) return `${prefix}${key.shift ? "shift+" : ""}${key.name}`;
  if (prefix) return `${prefix}${key.name}`;
  const printable = key.sequence && key.sequence.length === 1 && key.sequence >= " " ? key.sequence : undefined;
  return printable ?? (key.shift ? key.name.toUpperCase() : key.name);
}

/** What a command can use while it runs. */
export interface Ctx {
  store: Store<AppState>;
  opts: TuiOptions;
  toast(kind: Toast["kind"], text: string): void;
  /** Runs `work` with a busy indicator; an error becomes an error toast and `undefined`. */
  task<T>(label: string, work: () => Promise<T>): Promise<T | undefined>;
  /** Leaves fullscreen while `work` runs (`$EDITOR`). */
  suspend<T>(work: () => Promise<T>): Promise<T>;
  /** Copies to the clipboard (OSC 52); false when the terminal does not support it. */
  copy(text: string): boolean;
  quit(): void;
}

export interface Command {
  id: string;
  title: string;
  keys: string[];
  /** Area the command belongs to; none = everywhere. */
  area?: TuiArea;
  /** Panes the command works in; none = any pane of its area. */
  focus?: Focus[];
  /** Short label for the status bar; commands without one only show in help and the palette. */
  bar?: string;
  enabled?: (state: AppState) => boolean;
  run: (ctx: Ctx) => void | Promise<void>;
}

/**
 * Runs `work` now (not on a later tick: the next key of a batch must see its
 * effect); a thrown or rejected error becomes an error toast.
 */
export function runSafely(ctx: Ctx, work: () => unknown): void {
  const fail = (err: unknown) => ctx.toast("error", err instanceof Error ? err.message : String(err));
  try {
    const result = work();
    if (result instanceof Promise) result.catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** A command's keys after the user's `tui.keymap` overrides. */
export function keysFor(command: Command, keymap: Record<string, string[]> = {}): string[] {
  return keymap[command.id] ?? command.keys;
}

/** Whether the command applies to the current area, pane and state. */
export function applies(command: Command, state: AppState): boolean {
  if (command.area && command.area !== state.area) return false;
  if (command.focus && !command.focus.includes(state.focus)) return false;
  return command.enabled ? command.enabled(state) : true;
}

/** The command for a key: pane-specific beats area-wide beats global. */
export function resolveCommand(commands: Command[], state: AppState, key: string, keymap: Record<string, string[]> = {}): Command | undefined {
  const rank = (c: Command) => (c.focus ? 0 : c.area ? 1 : 2);
  return commands
    .filter((c) => keysFor(c, keymap).includes(key) && applies(c, state))
    .sort((a, b) => rank(a) - rank(b))[0];
}

/** Commands matching a palette query, applicable ones only. */
export function paletteCommands(commands: Command[], state: AppState, query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((c) => {
    if (!applies({ ...c, focus: undefined }, state)) return false;
    const text = `${c.title} ${c.id}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
