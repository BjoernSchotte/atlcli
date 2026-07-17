import { normalizeExportColor } from "@atlcli/confluence";
import type { PdfTheme, PdfThemeOptions } from "./types.js";

export const DEFAULT_PDF_THEME: Readonly<PdfTheme> = {
  colors: {
    ink: "#172B4D",
    paper: "#FCFBF8",
  },
  table: {
    coloredCellText: {
      mode: "auto",
      onDark: "#FCFBF8",
      onLight: "#172B4D",
      minimumContrast: 4.5,
    },
  },
};

function themeColor(value: string | undefined, fallback: string, path: string): string {
  if (value === undefined) return fallback;
  const normalized = normalizeExportColor(value);
  if (!normalized) throw new Error(`Invalid PDF theme color at ${path}: ${value}`);
  return normalized;
}

/** Resolve a partial public theme into the complete Typst render theme. */
export function resolvePdfTheme(options: PdfThemeOptions = {}): PdfTheme {
  const ink = themeColor(options.colors?.ink, DEFAULT_PDF_THEME.colors.ink, "colors.ink");
  const paper = themeColor(options.colors?.paper, DEFAULT_PDF_THEME.colors.paper, "colors.paper");
  const mode = options.table?.coloredCellText?.mode ?? DEFAULT_PDF_THEME.table.coloredCellText.mode;
  if (mode !== "auto" && mode !== "source") {
    throw new Error(`Invalid PDF table cell text mode: ${String(mode)}`);
  }
  const minimumContrast = options.table?.coloredCellText?.minimumContrast
    ?? DEFAULT_PDF_THEME.table.coloredCellText.minimumContrast;
  if (!Number.isFinite(minimumContrast) || minimumContrast < 1 || minimumContrast > 21) {
    throw new Error(`PDF table cell minimum contrast must be between 1 and 21: ${minimumContrast}`);
  }

  return {
    colors: { ink, paper },
    table: {
      coloredCellText: {
        mode,
        onDark: themeColor(options.table?.coloredCellText?.onDark, paper, "table.coloredCellText.onDark"),
        onLight: themeColor(options.table?.coloredCellText?.onLight, ink, "table.coloredCellText.onLight"),
        minimumContrast,
      },
    },
  };
}

function colorChannels(color: string): [number, number, number] {
  const normalized = normalizeExportColor(color);
  if (!normalized) throw new Error(`Invalid PDF render color: ${color}`);
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function relativeLuminance(color: string): number {
  const channels = colorChannels(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio for two canonical or normalizable CSS colors. */
export function pdfColorContrast(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Select the theme's semantic foreground for a source-colored table cell. */
export function pdfTableCellForeground(background: string, theme: PdfTheme): string {
  // A semantic dark/light split intentionally follows the theme instead of
  // picking the mathematically strongest candidate. This keeps section rows
  // visually coherent: dark fills receive the theme's paper ink.
  return relativeLuminance(background) < 0.5
    ? theme.table.coloredCellText.onDark
    : theme.table.coloredCellText.onLight;
}

/** Whether source inline ink may survive the configured table-cell policy. */
export function preservePdfSourceCellColor(
  sourceColor: string | undefined,
  background: string,
  theme: PdfTheme
): string | undefined {
  if (theme.table.coloredCellText.mode !== "source" || !sourceColor) return undefined;
  const normalized = normalizeExportColor(sourceColor);
  if (!normalized) return undefined;
  return pdfColorContrast(normalized, background) >= theme.table.coloredCellText.minimumContrast
    ? normalized
    : undefined;
}
