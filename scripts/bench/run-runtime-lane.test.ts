import { describe, expect, test } from "bun:test";
import {
  parseRuntimeLaneOptions,
  RUNTIME_LANE_CANDIDATES,
} from "./run-runtime-lane.js";

describe("runtime lane options", () => {
  test("defaults to all candidates, three repeats, and image-heavy", () => {
    expect(parseRuntimeLaneOptions([])).toEqual({
      repeat: 3,
      candidates: [...RUNTIME_LANE_CANDIDATES],
      corpus: "image-heavy",
    });
  });

  test("accepts the real mixed corpus explicitly", () => {
    expect(
      parseRuntimeLaneOptions([
        "--repeat",
        "2",
        "--candidate",
        "forward-port",
        "--corpus",
        "mixed",
      ]),
    ).toEqual({ repeat: 2, candidates: ["forward-port"], corpus: "mixed" });
  });

  test.each([
    [["--repeat", "0"], "positive integer"],
    [["--repeat", "1.5"], "positive integer"],
    [["--candidate", "unknown"], "unknown --candidate"],
    [["--corpus", "typo"], "unknown --corpus"],
    [["--corpus"], "requires a value"],
  ] as const)("rejects invalid arguments %j", (argv, message) => {
    expect(() => parseRuntimeLaneOptions(argv)).toThrow(message);
  });
});
