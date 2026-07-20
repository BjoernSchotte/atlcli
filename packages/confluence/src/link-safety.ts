/**
 * The single link-target scheme policy shared by every export engine
 * (spec 011 security hardening).
 *
 * Before this module there were THREE independent implementations of "is this
 * href safe?":
 *   1. `isSafeLinkScheme` in `html-to-blocks.ts` (spec 004, export_view HTML),
 *   2. `isSafeHyperlinkUrl` in `@atlcli/docx`'s `ooxml.ts` (spec 004,
 *      defense-in-depth for the Word `HYPERLINK` field), and
 *   3. an inline `/^(https?:|mailto:)/i` test in `@atlcli/pdf`'s `resolveLink`.
 *
 * (1) and (2) agreed by copy-paste; (3) silently disagreed with both — it did
 * not strip control characters, and it rejected relative URLs the other two
 * allowed. Three policies that can drift is not a policy. Everything now
 * delegates here, and the old names remain as thin wrappers so callers and the
 * public API are unchanged.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 *
 * ## The policy
 *
 * ALLOW: `http:`, `https:`, `mailto:`, `tel:`, and scheme-less URLs (relative
 * paths and in-document `#anchor` fragments, which are same-origin by
 * construction).
 *
 * DENY: everything else — `javascript:`, `vbscript:`, `data:`, `file:`, plus
 * any unknown scheme. An allowlist, never a blocklist: a new dangerous scheme
 * must not become safe merely because nobody thought of it.
 *
 * `tel:` is a deliberate product call, not an oversight. Contact and directory
 * pages legitimately carry phone links; the scheme is inert (it hands a number
 * to a dialler, it cannot execute or fetch), and both Word and PDF render it as
 * an ordinary hyperlink. `sms:`, `callto:` and `skype:` are NOT allowed — they
 * are rarer in enterprise wikis and would widen the surface for no clear gain;
 * they degrade to visible text with a note, which is the correct default for
 * anything whose value is unproven.
 *
 * ## Why control characters are stripped before the scheme is read
 *
 * URL parsers (and Word, and Typst) strip ASCII whitespace and C0 controls
 * while parsing. So `"java\tscript:alert(1)"` — trivially produced by
 * entity-decoded third-party HTML — IS `javascript:` to the consumer, even
 * though a naive `startsWith` sees an unknown `"java\tscript"` scheme and, worse,
 * an edge-trim-only check classifies it as scheme-less and therefore RELATIVE.
 * Stripping first is what closes that bypass.
 */

/** The schemes a link target may carry. Scheme-less URLs are also allowed. */
export const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:", "tel:"] as const;

/**
 * Normalize an href the way a URL parser would before the scheme is inspected:
 * remove every ASCII control character and space anywhere in the string, then
 * lowercase. Exported for tests and for callers that need to explain a verdict.
 */
export function normalizeLinkHref(href: string): string {
  // eslint-disable-next-line no-control-regex
  return href.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
}

/**
 * Whether `href` may become a live link target.
 *
 * This is the canonical predicate; `@atlcli/docx`'s `isSafeHyperlinkUrl` and the
 * PDF serializer's link resolution both delegate to it.
 */
export function isSafeLinkScheme(href: string): boolean {
  const normalized = normalizeLinkHref(href);
  if (normalized === "") return false;
  // No scheme at all → relative / fragment → same-origin by construction.
  if (!/^[a-z][a-z0-9+.-]*:/.test(normalized)) return true;
  return SAFE_LINK_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

/** Why {@link sanitizeLinkHref} refused an href. */
export type UnsafeLinkReason = "empty" | "blocked-scheme";

/** Verdict from {@link sanitizeLinkHref}. */
export type LinkSanitizeResult =
  | { safe: true; href: string }
  | { safe: false; reason: UnsafeLinkReason; scheme?: string };

/**
 * Classify an href, naming the offending scheme when it is refused.
 *
 * Converters use this to degrade an unsafe link to plain visible text plus an
 * `unsafe-link-skipped` note — the link TEXT always survives, only the live
 * target is dropped, so the reader still sees what was written.
 */
export function sanitizeLinkHref(href: string): LinkSanitizeResult {
  const normalized = normalizeLinkHref(href);
  if (normalized === "") return { safe: false, reason: "empty" };
  if (isSafeLinkScheme(href)) {
    // Return the STRIPPED href, never the raw input. The verdict is reached on
    // the control-character-free form, so handing the raw string back would let
    // a caller act on bytes the policy never examined — e.g.
    // `"https://ok.example\u0000javascript:alert(1)"` validates as safe and
    // would be emitted with the NUL intact. Callers upstream happen to strip
    // control characters first today, but the canonical policy module must not
    // depend on that.
    return { safe: true, href: stripControlCharacters(href) };
  }
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/)?.[1];
  return { safe: false, reason: "blocked-scheme", ...(scheme ? { scheme } : {}) };
}

/**
 * Remove ASCII control characters and spaces WITHOUT lowercasing — the form a
 * caller may safely emit. {@link normalizeLinkHref} additionally lowercases,
 * which is right for scheme comparison but destroys case-sensitive paths and
 * query strings.
 */
function stripControlCharacters(href: string): string {
  // eslint-disable-next-line no-control-regex
  return href.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** The report note emitted when a link target is dropped by this policy. */
export const UNSAFE_LINK_NOTE_CODE = "unsafe-link-skipped";

/**
 * Build the user-facing message for an {@link UNSAFE_LINK_NOTE_CODE} note.
 * Kept here so both walkers word the degradation identically.
 */
export function unsafeLinkMessage(result: Extract<LinkSanitizeResult, { safe: false }>, text: string): string {
  const label = text.trim() ? `"${text.trim()}"` : "a link";
  return result.reason === "empty"
    ? `${label} had an empty target and was kept as plain text.`
    : `${label} used the blocked link scheme "${result.scheme ?? "unknown"}:" and was kept as plain text without a clickable target.`;
}
