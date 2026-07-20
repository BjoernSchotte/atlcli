/**
 * Shared SVG safety blocklist for every SVG entering the PDF pipeline: logo
 * settings (`settings.ts`) and fetched/diagram assets (`prepare.ts`). One
 * helper, two callers — the two paths must not drift.
 *
 * This is a validator, not a rewriter: the first violated rule is returned and
 * the caller rejects the bytes. The rules are deliberately a small, named,
 * auditable list implemented with case-insensitive, namespace-prefix-aware
 * regexes (an XML parser dependency is intentionally avoided; over-rejection
 * of exotic-but-legal SVG is acceptable, under-rejection is not):
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
 */

export interface SvgSafetyViolation {
  rule: "doctype-or-entity" | "blocked-element" | "event-handler-attribute" | "non-fragment-reference";
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
  return undefined;
}
