import { RGBA, SyntaxStyle, type CliRenderer } from "@opentui/core";

export interface Theme {
  bg: string;
  fg: string;
  dim: string;
  border: string;
  focus: string;
  selectedBg: string;
  markedFg: string;
  accent: string;
  key: string;
  status: string;
  success: string;
  error: string;
  overlayBg: string;
  addedBg: string;
  removedBg: string;
}

export const THEMES: Record<"dark" | "light", Theme> = {
  dark: {
    bg: "#1a1b26",
    fg: "#c0caf5",
    dim: "#7f849c",
    border: "#3b4261",
    focus: "#7aa2f7",
    selectedBg: "#2f3549",
    markedFg: "#bb9af7",
    accent: "#7aa2f7",
    key: "#7dcfff",
    status: "#e0af68",
    success: "#9ece6a",
    error: "#f7768e",
    overlayBg: "#24283b",
    addedBg: "#1f3a2a",
    removedBg: "#3f2028",
  },
  light: {
    bg: "#f5f5f7",
    fg: "#1f2335",
    dim: "#6b7089",
    border: "#b8bccb",
    focus: "#2e59c7",
    selectedBg: "#dde3f5",
    markedFg: "#7a3fc2",
    accent: "#2e59c7",
    key: "#006b8f",
    status: "#8a5a00",
    success: "#2d7a1f",
    error: "#c0283d",
    overlayBg: "#ffffff",
    addedBg: "#dcf3dc",
    removedBg: "#f8dcdf",
  },
};

/** Markdown and code colors; create once per renderer and destroy on exit. */
export function syntaxStyleFor(theme: Theme, owner: CliRenderer["nativeScene"]): SyntaxStyle {
  const c = (hex: string) => RGBA.fromHex(hex);
  return SyntaxStyle.fromStyles(
    {
      "markup.heading": { fg: c(theme.accent), bold: true },
      "markup.heading.1": { fg: c(theme.accent), bold: true },
      "markup.heading.2": { fg: c(theme.accent), bold: true },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": { dim: true },
      "markup.raw": { fg: c(theme.success) },
      "markup.link": { fg: c(theme.key), underline: true },
      "markup.link.url": { fg: c(theme.key), underline: true },
      "markup.list": { fg: c(theme.status) },
      "markup.quote": { fg: c(theme.dim), italic: true },
      keyword: { fg: c(theme.markedFg), bold: true },
      string: { fg: c(theme.success) },
      comment: { fg: c(theme.dim), italic: true },
      number: { fg: c(theme.status) },
      default: { fg: c(theme.fg) },
    },
    owner
  );
}
