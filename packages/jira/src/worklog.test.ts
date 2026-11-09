import { describe, expect, test } from "bun:test";
import { parseTimeToSeconds } from "./worklog";

const H = 3600;

describe("parseTimeToSeconds", () => {
  test("accepts every documented format", () => {
    const cases: Array<[string, number]> = [
      ["2h", 2 * H], ["1.5h", 1.5 * H], ["2.25h", 2.25 * H], ["2 hours", 2 * H],
      ["30m", 1800], ["90m", 5400], ["45 minutes", 2700], ["5 min", 300], ["5mins", 300],
      ["1h30m", 1.5 * H], ["1h 30m", 1.5 * H], ["1 hour 30 minutes", 1.5 * H],
      ["1d", 8 * H], ["2 days", 16 * H], ["1w", 40 * H], ["1 week", 40 * H],
      ["1w 2d", 56 * H], ["1w 2d 3h 4m", 59 * H + 240], ["1w2d3h4m", 59 * H + 240],
      ["1:30", 1.5 * H], ["02:45", 2 * H + 2700], ["  1H 30M ", 1.5 * H],
    ];
    for (const [input, seconds] of cases) {
      expect([input, parseTimeToSeconds(input)]).toEqual([input, seconds]);
    }
  });

  test("honours a custom time config", () => {
    expect(parseTimeToSeconds("1w 1d", { hoursPerDay: 6, daysPerWeek: 4 })).toBe(30 * H);
  });

  test("reads decimals on every unit instead of dropping the integer part", () => {
    expect(parseTimeToSeconds("1.5d")).toBe(12 * H);
    expect(parseTimeToSeconds("1.5h 30m")).toBe(2 * H);
    expect(parseTimeToSeconds("0.5w")).toBe(20 * H);
  });

  test("accepts tokens joined by a comma or 'and'", () => {
    expect(parseTimeToSeconds("1h, 30m")).toBe(5400);
    expect(parseTimeToSeconds("1 hour and 30 minutes")).toBe(5400);
  });

  test("rejects input with anything left over", () => {
    for (const input of ["abc 5m xyz", "5 minutex", "5m xyz", "abc", "", "1.5", "1h foo 30m", "1.h"]) {
      expect(() => parseTimeToSeconds(input)).toThrow("Invalid time format");
    }
  });
});
