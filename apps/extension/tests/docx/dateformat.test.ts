import { describe, expect, it } from "bun:test";
import { formatDatePlaceholder, formatSimpleDate } from "../../utils/docx/dateformat.js";

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
