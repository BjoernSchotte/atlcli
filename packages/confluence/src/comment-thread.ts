import type { BaseComment, FooterComment, InlineComment, PageComments } from "./client.js";

/** The thread a comment belongs to: its root comment, and the comment itself (the root or one of its replies). */
export type CommentThread =
  | { kind: "footer"; root: FooterComment; comment: FooterComment }
  | { kind: "inline"; root: InlineComment; comment: InlineComment };

function within<T extends BaseComment>(comment: T, id: string): T | undefined {
  if (comment.id === id) return comment;
  for (const reply of comment.replies as T[]) {
    const found = within(reply, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Finds a comment by id among a page's comments, as a link's
 * `focusedCommentId` names it: a footer or inline comment, or a reply at any
 * depth. Undefined when the page has no such comment (deleted, or not visible).
 */
export function findCommentThread(comments: PageComments, commentId: string): CommentThread | undefined {
  for (const root of comments.footerComments) {
    const comment = within(root, commentId);
    if (comment) return { kind: "footer", root, comment };
  }
  for (const root of comments.inlineComments) {
    const comment = within(root, commentId);
    if (comment) return { kind: "inline", root, comment };
  }
  return undefined;
}
