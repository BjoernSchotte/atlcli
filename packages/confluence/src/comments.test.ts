import { describe, test, expect } from "bun:test";
import {
  getCommentsFilePath,
  commentBodyToText,
  countComments,
  hasComments,
} from "./comments.js";
import type { PageComments, FooterComment, InlineComment } from "./client.js";

describe("Comments Utilities", () => {
  describe("getCommentsFilePath", () => {
    test("converts markdown path to comments.json path", () => {
      expect(getCommentsFilePath("docs/architecture.md")).toBe(
        "docs/architecture.comments.json"
      );
    });

    test("handles nested paths", () => {
      expect(getCommentsFilePath("docs/api/reference.md")).toBe(
        "docs/api/reference.comments.json"
      );
    });

    test("handles root paths", () => {
      expect(getCommentsFilePath("page.md")).toBe("page.comments.json");
    });

    test("handles absolute paths", () => {
      expect(getCommentsFilePath("/home/user/docs/page.md")).toBe(
        "/home/user/docs/page.comments.json"
      );
    });
  });

  describe("commentBodyToText", () => {
    test("converts simple HTML to text", () => {
      expect(commentBodyToText("<p>Hello world</p>")).toBe("Hello world");
    });

    test("removes bold/italic markers", () => {
      expect(commentBodyToText("<p><strong>Bold</strong> text</p>")).toBe(
        "Bold text"
      );
    });

    test("converts links to text", () => {
      expect(
        commentBodyToText('<p>Check <a href="http://example.com">this link</a></p>')
      ).toBe("Check this link");
    });

    test("collapses whitespace", () => {
      expect(commentBodyToText("<p>Hello</p><p>World</p>")).toBe("Hello World");
    });

    test("handles empty content", () => {
      expect(commentBodyToText("")).toBe("");
    });
  });

  describe("countComments", () => {
    test("counts footer comments", () => {
      const comments: PageComments = {
        pageId: "123",
        lastSynced: "2026-01-11T00:00:00Z",
        footerComments: [
          createFooterComment("1", []),
          createFooterComment("2", []),
        ],
        inlineComments: [],
      };

      expect(countComments(comments)).toEqual({
        footer: 2,
        inline: 0,
        total: 2,
      });
    });

    test("counts inline comments", () => {
      const comments: PageComments = {
        pageId: "123",
        lastSynced: "2026-01-11T00:00:00Z",
        footerComments: [],
        inlineComments: [
          createInlineComment("1", "selection", []),
          createInlineComment("2", "other", []),
          createInlineComment("3", "third", []),
        ],
      };

      expect(countComments(comments)).toEqual({
        footer: 0,
        inline: 3,
        total: 3,
      });
    });

    test("counts replies", () => {
      const comments: PageComments = {
        pageId: "123",
        lastSynced: "2026-01-11T00:00:00Z",
        footerComments: [
          createFooterComment("1", [
            createFooterComment("1.1", []),
            createFooterComment("1.2", [createFooterComment("1.2.1", [])]),
          ]),
        ],
        inlineComments: [],
      };

      expect(countComments(comments)).toEqual({
        footer: 4, // 1 + 2 replies + 1 nested reply
        inline: 0,
        total: 4,
      });
    });

    test("counts mixed comments and replies", () => {
      const comments: PageComments = {
        pageId: "123",
        lastSynced: "2026-01-11T00:00:00Z",
        footerComments: [
          createFooterComment("1", [createFooterComment("1.1", [])]),
        ],
        inlineComments: [
          createInlineComment("2", "text", [
            createInlineComment("2.1", "text", []),
          ]),
        ],
      };

      expect(countComments(comments)).toEqual({
        footer: 2,
        inline: 2,
        total: 4,
      });
    });
  });

  describe("hasComments", () => {
    test("returns false for empty comments", () => {
      const comments: PageComments = {
        pageId: "123",
        lastSynced: "2026-01-11T00:00:00Z",
        footerComments: [],
        inlineComments: [],
      };

      expect(hasComments(comments)).toBe(false);
    });

    test("returns true for footer comments", () => {
      const comments: PageComments = {
        pageId: "123",
        lastSynced: "2026-01-11T00:00:00Z",
        footerComments: [createFooterComment("1", [])],
        inlineComments: [],
      };

      expect(hasComments(comments)).toBe(true);
    });

    test("returns true for inline comments", () => {
      const comments: PageComments = {
        pageId: "123",
        lastSynced: "2026-01-11T00:00:00Z",
        footerComments: [],
        inlineComments: [createInlineComment("1", "text", [])],
      };

      expect(hasComments(comments)).toBe(true);
    });
  });
});

// Helper functions to create test comments
function createFooterComment(id: string, replies: FooterComment[]): FooterComment {
  return {
    id,
    author: { displayName: "Test User" },
    created: "2026-01-11T00:00:00Z",
    body: "<p>Test comment</p>",
    status: "open",
    replies,
  };
}

function createInlineComment(
  id: string,
  textSelection: string,
  replies: InlineComment[]
): InlineComment {
  return {
    id,
    author: { displayName: "Test User" },
    created: "2026-01-11T00:00:00Z",
    body: "<p>Test inline comment</p>",
    status: "open",
    textSelection,
    replies,
  };
}
