import { describe, expect, it } from "bun:test";
import {
  pdfColorContrast,
  pdfTableCellForeground,
  preservePdfSourceCellColor,
  resolvePdfTheme,
} from "./theme.js";

describe("PDF Typst theme", () => {
  it("derives table contrast ink from the document paper and ink tokens", () => {
    const theme = resolvePdfTheme({
      colors: { paper: "#fffdf5", ink: "#102040" },
    });

    expect(theme.colors).toEqual({ paper: "#FFFDF5", ink: "#102040" });
    expect(theme.table.coloredCellText.onDark).toBe("#FFFDF5");
    expect(theme.table.coloredCellText.onLight).toBe("#102040");
    expect(pdfTableCellForeground("#8994A9", theme)).toBe("#FFFDF5");
    expect(pdfTableCellForeground("#E9F2FF", theme)).toBe("#102040");
  });

  it("retains a source color only in source mode and above the contrast target", () => {
    const auto = resolvePdfTheme();
    const source = resolvePdfTheme({ table: { coloredCellText: { mode: "source" } } });

    expect(preservePdfSourceCellColor("#0052CC", "#FFFFFF", auto)).toBeUndefined();
    expect(preservePdfSourceCellColor("#0052CC", "#FFFFFF", source)).toBe("#0052CC");
    expect(preservePdfSourceCellColor("#172B4D", "#334455", source)).toBeUndefined();
    expect(pdfColorContrast("#FCFBF8", "#334455")).toBeGreaterThan(9);
  });

  it("rejects invalid theme values before generating Typst", () => {
    expect(() => resolvePdfTheme({ colors: { ink: "not-a-color" } })).toThrow("colors.ink");
    expect(() => resolvePdfTheme({
      table: { coloredCellText: { minimumContrast: 22 } },
    })).toThrow("between 1 and 21");
  });
});
