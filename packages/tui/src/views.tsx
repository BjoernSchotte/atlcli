/**
 * The shell's views: header, navigator, list, detail frame, status bar and
 * overlays. They render the store and dispatch commands; area-specific rows
 * and details come from `jira-view.tsx` and `wiki-view.tsx`.
 */
import type { ScrollBoxRenderable, SyntaxStyle, TextareaRenderable } from "@opentui/core";
import { createTwoFilesPatch } from "diff";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { AreaModule } from "./commands.js";
import { MIN_PANE, updateList, updateNav, expandNode } from "./commands.js";
import { applies, keysFor, paletteCommands, runSafely, type Command, type Ctx } from "./keymap.js";
import { pickerItems } from "./overlays.js";
import { moveSelection, replaceTop, toggleMark, topOverlay, visibleNodes, type AppState, type Focus, type ListState, type Overlay } from "./state.js";
import { useStore } from "./store.js";
import type { Theme } from "./theme.js";

export interface Env {
  ctx: Ctx;
  theme: Theme;
  syntax: SyntaxStyle;
  commands: Command[];
  areas: Record<AppState["area"], AreaModule>;
  keymap: Record<string, string[]>;
  /** A key was pressed (restarts the auto-refresh wait). */
  onActivity?: () => void;
}

const EnvContext = createContext<Env | null>(null);
export const EnvProvider = EnvContext.Provider;
export function useEnv(): Env {
  const env = useContext(EnvContext);
  if (!env) throw new Error("useEnv outside EnvProvider");
  return env;
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useStore(useEnv().ctx.store, select);
}

/** One line of text clipped to `width` (no wrapping, no middle ellipsis). */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

// ============ Header ============

export function Header({ width }: { width: number }) {
  const env = useEnv();
  const { theme, ctx, areas } = env;
  const area = useApp((s) => s.area);
  const busy = useApp((s) => s.busy);
  const title = useApp((s) => s[s.area].list.query || s[s.area].list.title);
  const right = `${busy ? `${busy}  ` : ""}${ctx.opts.profile}`;
  return (
    <box style={{ height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1, backgroundColor: theme.overlayBg }}>
      <text fg={theme.accent} content="atlcli " />
      {(Object.keys(areas) as AppState["area"][]).map((id, i) => (
        <text
          key={id}
          fg={id === area ? theme.bg : theme.dim}
          bg={id === area ? theme.accent : undefined}
          content={` ${i + 1} ${areas[id].label} `}
          onMouseDown={() => runById(env, `app.area.${id}`)}
        />
      ))}
      <text fg={theme.dim} content={`  ${clip(title, Math.max(0, width - 30 - right.length))}`} style={{ flexGrow: 1 }} wrapMode="none" />
      <text fg={busy ? theme.status : theme.dim} content={right} wrapMode="none" />
    </box>
  );
}

export function runById(env: Env, id: string): void {
  const command = env.commands.find((c) => c.id === id);
  if (command) runCommand(env.ctx, command);
}

export function runCommand(ctx: Ctx, command: Command): void {
  runSafely(ctx, () => command.run(ctx));
}

// ============ Panes ============

function Pane({ focus, title, children, style, onClick, scrollRef, resize }: {
  focus: Focus;
  title: string;
  children: ReactNode;
  style?: Record<string, unknown>;
  onClick?: () => void;
  scrollRef?: React.Ref<ScrollBoxRenderable>;
  /** Dragging the right border sets this width. */
  resize?: "navWidth" | "listWidth";
}) {
  const { theme, ctx } = useEnv();
  const focused = useApp((s) => s.focus === focus && s.overlays.length === 0);
  const dragging = useRef(false);
  return (
    <scrollbox
      ref={scrollRef}
      title={` ${title} `}
      style={{ border: true, borderColor: focused ? theme.focus : theme.border, ...style }}
      onMouseDown={function (this: ScrollBoxRenderable, event) {
        dragging.current = Boolean(resize) && event.x === this.x + this.width - 1;
        if (ctx.store.get().focus !== focus) ctx.store.set((s) => ({ ...s, focus }));
        if (!dragging.current) onClick?.();
      }}
      onMouseDrag={function (this: ScrollBoxRenderable, event) {
        if (!dragging.current || !resize) return;
        const width = Math.max(MIN_PANE, event.x - this.x + 1);
        ctx.store.set((s) => (s[resize] === width ? s : { ...s, [resize]: width }));
      }}
      onMouseUp={() => {
        dragging.current = false;
      }}
    >
      {children}
    </scrollbox>
  );
}

export function NavPane({ width }: { width: number }) {
  const env = useEnv();
  const { theme, ctx } = env;
  const area = useApp((s) => s.area);
  const nav = useApp((s) => s[s.area].nav);
  const ref = useRef<ScrollBoxRenderable>(null);
  const nodes = visibleNodes(nav);
  useEffect(() => {
    if (nav.selected) ref.current?.scrollChildIntoView(`nav-${nav.selected}`);
  }, [nav.selected]);
  return (
    <Pane focus="nav" title="Navigator" style={{ width, flexShrink: 0 }} scrollRef={ref} resize="navWidth">
      {nodes.length === 0 ? <text fg={theme.dim} content=" Loading…" /> : null}
      {nodes.map((node) => {
        const open = nav.expanded.includes(node.id);
        const marker = node.expandable ? (node.loading ? "… " : open ? "▾ " : "▸ ") : "  ";
        const selected = node.id === nav.selected;
        return (
          <box
            key={node.id}
            id={`nav-${node.id}`}
            style={{ height: 1, flexDirection: "row", backgroundColor: selected ? theme.selectedBg : undefined }}
            onMouseDown={(event) => {
              event.stopPropagation();
              if (ctx.store.get().focus !== "nav") ctx.store.set((s) => ({ ...s, focus: "nav" }));
              updateNav(ctx, (t) => ({ ...t, selected: node.id }));
              const module = env.areas[area];
              const opening = node.expandable && !open ? expandNode(ctx, module, node) : Promise.resolve();
              void opening.then(() => module.open(ctx, node)).catch((err) => ctx.toast("error", String(err?.message ?? err)));
            }}
          >
            <text
              fg={node.kind === "group" ? theme.accent : theme.fg}
              content={clip(`${"  ".repeat(node.depth)}${marker}${node.label}`, width - 2)}
              wrapMode="none"
            />
          </box>
        );
      })}
    </Pane>
  );
}

export interface RowProps<T> {
  item: T;
  width: number;
  selected: boolean;
  marked: boolean;
}

export function ListPane<T>({ width, height, idOf, Row }: { width?: number; height?: number; idOf: (item: T) => string; Row: (p: RowProps<T>) => ReactNode }) {
  const env = useEnv();
  const { theme, ctx } = env;
  const list = useApp((s) => s[s.area].list) as unknown as ListState<T>;
  const area = useApp((s) => s.area);
  const ref = useRef<ScrollBoxRenderable>(null);
  const selectedId = list.items[list.selected] ? idOf(list.items[list.selected]!) : undefined;
  useEffect(() => {
    if (selectedId) ref.current?.scrollChildIntoView(`row-${selectedId}`);
  }, [selectedId]);
  const count = list.loading && list.items.length === 0 ? "loading…" : `${list.items.length}${list.hasMore ? "+" : ""}`;
  const marks = list.marked.length ? ` · ${list.marked.length} marked` : "";
  const inner = (width ?? 80) - 2;
  const lastClick = useRef({ id: "", at: 0 });
  return (
    <Pane
      focus="list"
      title={clip(`${list.title} (${count})${marks}${list.loading && list.items.length > 0 ? " · loading…" : ""}`, inner - 4)}
      style={{ ...(width ? { width, flexShrink: 0 } : { flexGrow: 1 }), ...(height ? { height, flexShrink: 0 } : {}) }}
      scrollRef={ref}
      resize={width ? "listWidth" : undefined}
    >
      {list.error ? <text fg={theme.error} content={` ${list.error}`} /> : null}
      {!list.error && !list.loading && list.items.length === 0 ? <text fg={theme.dim} content=" Nothing here." /> : null}
      {list.items.map((item, i) => {
        const id = idOf(item);
        return (
          <box
            key={id}
            id={`row-${id}`}
            style={{ height: 1, flexDirection: "row", backgroundColor: i === list.selected ? theme.selectedBg : undefined }}
            onMouseDown={(event) => {
              // The row decides focus; the pane around it must not reset it.
              event.stopPropagation();
              const module = env.areas[area];
              // Shift+click marks for a bulk change; a double click opens the detail.
              if (event.modifiers.shift) return updateList(ctx, (l) => toggleMark(l, id), module);
              const now = Date.now();
              const double = lastClick.current.id === id && now - lastClick.current.at < 400;
              lastClick.current = { id, at: now };
              ctx.store.set((s) => ({ ...s, focus: double ? "detail" : "list" }));
              updateList(ctx, (l) => moveSelection(l, i), module);
            }}
          >
            <Row item={item} width={inner} selected={i === list.selected} marked={list.marked.includes(id)} />
          </box>
        );
      })}
    </Pane>
  );
}

export function DetailFrame({ title, tabs, active, onTab, children }: {
  title: string;
  tabs?: string[];
  active?: string;
  onTab?: (tab: string) => void;
  children: ReactNode;
}) {
  const { theme, ctx } = useEnv();
  const ref = useRef<ScrollBoxRenderable>(null);
  const request = useApp((s) => s.detailScroll);
  useEffect(() => {
    const box = ref.current;
    if (!box || !request) return;
    if (request.by === "top") box.scrollTo(0);
    else if (request.by === "page") box.scrollBy(1, "viewport");
    else if (request.by === "-page") box.scrollBy(-1, "viewport");
    else box.scrollBy(request.by);
  }, [request?.seq]);
  useEffect(() => {
    ref.current?.scrollTo(0);
  }, [title, active]);
  return (
    <Pane focus="detail" title={title} style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} scrollRef={ref}>
      {tabs ? (
        <box style={{ height: 1, flexDirection: "row", marginBottom: 1 }}>
          {tabs.map((tab) => (
            <text
              key={tab}
              content={` ${tab} `}
              fg={tab === active ? theme.bg : theme.dim}
              bg={tab === active ? theme.accent : undefined}
              onMouseDown={() => {
                ctx.store.set((s) => ({ ...s, focus: "detail" }));
                onTab?.(tab);
              }}
            />
          ))}
          <text fg={theme.dim} content="   , . switch tab" />
        </box>
      ) : null}
      {children}
    </Pane>
  );
}

// ============ Status bar ============

export function StatusBar({ width }: { width: number }) {
  const { theme, commands, keymap } = useEnv();
  const state = useApp((s) => s);
  const toast = state.toasts[state.toasts.length - 1];
  const top = topOverlay(state);
  const hints = top
    ? overlayHint(top)
    : commands
        .filter((c) => c.bar && applies(c, state))
        .map((c) => `${keysFor(c, keymap)[0] ?? ""} ${c.bar}`)
        .join(" · ");
  const right = toast ? toast.text : "";
  const color = toast?.kind === "error" ? theme.error : toast?.kind === "success" ? theme.success : theme.dim;
  return (
    <box style={{ height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }}>
      <text fg={theme.dim} content={clip(hints, Math.max(10, width - right.length - 4))} style={{ flexGrow: 1 }} wrapMode="none" />
      <text fg={color} content={clip(right, Math.floor(width * 0.6))} wrapMode="none" />
    </box>
  );
}

function overlayHint(o: Overlay): string {
  switch (o.kind) {
    case "help":
      return "esc close";
    case "log":
      return "↑↓ choose · y copy the command · esc close";
    case "palette":
      return "type to search · ↑↓ choose · enter run · esc close";
    case "picker":
      return `type to filter · ↑↓ choose${o.multi ? " · tab mark" : ""} · enter ${o.multi ? "apply" : "choose"} · esc cancel`;
    case "confirm":
      return "y confirm · n cancel";
    case "prompt":
      return "enter apply · esc cancel";
    case "compose":
      return "ctrl+s send · ctrl+p preview · esc cancel";
    case "diff":
      return o.onConfirm ? "↑↓ scroll · y apply · n cancel" : "↑↓ scroll · esc close";
  }
}

// ============ Overlays ============

function Dialog({ title, width, height, children }: { title: string; width: number; height: number; children: ReactNode }) {
  const { theme } = useEnv();
  return (
    <box
      // A title wider than the border is not drawn at all: clip it.
      title={` ${clip(title, width - 6)} `}
      style={{
        border: true,
        borderStyle: "rounded",
        borderColor: theme.focus,
        backgroundColor: theme.overlayBg,
        width,
        height,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {children}
    </box>
  );
}

export function Overlays({ width, height }: { width: number; height: number }) {
  const overlay = useApp(topOverlay);
  if (!overlay) return null;
  const w = Math.min(width - 4, overlay.kind === "diff" || overlay.kind === "help" || overlay.kind === "log" ? width - 4 : overlay.kind === "compose" ? 100 : 72);
  const h = Math.min(height - 2, overlay.kind === "diff" || overlay.kind === "help" || overlay.kind === "log" ? height - 2 : overlay.kind === "compose" ? 24 : overlay.kind === "confirm" || overlay.kind === "prompt" ? Math.min(height - 2, 4 + (overlay.kind === "confirm" ? Math.min(overlay.lines.length, 14) : 1)) : 20);
  return (
    <box style={{ position: "absolute", left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h, zIndex: 100 }}>
      <OverlayBody overlay={overlay} width={w} height={h} />
    </box>
  );
}

function OverlayBody({ overlay, width, height }: { overlay: Overlay; width: number; height: number }) {
  switch (overlay.kind) {
    case "help":
      return <Help width={width} height={height} />;
    case "log":
      return <Log overlay={overlay} width={width} height={height} />;
    case "palette":
      return <Palette overlay={overlay} width={width} height={height} />;
    case "picker":
      return <Picker overlay={overlay} width={width} height={height} />;
    case "confirm":
      return <Confirm overlay={overlay} width={width} height={height} />;
    case "prompt":
      return <Prompt overlay={overlay} width={width} height={height} />;
    case "compose":
      return <Compose overlay={overlay} width={width} height={height} />;
    case "diff":
      return <DiffView overlay={overlay} width={width} height={height} />;
  }
}

function Help({ width, height }: { width: number; height: number }) {
  const { theme, commands, keymap } = useEnv();
  const state = useApp((s) => s);
  const shown = commands.filter((c) => applies({ ...c, focus: undefined }, state) && keysFor(c, keymap).length > 0);
  const order = (c: Command) => (c.focus?.includes(state.focus) ? 0 : !c.focus ? (c.area ? 1 : 2) : 3);
  const sorted = [...shown].sort((a, b) => order(a) - order(b));
  return (
    <Dialog title="Keys · esc closes" width={width} height={height}>
      <scrollbox focused style={{ flexGrow: 1 }}>
        {sorted.map((c) => {
          const here = order(c) < 3;
          return (
            <box key={c.id} style={{ height: 1, flexDirection: "row" }}>
              <text fg={here ? theme.key : theme.dim} content={clip(keysFor(c, keymap).join(" "), 18).padEnd(19)} wrapMode="none" style={{ flexShrink: 0 }} />
              <text
                fg={here ? theme.fg : theme.dim}
                content={clip(`${c.title}${c.focus ? `  (${c.focus.join("/")})` : ""}`, width - 24)}
                wrapMode="none"
              />
            </box>
          );
        })}
      </scrollbox>
    </Dialog>
  );
}

function Log({ overlay, width, height }: { overlay: Extract<Overlay, { kind: "log" }>; width: number; height: number }) {
  const { theme } = useEnv();
  const entries = useApp((s) => s.log);
  const ref = useRef<ScrollBoxRenderable>(null);
  const shown = [...entries].reverse();
  const selectedId = shown[overlay.selected]?.id;
  useEffect(() => {
    if (selectedId) ref.current?.scrollChildIntoView(`log-${selectedId}`);
  }, [selectedId]);
  return (
    <Dialog title="Command log · what this session changed, as atlcli commands" width={width} height={height}>
      {shown.length === 0 ? <text fg={theme.dim} content="Nothing changed yet. Every write shows here with its atlcli command." /> : null}
      <scrollbox ref={ref} style={{ flexGrow: 1 }}>
        {shown.map((entry, i) => (
          <box key={entry.id} id={`log-${entry.id}`} style={{ flexDirection: "column", marginBottom: 1, backgroundColor: i === overlay.selected ? theme.selectedBg : undefined }}>
            <box style={{ height: 1, flexDirection: "row" }}>
              <text fg={entry.ok ? theme.success : theme.error} content={`${entry.at} ${entry.ok ? "✓" : "✗"} `} wrapMode="none" style={{ flexShrink: 0 }} />
              <text fg={theme.fg} content={clip(entry.text, width - 16)} wrapMode="none" />
            </box>
            {entry.commands.map((line, n) => (
              <text key={n} fg={theme.key} content={`  $ ${line}`} />
            ))}
          </box>
        ))}
      </scrollbox>
    </Dialog>
  );
}

function TextInput({ value, placeholder, onInput }: { value: string; placeholder?: string; onInput: (v: string) => void }) {
  const { theme } = useEnv();
  return (
    <box style={{ height: 1, flexDirection: "row", marginBottom: 1 }}>
      <text fg={theme.accent} content="› " />
      <input focused value={value} placeholder={placeholder} onInput={onInput} style={{ flexGrow: 1 }} textColor={theme.fg} focusedTextColor={theme.fg} />
    </box>
  );
}

function Palette({ overlay, width, height }: { overlay: Extract<Overlay, { kind: "palette" }>; width: number; height: number }) {
  const { theme, ctx, commands, keymap } = useEnv();
  const state = useApp((s) => s);
  const found = paletteCommands(commands, state, overlay.query);
  return (
    <Dialog title="Command palette" width={width} height={height}>
      <TextInput value={overlay.query} placeholder="type a command" onInput={(query) => ctx.store.set((s) => replaceTop(s, { ...overlay, query, selected: 0 }))} />
      <scrollbox style={{ flexGrow: 1 }}>
        {found.slice(0, 200).map((c, i) => (
          <box key={c.id} style={{ height: 1, flexDirection: "row", backgroundColor: i === overlay.selected ? theme.selectedBg : undefined }}>
            <text fg={theme.fg} content={clip(c.title, width - 20)} wrapMode="none" style={{ flexGrow: 1 }} />
            <text fg={theme.key} content={keysFor(c, keymap)[0] ?? ""} wrapMode="none" />
          </box>
        ))}
      </scrollbox>
    </Dialog>
  );
}

function Picker({ overlay, width, height }: { overlay: Extract<Overlay, { kind: "picker" }>; width: number; height: number }) {
  const { theme, ctx } = useEnv();
  const items = pickerItems(overlay);
  const ref = useRef<ScrollBoxRenderable>(null);
  const searchSeq = useRef(0);
  useEffect(() => {
    const current = items[overlay.selected];
    if (current) ref.current?.scrollChildIntoView(`pick-${current.id}`);
  }, [overlay.selected, items.length]);
  // Remote search (users): debounce, newest answer wins.
  useEffect(() => {
    if (!overlay.search) return;
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      overlay
        .search!(overlay.query)
        .then((found) => {
          if (seq !== searchSeq.current) return;
          ctx.store.set((s) => {
            const top = topOverlay(s);
            return top?.kind === "picker" && top.title === overlay.title ? replaceTop(s, { ...top, items: found, selected: 0 }) : s;
          });
        })
        .catch((err) => ctx.toast("error", err instanceof Error ? err.message : String(err)));
    }, 200);
    return () => clearTimeout(timer);
  }, [overlay.query]);
  return (
    <Dialog title={overlay.title} width={width} height={height}>
      <TextInput value={overlay.query} placeholder={overlay.allowFree ? "type to filter or add" : "type to filter"} onInput={(query) => ctx.store.set((s) => replaceTop(s, { ...overlay, query, selected: 0 }))} />
      <scrollbox ref={ref} style={{ flexGrow: 1 }}>
        {items.length === 0 ? <text fg={theme.dim} content={overlay.allowFree && overlay.query.trim() ? `enter adds "${overlay.query.trim()}"` : "No match."} /> : null}
        {items.map((item, i) => (
          <box
            key={item.id}
            id={`pick-${item.id}`}
            style={{ height: 1, flexDirection: "row", backgroundColor: i === overlay.selected ? theme.selectedBg : undefined }}
            onMouseDown={() => ctx.store.set((s) => replaceTop(s, { ...overlay, selected: i }))}
          >
            {overlay.multi ? <text fg={theme.markedFg} content={overlay.marked.includes(item.id) ? "[x] " : "[ ] "} /> : null}
            <text fg={theme.fg} content={clip(item.label, width - 30)} wrapMode="none" style={{ flexGrow: 1 }} />
            {item.hint ? <text fg={theme.dim} content={clip(item.hint, 22)} wrapMode="none" /> : null}
          </box>
        ))}
      </scrollbox>
    </Dialog>
  );
}

function Confirm({ overlay, width, height }: { overlay: Extract<Overlay, { kind: "confirm" }>; width: number; height: number }) {
  const { theme } = useEnv();
  return (
    <Dialog title={overlay.title} width={width} height={height}>
      <scrollbox style={{ flexGrow: 1 }}>
        {overlay.lines.map((line, i) => (
          <text key={i} fg={theme.fg} content={clip(line, width - 4)} wrapMode="none" />
        ))}
      </scrollbox>
      <text
        fg={overlay.step === 1 ? theme.error : theme.status}
        content={overlay.step === 1 ? "This changes many issues. Press y again to apply · n cancels" : "y confirm · n cancel"}
      />
    </Dialog>
  );
}

function Prompt({ overlay, width, height }: { overlay: Extract<Overlay, { kind: "prompt" }>; width: number; height: number }) {
  const { ctx } = useEnv();
  return (
    <Dialog title={overlay.title} width={width} height={height}>
      <TextInput value={overlay.value} placeholder={overlay.placeholder} onInput={(value) => ctx.store.set((s) => replaceTop(s, { ...overlay, value }))} />
    </Dialog>
  );
}

function Compose({ overlay, width, height }: { overlay: Extract<Overlay, { kind: "compose" }>; width: number; height: number }) {
  const { theme, ctx, syntax } = useEnv();
  const ref = useRef<TextareaRenderable>(null);
  // Back from the preview the editor mounts anew: continue at the end of the text, not at its start.
  useEffect(() => {
    if (!overlay.preview) ref.current?.gotoBufferEnd();
  }, [overlay.preview]);
  return (
    <Dialog title={`${overlay.title}${overlay.preview ? " · preview" : ""}`} width={width} height={height}>
      {overlay.preview ? (
        <scrollbox style={{ flexGrow: 1 }}>
          <markdown content={overlay.value || "_Nothing written yet._"} syntaxStyle={syntax} conceal />
        </scrollbox>
      ) : (
        <textarea
          ref={ref}
          focused
          initialValue={overlay.value}
          placeholder="Markdown: **bold**, - lists, `code`, [links](https://…)"
          textColor={theme.fg}
          focusedTextColor={theme.fg}
          style={{ flexGrow: 1 }}
          onContentChange={() => {
            const value = ref.current?.plainText ?? "";
            ctx.store.set((s) => {
              const top = topOverlay(s);
              return top?.kind === "compose" ? replaceTop(s, { ...top, value }) : s;
            });
          }}
        />
      )}
      <text fg={theme.dim} content="ctrl+s send · ctrl+p preview · esc cancel" />
    </Dialog>
  );
}

/** A unified diff of two texts, for the `<diff>` view. */
export function unifiedDiff(before: string, after: string, name = "page.md"): string {
  return createTwoFilesPatch(`a/${name}`, `b/${name}`, before, after, "", "", { context: 3 });
}

function DiffView({ overlay, width, height }: { overlay: Extract<Overlay, { kind: "diff" }>; width: number; height: number }) {
  const { theme, syntax } = useEnv();
  const patch = unifiedDiff(overlay.before, overlay.after);
  const unchanged = overlay.before === overlay.after;
  return (
    <Dialog title={overlay.title} width={width} height={height}>
      {unchanged ? (
        <text fg={theme.dim} content="No changes." />
      ) : (
        <scrollbox focused style={{ flexGrow: 1 }}>
          <diff diff={patch} view="unified" filetype="markdown" syntaxStyle={syntax} showLineNumbers addedBg={theme.addedBg} removedBg={theme.removedBg} wrapMode="word" />
        </scrollbox>
      )}
      <text fg={overlay.onConfirm ? theme.status : theme.dim} content={overlay.onConfirm ? "y apply · n cancel" : "esc close"} />
    </Dialog>
  );
}
