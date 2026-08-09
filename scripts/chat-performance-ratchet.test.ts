import { describe, expect, test } from "bun:test";
import { parseChatPerformanceRatchetArgumentsV1 } from "./chat-performance-ratchet.js";

describe("Chat performance ratchet CLI", () => {
  test("keeps release defaults strict and accepts explicit T0 baseline thresholds", () => {
    expect(parseChatPerformanceRatchetArgumentsV1(["before.json", "after.json"]))
      .toMatchObject({
        kind: "slice",
        beforePath: "before.json",
        afterPath: "after.json",
        policy: { minimumCallReduction: 1 },
      });
    expect(parseChatPerformanceRatchetArgumentsV1([
      "before.json",
      "after.json",
      "--minimum-call-reduction", "0",
      "--maximum-duration-regression-permille", "75",
    ])).toMatchObject({
      policy: {
        minimumCallReduction: 0,
        maximumDurationRegressionPermille: 75,
      },
    });
  });

  test("accepts exactly three final measured receipts", () => {
    expect(parseChatPerformanceRatchetArgumentsV1([
      "--final", "one.json", "two.json", "three.json",
    ])).toEqual({
      kind: "final",
      receiptPaths: ["one.json", "two.json", "three.json"],
    });
    expect(() => parseChatPerformanceRatchetArgumentsV1([
      "--final", "one.json", "two.json",
    ])).toThrow("RUN1.json RUN2.json RUN3.json");
  });

  test("rejects unknown flags and malformed thresholds", () => {
    expect(() => parseChatPerformanceRatchetArgumentsV1(["a", "b", "--unknown"]))
      .toThrow("Unknown option");
    expect(() => parseChatPerformanceRatchetArgumentsV1([
      "a", "b", "--minimum-call-reduction", "-1",
    ])).toThrow("non-negative integer");
  });
});
