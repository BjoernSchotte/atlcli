import { afterEach, expect, test } from "bun:test";
import { localDay } from "./jira.js";

const tz = process.env.TZ;
afterEach(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

test("worklog report date bounds keep the local calendar day east of UTC", () => {
  process.env.TZ = "Europe/Berlin";
  const since = new Date(2026, 10, 9);
  since.setHours(0, 0, 0, 0);
  // The old bound: local midnight in UTC is still the previous day.
  expect(since.toISOString().split("T")[0]).toBe("2026-11-08");
  expect(localDay(since)).toBe("2026-11-09");
  const until = new Date(2026, 0, 5);
  until.setHours(23, 59, 59, 999);
  expect(localDay(until)).toBe("2026-01-05");
});
