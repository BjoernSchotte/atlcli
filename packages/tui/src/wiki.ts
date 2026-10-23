/** The Wiki area (M3/M4). */
import type { AreaModule } from "./commands.js";

export const wiki: AreaModule = {
  id: "wiki",
  label: "Wiki",
  commands: [],
  async init(ctx) {
    ctx.store.set((s) => ({ ...s, wiki: { ...s.wiki, list: { ...s.wiki.list, title: "Wiki" } } }));
  },
  async expand() {},
  async open() {},
  select() {},
  async refresh() {},
  itemId: (s, i) => s.wiki.list.items[i]?.id,
  url: () => undefined,
};
