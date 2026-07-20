/**
 * Adversarial SVG corpus (spec 011, Security hardening — cross-plan SVG policy
 * conformance gate). This folder does NOT implement a sanitizer; it supplies the
 * fixture set both engines must agree on and gates that neither engine accepts a
 * case the other rejects.
 *
 * `must-reject`  — vectors the sanitizers reject today (the regex baseline).
 * `pending-006`  — CSS-carried references (`url(...)` / `@import`) the current
 *                  regex-based sanitizer cannot reliably close. These are the
 *                  forcing function for 006 to move `assertSafeSvg` to a real
 *                  XML/CSS-aware parser (see 011 PLAN, Risks). The test records
 *                  them as a documented gap today and tightens to `must-reject`
 *                  once 006's shared sanitizer lands and closes them.
 */
export type SvgCaseCategory = "must-reject" | "pending-006";

export interface SvgCase {
  id: string;
  category: SvgCaseCategory;
  note: string;
  svg: string;
}

const NS = 'xmlns="http://www.w3.org/2000/svg"';

export const SVG_CORPUS: readonly SvgCase[] = [
  {
    id: "safe-baseline",
    category: "must-reject", // sentinel handled specially: this one MUST be accepted
    note: "control: a plain safe SVG that must embed",
    svg: `<svg ${NS}><rect width="10" height="10" fill="#123456"/></svg>`,
  },
  {
    id: "script-element",
    category: "must-reject",
    note: "active <script> content",
    svg: `<svg ${NS}><script>alert(1)</script><rect/></svg>`,
  },
  {
    id: "foreign-object",
    category: "must-reject",
    note: "<foreignObject> HTML injection",
    svg: `<svg ${NS}><foreignObject><b onclick="x()">hi</b></foreignObject></svg>`,
  },
  {
    id: "event-handler",
    category: "must-reject",
    note: "on* event-handler attribute",
    svg: `<svg ${NS} onload="alert(1)"><rect/></svg>`,
  },
  {
    id: "external-href",
    category: "must-reject",
    note: "external image href",
    svg: `<svg ${NS}><image href="http://evil.example/x.png"/></svg>`,
  },
  {
    id: "external-xlink-href",
    category: "must-reject",
    note: "external xlink:href",
    svg: `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="http://evil.example/x.png"/></svg>`,
  },
  {
    id: "javascript-scheme",
    category: "must-reject",
    note: "javascript: URI scheme in an anchor",
    svg: `<svg ${NS}><a href="javascript:alert(1)"><rect/></a></svg>`,
  },
  {
    id: "external-dtd-entity",
    category: "must-reject",
    note: "external DTD / SYSTEM entity (XXE)",
    svg: `<!DOCTYPE svg [<!ENTITY x SYSTEM "http://evil.example/x">]><svg ${NS}/>`,
  },
  {
    id: "css-url-in-style",
    category: "pending-006",
    note: "CSS url() reference inside a <style> body — regex gap",
    svg: `<svg ${NS}><style>rect{fill:url(http://evil.example/x)}</style><rect/></svg>`,
  },
  {
    id: "css-import-in-style",
    category: "pending-006",
    note: "CSS @import inside a <style> body — regex gap",
    svg: `<svg ${NS}><style>@import url(http://evil.example/x.css);</style><rect/></svg>`,
  },
  {
    id: "css-url-in-style-attr",
    category: "pending-006",
    note: "CSS url() inside a style=\"\" attribute — regex gap",
    svg: `<svg ${NS}><rect style="fill:url(http://evil.example/x)"/></svg>`,
  },
];

export const SVG_SAFE_BASELINE_ID = "safe-baseline";
