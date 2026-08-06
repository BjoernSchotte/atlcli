import { describe, expect, test } from "bun:test";
import { RESEARCH_ACTIVITY_CODES_V1 } from "@atlcli/research";
import {
  formatCliChatActivityV1,
  formatCliChatCapabilityDetailV1,
} from "./chat-activity.js";

describe("user-facing CLI Chat activity", () => {
  test("covers every semantic activity code without internal identifiers", () => {
    for (const code of RESEARCH_ACTIVITY_CODES_V1) {
      const rendered = formatCliChatActivityV1({
        code,
        status: "started",
      }, "en");
      expect(rendered.length).toBeGreaterThan(3);
      expect(rendered).not.toContain("atlcli.");
      expect(rendered).not.toContain("tool=");
      expect(rendered).not.toContain("calls=");
    }
  });

  test("renders approved reads and searches as concise localized details", () => {
    expect(formatCliChatCapabilityDetailV1({
      kind: "capability",
      seq: 1,
      at: "2026-08-06T12:00:00.000Z",
      callId: "opaque-call",
      toolId: "wiki.search",
      inputKind: "search",
      status: "completed",
      itemCount: 2,
      durationMs: 10,
    }, "de")).toBe("2 Confluence-Treffer gefunden.");
    expect(formatCliChatCapabilityDetailV1({
      kind: "capability",
      seq: 2,
      at: "2026-08-06T12:00:00.000Z",
      callId: "opaque-call-2",
      toolId: "atlassian.bound.read",
      inputKind: "detail",
      status: "completed",
      itemCount: 1,
      durationMs: 10,
    }, "en")).toBe("The attached context was read.");
  });
});
