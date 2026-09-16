/**
 * The `grep` shortcut guard (decision 12, WP6.3).
 *
 * ## What is being guarded against
 *
 * Confluence's CQL text search matches **whole words**. `grep` matches
 * substrings. So routing a `grep` through CQL can return *fewer* results than
 * the real thing — and an agent reads an empty `grep` as "this does not occur
 * anywhere", which is a wrong answer rather than a slow one.
 *
 * The shortcut is therefore an optimisation that may only ever make a result
 * **faster**, never **smaller**.
 *
 * ## Deviation D9: the plan's guard does not achieve that
 *
 * Decision 12 specifies the guard as "a plain literal at word boundaries,
 * at least three characters, free of regex metacharacters and internal
 * separators". Every one of those conditions is about the *pattern's syntax*,
 * and syntax cannot answer the question that matters, which is about the
 * *corpus*: is this literal a whole word in the pages being searched?
 *
 * The counterexample is one line long. `grep -rl kubern .` is a plain
 * alphanumeric literal of six characters with no metacharacters and no
 * separators, so it passes the plan's guard — and `text ~ "kubern"` matches
 * nothing, while the real `grep` matches every page containing "kubernetes".
 * That is exactly the silently-empty result decision 12 was written to
 * prevent. It is covered by a regression test.
 *
 * ## What this guard does instead
 *
 * The shortcut is taken only when **the caller has told us the pattern is a
 * whole word**, which is the one case where grep's semantics and CQL's provably
 * agree:
 *
 *  - `grep -w <literal>`, the standard word-match flag, or
 *  - a pattern explicitly anchored as `\bliteral\b`.
 *
 * Plus the plan's syntactic conditions, which still apply: three characters or
 * more, no metacharacters beyond the anchors, no separators, alphanumeric only.
 *
 * Losing the shortcut for an unmarked `grep -r kubernetes` costs one bulk
 * request instead of one search — because the *capped prefetch* is what makes
 * a full scan cheap, not CQL. CQL saves the difference between fetching the
 * subtree and fetching the matches, which is real but far smaller than the
 * difference between one request and N. The documentation and the agent
 * snippet tell agents to pass `-w` when they mean a whole word.
 *
 * WP0.3b measures the live tokenizer. If it shows the index matching word
 * prefixes, this can relax to cover `-w`-free prefixes too — but not before.
 */

/** Characters that give a pattern meaning beyond a literal. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/;

/** `\bword\b`, the explicit whole-word anchoring grep understands. */
const ANCHORED = /^\\b(.+)\\b$/;

export interface GuardVerdict {
  qualifies: boolean;
  /** The literal to search for, once anchors are stripped. */
  literal?: string;
  /** Why not, phrased for the stderr line the user actually sees. */
  reason?: string;
}

export interface GuardOptions {
  /** `grep -w`: the caller asserts a whole-word match. */
  wordMatch?: boolean;
  fixedString?: boolean;
  ignoreCase?: boolean;
  extendedRegex?: boolean;
}

export function qualifiesForCqlShortcut(
  pattern: string,
  options: GuardOptions = {},
): GuardVerdict {
  const anchored = ANCHORED.exec(pattern);
  const literal = anchored ? anchored[1]! : pattern;
  const assertedWholeWord = options.wordMatch === true || anchored !== null;

  if (!assertedWholeWord) {
    return {
      qualifies: false,
      reason:
        "the pattern is not marked as a whole word, and CQL matches words while grep matches substrings (pass -w if you mean a whole word)",
    };
  }
  if (literal.length < 3) {
    return { qualifies: false, reason: "the pattern is shorter than three characters" };
  }
  if (!options.fixedString && REGEX_METACHARACTERS.test(literal)) {
    return { qualifies: false, reason: "the pattern contains regex metacharacters" };
  }
  if (/\s/.test(literal)) {
    return { qualifies: false, reason: "the pattern contains whitespace" };
  }
  if (/[-_./:@#]/.test(literal)) {
    return {
      qualifies: false,
      reason: "the pattern contains a separator, which the search index tokenizes differently",
    };
  }
  if (!/^[\p{L}\p{N}]+$/u.test(literal)) {
    return { qualifies: false, reason: "the pattern is not a plain alphanumeric word" };
  }
  void options.ignoreCase;
  void options.extendedRegex;
  return { qualifies: true, literal };
}

/** The CQL for a qualifying pattern, scoped to one space. */
export function cqlForPattern(spaceKey: string, pattern: string): string {
  const escaped = pattern.replace(/["\\]/g, "\\$&");
  return `space = "${spaceKey}" AND type = page AND text ~ "${escaped}"`;
}
