import { describe, expect, test } from "bun:test";
import type { FooterComment, InlineComment, PageComments } from "@atlcli/confluence";
import { focusedComment, inlineSelection } from "./page.js";

const comment = (id: string, replies: FooterComment[] = []): FooterComment => ({
  id,
  author: { displayName: "Ann Lee", accountId: "a1" },
  created: "2026-11-12T10:00:00.000Z",
  body: `<p>Comment ${id}</p>`,
  status: "open",
  replies,
});

const comments: PageComments = {
  pageId: "10001",
  lastSynced: "2026-11-12T10:00:00.000Z",
  footerComments: [comment("20000"), comment("20001", [comment("20002", [comment("20003")])])],
  inlineComments: [{ ...comment("30001", [comment("30002")]), textSelection: "important phrase" } as InlineComment],
};

describe("the comment a page link focuses", () => {
  test("a footer comment gives its thread", () => {
    expect(focusedComment(comments, "20001")).toMatchObject({ id: "20001", found: true, kind: "footer", thread: { id: "20001" } });
  });

  test("a reply at any depth gives the thread it belongs to", () => {
    expect(focusedComment(comments, "20003")).toMatchObject({ found: true, kind: "footer", thread: { id: "20001" } });
    expect(focusedComment(comments, "30002")).toMatchObject({ found: true, kind: "inline", thread: { id: "30001", textSelection: "important phrase" } });
  });

  test("a comment that is gone says so instead of failing", () => {
    expect(focusedComment(comments, "99999")).toEqual({ id: "99999", found: false, message: "Comment 99999 is not on this page (deleted, or not visible to you)." });
  });
});

test("an inline comment read back from the API still shows the text it is about", () => {
  const read = { ...comment("30001"), textSelection: "", inlineOriginalSelection: "important phrase" } as InlineComment;
  expect(inlineSelection(read)).toBe("important phrase");
  expect(inlineSelection({ ...read, inlineOriginalSelection: undefined })).toBeUndefined();
});
