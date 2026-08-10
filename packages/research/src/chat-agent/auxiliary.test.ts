import { describe, expect, test } from "bun:test";
import { deriveChatAuxiliaryReadNeedsV1 } from "./auxiliary.js";

describe("Chat auxiliary read admission", () => {
  test("keeps ordinary exact summaries on body-only evidence", () => {
    expect(deriveChatAuxiliaryReadNeedsV1("Fasse die aktuelle Seite zusammen.")).toEqual([]);
  });

  test("admits only the optional evidence named by the question", () => {
    expect(deriveChatAuxiliaryReadNeedsV1("Welche Kommentare widersprechen dem Text?")).toEqual([
      "comments",
    ]);
    expect(deriveChatAuxiliaryReadNeedsV1("Compare the labels and version metadata.")).toEqual([
      "metadata",
    ]);
    expect(deriveChatAuxiliaryReadNeedsV1("Summarize comments and page labels.")).toEqual([
      "comments",
      "metadata",
    ]);
  });
});
