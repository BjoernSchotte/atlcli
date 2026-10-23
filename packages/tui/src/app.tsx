/**
 * `runTui`: the renderer, the command context and the shell layout. The
 * keyboard goes through one handler: the top overlay first, then the
 * command registry for the focused pane.
 */
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import type { TuiOptions } from "../index.js";
import { coreCommands, MIN_PANE, type AreaModule } from "./commands.js";
import { jira } from "./jira.js";
import { JiraDetail, JiraRow } from "./jira-view.js";
import { keyString, resolveCommand, type Command, type Ctx, type KeyLike } from "./keymap.js";
import { overlayKey } from "./overlays.js";
import { initialState, topOverlay, type AppState, type WikiPageRow } from "./state.js";
import { createStore, type Store } from "./store.js";
import { syntaxStyleFor, THEMES } from "./theme.js";
import { EnvProvider, Header, ListPane, NavPane, Overlays, runCommand, StatusBar, useApp, useEnv, type Env, type RowProps } from "./views.js";
import type { JiraIssue } from "@atlcli/jira";
import { wiki } from "./wiki.js";
import { WikiDetail, WikiRow } from "./wiki-view.js";

export const AREAS: Record<AppState["area"], AreaModule> = { jira, wiki };

export function allCommands(areas: Record<AppState["area"], AreaModule> = AREAS): Command[] {
  return [...areas.jira.commands, ...areas.wiki.commands, ...coreCommands(areas)];
}

let toastSeq = 0;

/** The command context over a store; `renderer` is absent in tests. */
export function createCtx(store: Store<AppState>, opts: TuiOptions, renderer: CliRenderer | undefined, quit: () => void): Ctx {
  const ctx: Ctx = {
    store,
    opts,
    toast(kind, text) {
      const id = ++toastSeq;
      store.set((s) => ({ ...s, toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
      const timer = setTimeout(() => store.set((s) => (s.toasts.some((t) => t.id === id) ? { ...s, toasts: s.toasts.filter((t) => t.id !== id) } : s)), kind === "error" ? 10_000 : 5_000);
      // A pending toast must not keep the process alive after quitting.
      timer.unref?.();
    },
    async task(label, work) {
      store.set((s) => ({ ...s, busy: label }));
      try {
        return await work();
      } catch (err) {
        ctx.toast("error", err instanceof Error ? err.message : String(err));
        return undefined;
      } finally {
        store.set((s) => (s.busy === label ? { ...s, busy: undefined } : s));
      }
    },
    async suspend(work) {
      if (!renderer) return work();
      await renderer.suspend();
      try {
        return await work();
      } finally {
        await renderer.resume();
      }
    },
    copy: (text) => renderer?.copyToClipboardOSC52(text) ?? false,
    quit,
  };
  return ctx;
}

/** Hands a key to the top overlay or the command for the focused pane. */
export function handleKey(env: Pick<Env, "ctx" | "commands" | "keymap">, event: KeyLike): void {
  const key = keyString(event);
  const { ctx, commands, keymap } = env;
  if (key === "ctrl+c") return ctx.quit();
  if (topOverlay(ctx.store.get())) {
    overlayKey(ctx, key, commands);
    return;
  }
  const command = resolveCommand(commands, ctx.store.get(), key, keymap);
  if (command) runCommand(ctx, command);
}

// Each area's rows and detail; the list pane is generic over the item type.
type AreaView = { idOf: (item: never) => string; Row: (p: RowProps<never>) => ReactNode; Detail: () => ReactNode };

const ROWS: Record<AppState["area"], AreaView> = {
  jira: { idOf: (i: JiraIssue) => i.key, Row: JiraRow, Detail: JiraDetail } as unknown as AreaView,
  wiki: { idOf: (i: WikiPageRow) => i.id, Row: WikiRow, Detail: WikiDetail } as unknown as AreaView,
};

/** Nav and list widths: the user's (dragged or < >) within limits that leave the detail `MIN_PANE` columns. */
export function paneWidths(width: number, userNav?: number, userList?: number, showNav = true): { nav: number; list: number } {
  const nav = Math.min(userNav ?? Math.min(40, Math.max(24, Math.floor(width * 0.22))), width - 2 * MIN_PANE);
  const rest = width - (showNav ? nav : 0);
  const list = Math.min(userList ?? Math.floor(rest * 0.48), rest - MIN_PANE);
  return { nav: Math.max(MIN_PANE, nav), list: Math.max(MIN_PANE, list) };
}

export function Shell() {
  const env = useEnv();
  const { width, height } = useTerminalDimensions();
  const area = useApp((s) => s.area);
  const navOpen = useApp((s) => s.navOpen);
  const zoom = useApp((s) => s.zoom);
  const focus = useApp((s) => s.focus);
  useKeyboard((event) => handleKey(env, event));

  const userNav = useApp((s) => s.navWidth);
  const userList = useApp((s) => s.listWidth);
  const view = ROWS[area];
  const compact = width < 100;
  const navWidth = paneWidths(width, userNav, userList).nav;
  const showNav = !zoom && navOpen && (!compact || focus === "nav");
  const listWidth = compact ? undefined : paneWidths(width, userNav, userList, showNav).list;
  const bodyHeight = height - 2;

  return (
    <box style={{ flexDirection: "column", width, height, backgroundColor: env.theme.bg }}>
      <Header width={width} />
      <box style={{ flexDirection: compact ? "column" : "row", flexGrow: 1 }}>
        {showNav && !compact ? <NavPane width={navWidth} /> : null}
        {showNav && compact ? <NavPane width={width} /> : null}
        {!zoom && !(compact && showNav) ? (
          <ListPane width={listWidth} height={compact ? Math.floor(bodyHeight * 0.45) : undefined} idOf={view.idOf} Row={view.Row} />
        ) : null}
        {!(compact && showNav) ? <view.Detail /> : null}
      </box>
      <StatusBar width={width} />
      <Overlays width={width} height={height} />
    </box>
  );
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, screenMode: "alternate-screen", targetFps: 30 });
  const theme = THEMES[opts.config?.theme ?? "dark"];
  const syntax = syntaxStyleFor(theme, renderer.nativeScene);
  const store = createStore(initialState(opts.area ?? opts.config?.area ?? "jira"));
  let quit!: () => void;
  const done = new Promise<void>((resolve) => (quit = resolve));
  const ctx = createCtx(store, opts, renderer, () => quit());
  const env: Env = { ctx, theme, syntax, commands: allCommands(), areas: AREAS, keymap: opts.config?.keymap ?? {} };
  // `kill` or a closed terminal ends the TUI and restores the terminal, instead of leaving it running.
  const onSignal = () => quit();
  const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  try {
    createRoot(renderer).render(
      <EnvProvider value={env}>
        <Shell />
      </EnvProvider>
    );
    void AREAS[store.get().area].init(ctx).catch((err) => ctx.toast("error", err instanceof Error ? err.message : String(err)));
    await done;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    renderer.destroy();
    await renderer.closed;
    syntax.destroy();
  }
}

/**
 * Draws the shell once into OpenTUI's test renderer: no terminal, no network.
 * It proves that a binary's embedded native library loads, which CI checks on
 * Windows, where the cross-compiled build otherwise never runs.
 */
export async function selfTest(): Promise<string> {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const screen = await createTestRenderer({ width: 100, height: 24 });
  const theme = THEMES.dark;
  const syntax = syntaxStyleFor(theme, screen.renderer.nativeScene);
  const offline = {} as never;
  const opts: TuiOptions = { profile: "self-test", siteUrl: "https://example.invalid", jira: offline, confluence: offline, openUrl: async () => {}, editText: async (text) => text };
  const ctx = createCtx(createStore(initialState("jira")), opts, undefined, () => {});
  try {
    createRoot(screen.renderer).render(
      <EnvProvider value={{ ctx, theme, syntax, commands: allCommands(), areas: AREAS, keymap: {} }}>
        <Shell />
      </EnvProvider>
    );
    // React commits asynchronously; draw until the shell shows (a few passes at most).
    for (let pass = 0; pass < 20; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await screen.renderOnce();
      const frame = screen.captureCharFrame();
      if (frame.includes("1 Jira") && frame.includes("self-test")) return frame;
    }
    throw new Error(`The TUI did not draw its shell:\n${screen.captureCharFrame()}`);
  } finally {
    screen.renderer.destroy();
    syntax.destroy();
  }
}
