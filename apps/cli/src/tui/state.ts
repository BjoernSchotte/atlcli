/**
 * The TUI's state and key map as pure functions, so they test without a
 * terminal; `app.tsx` only renders the state and dispatches actions.
 */

export type Pane = "list" | "detail";

export type TuiState = {
  /** Index of the selected issue. */
  selected: number;
  count: number;
  pane: Pane;
};

export type Action =
  | { type: "move"; by: number }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "select"; index: number }
  | { type: "focus"; pane: Pane }
  | { type: "switch" }
  | { type: "loaded"; count: number };

/** Effects the app runs itself; everything else is an `Action`. */
export type Command = "quit" | "refresh" | "open" | "scroll-down" | "scroll-up" | "page-down" | "page-up";

export const initialState: TuiState = { selected: 0, count: 0, pane: "list" };

const clamp = (n: number, count: number) => Math.max(0, Math.min(n, count - 1));

export function reduce(state: TuiState, action: Action): TuiState {
  switch (action.type) {
    case "move":
      return { ...state, selected: clamp(state.selected + action.by, state.count) };
    case "top":
      return { ...state, selected: 0 };
    case "bottom":
      return { ...state, selected: clamp(state.count - 1, state.count) };
    case "select":
      return { ...state, selected: clamp(action.index, state.count), pane: "list" };
    case "focus":
      return { ...state, pane: action.pane };
    case "switch":
      return { ...state, pane: state.pane === "list" ? "detail" : "list" };
    case "loaded":
      return { ...state, count: action.count, selected: clamp(state.selected, action.count) };
  }
}

/** A key press as the action or command it means in the focused pane. */
export function keyFor(
  key: { name: string; ctrl?: boolean; shift?: boolean },
  pane: Pane
): Action | Command | undefined {
  if (key.ctrl && key.name === "c") return "quit";
  switch (key.name) {
    case "q":
      return "quit";
    case "r":
      return "refresh";
    case "o":
      return "open";
    case "tab":
      return { type: "switch" };
    case "return":
    case "l":
    case "right":
      return { type: "focus", pane: "detail" };
    case "escape":
    case "h":
    case "left":
      return { type: "focus", pane: "list" };
  }
  if (pane === "detail") {
    if (key.name === "j" || key.name === "down") return "scroll-down";
    if (key.name === "k" || key.name === "up") return "scroll-up";
    if (key.name === "space" || key.name === "pagedown") return "page-down";
    if (key.name === "pageup") return "page-up";
    return undefined;
  }
  if (key.name === "j" || key.name === "down") return { type: "move", by: 1 };
  if (key.name === "k" || key.name === "up") return { type: "move", by: -1 };
  if (key.name === "pagedown") return { type: "move", by: 10 };
  if (key.name === "pageup") return { type: "move", by: -10 };
  if (key.name === "g" && key.shift) return { type: "bottom" };
  if (key.name === "g") return { type: "top" };
  return undefined;
}
