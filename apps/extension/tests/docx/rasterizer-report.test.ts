import { describe, expect, it } from "bun:test";
import { rasterizerTimingNote } from "../../entrypoints/sidepanel/TemplateSection.js";

describe("rasterizerTimingNote", () => {
  it("omits the extension note when no rasterization succeeded", () => {
    expect(
      rasterizerTimingNote({
        calls: 0,
        decodeMs: 0,
        drawMs: 0,
        encodeMs: 0,
        encodeCallsMs: [],
      })
    ).toBeNull();
  });

  it("preserves the current conditional perf-timing note", () => {
    expect(
      rasterizerTimingNote({
        calls: 2,
        decodeMs: 7,
        drawMs: 4,
        encodeMs: 10,
        encodeCallsMs: [4, 6],
      })
    ).toEqual({
      level: "info",
      code: "perf-timing",
      message:
        "Panel rasterizer: 2 call(s) — decode 7 ms, draw 4 ms, encode 10 ms " +
        "(sums; per call 4/6 ms).",
    });
  });
});
