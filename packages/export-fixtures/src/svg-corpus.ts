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
  /** The SVG source, UTF-8 encoded by consumers unless `bytes` is provided. */
  svg: string;
  /**
   * Raw bytes to feed instead of `new TextEncoder().encode(svg)` — for
   * encoding-variant cases (UTF-16/BOM) that a string field cannot represent.
   */
  bytes?: Uint8Array;
}

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** UTF-16LE bytes with a BOM (0xFF 0xFE) — for the encoding-variant case. */
function utf16leWithBom(source: string): Uint8Array {
  const out = new Uint8Array(2 + source.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < source.length; i++) {
    out[2 + i * 2] = source.charCodeAt(i) & 0xff;
    out[2 + i * 2 + 1] = (source.charCodeAt(i) >> 8) & 0xff;
  }
  return out;
}

const SCRIPT_PAYLOAD = `<svg ${NS}><script>alert(1)</script><rect/></svg>`;

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
    id: "vbscript-scheme",
    category: "must-reject",
    note: "vbscript: URI scheme in an anchor",
    svg: `<svg ${NS}><a href="vbscript:msgbox(1)"><rect/></a></svg>`,
  },
  {
    id: "external-dtd-entity",
    category: "must-reject",
    note: "external DTD / SYSTEM entity (XXE)",
    svg: `<!DOCTYPE svg [<!ENTITY x SYSTEM "http://evil.example/x">]><svg ${NS}/>`,
  },
  {
    id: "utf8-bom-script",
    category: "must-reject",
    note: "UTF-8 BOM prefix + <script> — decoder strips the BOM, sanitizer catches it",
    svg: `﻿${SCRIPT_PAYLOAD}`,
  },
  {
    id: "utf16le-bom-script",
    category: "must-reject",
    note:
      "UTF-16LE+BOM <script> — rejected TODAY by the media-type sniff (bytes " +
      "don't decode to `<svg` as UTF-8), NOT by findSvgSafetyViolation, which " +
      "is blind to UTF-16 (named gap: 006's assertSafeSvg must decode by BOM " +
      "before scanning; if the sniff ever becomes encoding-aware first, this " +
      "case flips to embedded and the test fails, catching the regression)",
    svg: SCRIPT_PAYLOAD,
    bytes: utf16leWithBom(SCRIPT_PAYLOAD),
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
