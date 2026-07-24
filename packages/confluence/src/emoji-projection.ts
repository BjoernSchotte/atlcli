/**
 * Browser-safe catalog and projection policy for typed Confluence legacy emoji.
 *
 * This module is deliberately metadata-only: callers must already know that a
 * value came from an ADF emoji, Storage ac:emoticon, or panel-icon field. Plain
 * text must never be routed through this resolver.
 */

export interface PortableEmojiProjection {
  canonicalName: CanonicalLegacyEmojiName;
  text: string;
}

export type EmojiProjectionResult =
  | { kind: "source-text"; text: string }
  | { kind: "known"; text: string; projection: PortableEmojiProjection }
  | { kind: "unresolved"; text: string };

export type CanonicalLegacyEmojiName =
  | "smile"
  | "sad"
  | "cheeky"
  | "laugh"
  | "wink"
  | "thumbs-up"
  | "thumbs-down"
  | "tick"
  | "cross"
  | "warning"
  | "information"
  | "question"
  | "light-on"
  | "light-off"
  | "yellow-star"
  | "red-star"
  | "green-star"
  | "blue-star"
  | "heart"
  | "broken-heart"
  | "plus"
  | "minus";

const projectionEntries: ReadonlyArray<
  readonly [CanonicalLegacyEmojiName, string]
> = [
  ["smile", "☺"],
  ["sad", "☹"],
  ["cheeky", "😛"],
  ["laugh", "😄"],
  ["wink", "😉"],
  ["thumbs-up", "👍"],
  ["thumbs-down", "👎"],
  ["tick", "✓"],
  ["cross", "✕"],
  ["warning", "⚠"],
  ["information", "ℹ"],
  ["question", "❓"],
  ["light-on", "💡"],
  ["light-off", "⊘"],
  ["yellow-star", "Y★"],
  ["red-star", "R★"],
  ["green-star", "G★"],
  ["blue-star", "B★"],
  ["heart", "♥"],
  ["broken-heart", "💔"],
  ["plus", "⊕"],
  ["minus", "⊖"],
] as const;

function projectionRecord(): Readonly<Record<CanonicalLegacyEmojiName, PortableEmojiProjection>> {
  return Object.freeze(Object.fromEntries(
    projectionEntries.map(([canonicalName, text]) => [
      canonicalName,
      Object.freeze({ canonicalName, text }),
    ])
  )) as Readonly<Record<CanonicalLegacyEmojiName, PortableEmojiProjection>>;
}

/** The 22 legacy names accepted by Markdown authoring and typed export. */
export const CONFLUENCE_LEGACY_EMOJI_PROJECTIONS = projectionRecord();

/** GitHub/Slack-style authoring aliases retained from the original converter. */
export const CONFLUENCE_LEGACY_EMOJI_ALIASES = Object.freeze({
  "+1": "thumbs-up",
  thumbsup: "thumbs-up",
  "-1": "thumbs-down",
  thumbsdown: "thumbs-down",
  check: "tick",
  white_check_mark: "tick",
  heavy_check_mark: "tick",
  x: "cross",
  heavy_multiplication_x: "cross",
  bulb: "light-on",
  idea: "light-on",
  lightbulb: "light-on",
  star: "yellow-star",
  info: "information",
  warn: "warning",
  alert: "warning",
  grinning: "smile",
  grin: "smile",
  smiley: "smile",
  disappointed: "sad",
  cry: "sad",
  stuck_out_tongue: "cheeky",
  joy: "laugh",
  laughing: "laugh",
  love: "heart",
  red_heart: "heart",
} satisfies Record<string, CanonicalLegacyEmojiName>);

/** True for a single colon-wrapped token such as `:warning:`. */
export function isColonEmojiShortName(value: string): boolean {
  return value.length >= 3 &&
    value.startsWith(":") &&
    value.endsWith(":") &&
    !/\s/u.test(value);
}

function unwrappedShortName(value: string): string {
  return isColonEmojiShortName(value) ? value.slice(1, -1) : value;
}

/**
 * Resolve one canonical name or alias. Exactly one surrounding colon pair is
 * accepted; whitespace is never trimmed and nested colon pairs remain unknown.
 */
export function normalizeEmojiShortName(
  value: string
): CanonicalLegacyEmojiName | undefined {
  const candidate = unwrappedShortName(value).toLowerCase();
  if (Object.hasOwn(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS, candidate)) {
    return candidate as CanonicalLegacyEmojiName;
  }
  return CONFLUENCE_LEGACY_EMOJI_ALIASES[
    candidate as keyof typeof CONFLUENCE_LEGACY_EMOJI_ALIASES
  ];
}

/**
 * Select visible text for a value whose typed source already proves emoji
 * semantics. The typed short name is authoritative whenever source text is
 * empty or itself a colon token.
 */
export function projectTypedEmoji(input: {
  shortName: string;
  sourceText?: string;
}): EmojiProjectionResult {
  if (
    input.sourceText !== undefined &&
    input.sourceText.length > 0 &&
    !isColonEmojiShortName(input.sourceText)
  ) {
    return { kind: "source-text", text: input.sourceText };
  }

  const canonicalName = normalizeEmojiShortName(input.shortName);
  if (canonicalName) {
    const projection = CONFLUENCE_LEGACY_EMOJI_PROJECTIONS[canonicalName];
    return { kind: "known", text: projection.text, projection };
  }
  return { kind: "unresolved", text: input.shortName };
}
