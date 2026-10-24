/**
 * Keys inside overlays (help, palette, pickers, confirmations, prompts, the
 * comment editor, diffs). Text itself goes to the focused input; this only
 * handles navigation, submit and cancel.
 */
import type { Command, Ctx } from "./keymap.js";
import { paletteCommands, runSafely } from "./keymap.js";
import { filterItems, popOverlay, pushOverlay, replaceTop, topOverlay, type Overlay, type PickerItem } from "./state.js";

type Of<K extends Overlay["kind"]> = Extract<Overlay, { kind: K }>;

/** Items the picker shows: search results as they are, static items filtered by the query. */
export function pickerItems(o: Of<"picker">): PickerItem[] {
  return o.search ? o.items : filterItems(o.items, o.query);
}

const close = (ctx: Ctx) => ctx.store.set(popOverlay);
const update = (ctx: Ctx, o: Overlay) => ctx.store.set((s) => replaceTop(s, o));

/** Handles a key for the top overlay; false when there is none. */
export function overlayKey(ctx: Ctx, key: string, commands: Command[]): boolean {
  const o = topOverlay(ctx.store.get());
  if (!o) return false;
  switch (o.kind) {
    case "help":
      if (key === "escape" || key === "q" || key === "?" || key === "return") close(ctx);
      return true;
    case "log": {
      const entries = ctx.store.get().log;
      if (key === "escape" || key === "q" || key === "!") close(ctx);
      else if (key === "down" || key === "j") update(ctx, { ...o, selected: Math.min(o.selected + 1, entries.length - 1) });
      else if (key === "up" || key === "k") update(ctx, { ...o, selected: Math.max(o.selected - 1, 0) });
      else if (key === "y") {
        // Newest first on screen.
        const entry = entries[entries.length - 1 - o.selected];
        if (!entry?.commands.length) return true;
        const text = entry.commands.join("\n");
        if (ctx.copy(text)) ctx.toast("success", entry.commands.length === 1 ? "Copied the command" : `Copied ${entry.commands.length} commands`);
        else ctx.toast("error", "This terminal does not support copying (OSC 52).");
      }
      return true;
    }
    case "palette": {
      const found = paletteCommands(commands, ctx.store.get(), o.query);
      if (key === "escape") close(ctx);
      else if (key === "down" || key === "ctrl+n") update(ctx, { ...o, selected: Math.min(o.selected + 1, found.length - 1) });
      else if (key === "up" || key === "ctrl+p") update(ctx, { ...o, selected: Math.max(o.selected - 1, 0) });
      else if (key === "return") {
        const command = found[o.selected];
        close(ctx);
        if (command) runSafely(ctx, () => command.run(ctx));
      }
      return true;
    }
    case "picker": {
      const items = pickerItems(o);
      const current = items[o.selected];
      if (key === "escape") close(ctx);
      else if (key === "down" || key === "ctrl+n") update(ctx, { ...o, selected: Math.min(o.selected + 1, items.length - 1) });
      else if (key === "up" || key === "ctrl+p") update(ctx, { ...o, selected: Math.max(o.selected - 1, 0) });
      else if (key === "tab" && o.multi && current) {
        const marked = o.marked.includes(current.id) ? o.marked.filter((m) => m !== current.id) : [...o.marked, current.id];
        update(ctx, { ...o, marked, toggled: true });
      } else if (key === "return") {
        const free = o.allowFree && o.query.trim() && !items.some((i) => i.label.toLowerCase() === o.query.trim().toLowerCase()) ? o.query.trim() : undefined;
        // Marks the user set (even none left: every label unmarked) are the answer; without any, the item under the cursor.
        const chosen = o.multi && (o.marked.length > 0 || o.toggled);
        const ids = chosen ? o.marked : current && !free ? [current.id] : [];
        if (ids.length === 0 && !free && !chosen) return true;
        close(ctx);
        runSafely(ctx, () => o.onSubmit(ids, free));
      }
      return true;
    }
    case "confirm":
      if (key === "y" || key === "return") {
        if (o.double && o.step === 0) update(ctx, { ...o, step: 1 });
        else {
          close(ctx);
          runSafely(ctx, () => o.onConfirm());
        }
      } else if (key === "n" || key === "escape" || key === "q") close(ctx);
      return true;
    case "prompt":
      if (key === "escape") close(ctx);
      else if (key === "return") {
        close(ctx);
        runSafely(ctx, () => o.onSubmit(o.value));
      }
      return true;
    case "compose":
      if (key === "ctrl+s") {
        if (!o.value.trim()) return true;
        close(ctx);
        runSafely(ctx, () => o.onSubmit(o.value));
      } else if (key === "ctrl+p") update(ctx, { ...o, preview: !o.preview });
      else if (key === "escape") {
        // Text typed is not thrown away without asking.
        if (!o.value.trim()) close(ctx);
        else
          ctx.store.set((s) =>
            pushOverlay(s, {
              kind: "confirm",
              title: "Discard this text?",
              lines: ["The text you wrote is lost."],
              double: false,
              step: 0,
              onConfirm: () => ctx.store.set((st) => popOverlay(st)),
            })
          );
      }
      return true;
    case "diff":
      if (o.onConfirm && (key === "y" || key === "return")) {
        close(ctx);
        runSafely(ctx, () => o.onConfirm!());
      } else if (key === "n" || key === "escape" || key === "q") close(ctx);
      return true;
  }
}

/** Keys the focused text input consumes itself while an overlay with one is open. */
export function overlayTakesText(o: Overlay | undefined): boolean {
  return o?.kind === "palette" || o?.kind === "picker" || o?.kind === "prompt" || o?.kind === "compose";
}
