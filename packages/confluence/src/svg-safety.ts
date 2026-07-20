/**
 * Shared SVG safety blocklist for every SVG entering an export pipeline
 * (spec 006 G4). One helper, three callers — the PDF asset path
 * (`@atlcli/pdf` `prepare.ts`), the PDF logo-settings path (`settings.ts`),
 * and the DOCX SVG-attachment path (`@atlcli/docx` `export.ts`) — so the
 * policy can never drift between engines.
 *
 * This is a validator, not a rewriter: {@link findSvgSafetyViolation} returns
 * the first violated rule and the caller rejects the bytes;
 * {@link assertSafeSvg} throws the single shared error text. The rules are a
 * deliberately small, named, auditable list implemented with case-insensitive,
 * namespace-prefix-aware regexes (an XML parser dependency is intentionally
 * avoided; over-rejection of exotic-but-legal SVG is acceptable, under-rejection
 * is not):
 *
 * 1. `doctype-or-entity` — any `<!DOCTYPE` or `<!ENTITY` (XXE / entity
 *    expansion class).
 * 2. `blocked-element` — `script` / `foreignObject` elements, with or without
 *    a namespace prefix (`<svg:script>` must not bypass the check).
 * 3. `event-handler-attribute` — any `on*` attribute, with or without a
 *    namespace prefix (`onload=`, `svg:onload=`).
 * 4. `non-fragment-reference` — any `href` / `*:href` value that is not empty
 *    and not a pure `#fragment` reference. This blocks `javascript:` and
 *    `data:` URIs, external URLs, and relative paths alike — bundled bytes
 *    must never reference anything outside themselves.
 * 5. `css-external-reference` — a CSS `url(https://…)` / `url(data:…)` or an
 *    `@import` of an external stylesheet, whether carried in a `<style>`
 *    element body or a `style="…"` attribute. Today's element/attribute
 *    `href` rules do not cover CSS-carried loads, so a `<style>` with
 *    `background:url(https://evil/x)` would otherwise slip through (spec 006
 *    G4 extension). `url(#fragment)` (gradients, clip paths) stays legal — the
 *    rule only fires on `https:`/`data:` targets.
 */

export interface SvgSafetyViolation {
  rule:
    | "doctype-or-entity"
    | "blocked-element"
    | "event-handler-attribute"
    | "non-fragment-reference"
    | "css-external-reference";
  detail: string;
}

// XML names may carry a namespace prefix; every rule matches the local name
// behind any `prefix:`.
const NAME_PREFIX = String.raw`(?:[A-Za-z_][\w.-]*:)?`;

const DOCTYPE_OR_ENTITY = /<!(?:DOCTYPE|ENTITY)\b/i;
const BLOCKED_ELEMENT = new RegExp(String.raw`<\s*${NAME_PREFIX}(?:script|foreignObject)\b`, "i");
const EVENT_HANDLER = new RegExp(String.raw`[\s"']${NAME_PREFIX}on[a-z]+\s*=`, "i");
const HREF_ATTRIBUTE = new RegExp(
  String.raw`[\s"']${NAME_PREFIX}href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`,
  "gi"
);
// A CSS `url()` whose target is an external/data scheme — `url(#frag)` and
// relative `url(x)` are NOT external, but a bundled SVG has nothing legitimate
// to load over `https:`/`data:`, so those are rejected (matches the `href`
// rule's stance on external + data references).
const CSS_URL_EXTERNAL = /url\(\s*["']?\s*(?:https?:|data:)/i;
// `@import "https://…"` or `@import url(data:…)` — any external stylesheet load.
const CSS_IMPORT_EXTERNAL = /@import\s+(?:url\(\s*)?["']?\s*(?:https?:|data:)/i;

/** Returns the first violated safety rule, or `undefined` for a clean SVG. */
export function findSvgSafetyViolation(source: string): SvgSafetyViolation | undefined {
  if (DOCTYPE_OR_ENTITY.test(source)) {
    return {
      rule: "doctype-or-entity",
      detail: "DOCTYPE and ENTITY declarations are not allowed",
    };
  }
  if (BLOCKED_ELEMENT.test(source)) {
    return {
      rule: "blocked-element",
      detail: "script and foreignObject elements are not allowed",
    };
  }
  if (EVENT_HANDLER.test(source)) {
    return {
      rule: "event-handler-attribute",
      detail: "on* event handler attributes are not allowed",
    };
  }
  HREF_ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HREF_ATTRIBUTE.exec(source)) !== null) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value !== "" && !value.startsWith("#")) {
      return {
        rule: "non-fragment-reference",
        detail: "href values must be empty or #fragment references (no external, data:, javascript:, or relative targets)",
      };
    }
  }
  if (CSS_URL_EXTERNAL.test(source) || CSS_IMPORT_EXTERNAL.test(source)) {
    return {
      rule: "css-external-reference",
      detail: "CSS url() / @import must not reference external or data: resources",
    };
  }
  return undefined;
}

/**
 * Decode SVG bytes to a UTF-8 string with **BOM/encoding awareness** (spec 006
 * G4 + spec 011 security corpus). A UTF-16LE/BE byte stream decoded blindly as
 * UTF-8 produces garbage in which `<script>` and friends are invisible to the
 * text scanner — a `<script>` SVG saved UTF-16LE-with-BOM could slip past a
 * naive `new TextDecoder().decode(bytes)`. Detecting the byte-order mark and
 * decoding with the matching encoding means {@link findSvgSafetyViolation} /
 * {@link assertSafeSvg} scan the ACTUAL characters. Callers MUST validate and
 * embed the SAME string this returns (re-encoded to UTF-8), never the original
 * bytes, so a mismatched encoding cannot pass the check on one byte sequence
 * and embed a different one.
 */
export function decodeSvgSource(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  }
  // UTF-8 (TextDecoder strips a leading UTF-8 BOM automatically).
  return new TextDecoder("utf-8").decode(bytes);
}

/** The single shared rejection message for a hostile SVG (both engines). */
export const SVG_UNSAFE_MESSAGE = "SVG contains active or externally loaded content";

/**
 * Throw when `source` violates the shared SVG safety policy, with the single
 * shared error text so the PDF and DOCX engines reject the same hostile SVG
 * with the same message. `source` MUST be the decoded UTF-8 string that will
 * actually be embedded/rasterized — validating a separately decoded copy would
 * let a BOM / non-UTF-8 declaration pass one byte sequence and embed another.
 */
export function assertSafeSvg(source: string): void {
  const violation = findSvgSafetyViolation(source);
  if (violation) {
    throw new Error(`${SVG_UNSAFE_MESSAGE} (${violation.rule})`);
  }
}
