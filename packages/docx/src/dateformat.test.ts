import { describe, expect, it } from "bun:test";
import { formatDatePlaceholder, formatSimpleDate } from "./dateformat.js";

// A fixed local date: 2026-07-14 09:05:03.
const D = new Date(2026, 6, 14, 9, 5, 3);

describe("formatSimpleDate (SimpleDateFormat subset)", () => {
  it("formats the supported tokens", () => {
    expect(formatSimpleDate(D, "yyyy-MM-dd").text).toBe("2026-07-14");
    expect(formatSimpleDate(D, "dd.MM.yyyy").text).toBe("14.07.2026");
    expect(formatSimpleDate(D, "HH:mm").text).toBe("09:05");
    expect(formatSimpleDate(D, "d/M/yy").text).toBe("14/7/26");
  });

  it("passes through literals and quoted text", () => {
    expect(formatSimpleDate(D, "yyyy 'at' HH:mm").text).toBe("2026 at 09:05");
    expect(formatSimpleDate(D, "dd''MM").text).toBe("14'07");
  });

  it("formats quarter tokens (Q/QQ/QQQ/QQQQ)", () => {
    // D is in July → Q3.
    expect(formatSimpleDate(D, "Q").text).toBe("3");
    expect(formatSimpleDate(D, "QQ").text).toBe("03");
    expect(formatSimpleDate(D, "QQQ").text).toBe("Q3");
    expect(formatSimpleDate(D, "QQQQ").text).toBe("3rd quarter");
    expect(formatSimpleDate(D, "QQQ yyyy").text).toBe("Q3 2026");
  });

  it("covers all four quarters and their ordinals", () => {
    const quarters: Array<[number, string, string]> = [
      [0, "1", "1st quarter"], // January
      [3, "2", "2nd quarter"], // April
      [6, "3", "3rd quarter"], // July
      [9, "4", "4th quarter"], // October
    ];
    for (const [month, q, full] of quarters) {
      const d = new Date(2026, month, 15);
      expect(formatSimpleDate(d, "Q").text).toBe(q);
      expect(formatSimpleDate(d, "QQQQ").text).toBe(full);
    }
  });

  it("still falls back to ISO on an over-long quarter run", () => {
    const res = formatSimpleDate(D, "QQQQQ");
    expect(res.unknownToken).toBe("QQQQQ");
    expect(res.text).toBe("2026-07-14");
  });

  it("falls back to ISO on an unknown token, reporting it", () => {
    const res = formatSimpleDate(D, "yyyy-MM-dd EEEE");
    expect(res.unknownToken).toBe("EEEE");
    expect(res.text).toBe("2026-07-14");
  });
});

describe("formatDatePlaceholder", () => {
  it("defaults to ISO date when no argument", () => {
    expect(formatDatePlaceholder(D).text).toBe("2026-07-14");
  });
  it("uses the argument when present", () => {
    expect(formatDatePlaceholder(D, "dd.MM.yyyy").text).toBe("14.07.2026");
  });
});
