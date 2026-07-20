import { describe, expect, it } from "bun:test";
import {
  assertSafeSvg,
  decodeSvgSource,
  findSvgSafetyViolation,
  SVG_UNSAFE_MESSAGE,
} from "./svg-safety.js";

/** Encode a string as UTF-16 with a leading BOM (LE or BE). */
function utf16Bom(text: string, endian: "le" | "be"): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = endian === "le" ? 0xff : 0xfe;
  out[1] = endian === "le" ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (endian === "le") {
      out[2 + i * 2] = c & 0xff;
      out[3 + i * 2] = c >> 8;
    } else {
      out[2 + i * 2] = c >> 8;
      out[3 + i * 2] = c & 0xff;
    }
  }
  return out;
}

const CLEAN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="url(#grad)"/></svg>`;

describe("findSvgSafetyViolation", () => {
  it("passes a clean SVG (including url(#fragment) references)", () => {
    expect(findSvgSafetyViolation(CLEAN)).toBeUndefined();
  });

  it.each([
    ["<script>", `<svg><script>alert(1)</script></svg>`, "blocked-element"],
    ["namespaced script", `<svg xmlns:s="x"><s:script/></svg>`, "blocked-element"],
    ["foreignObject", `<svg><foreignObject/></svg>`, "blocked-element"],
    ["on* handler", `<svg onload="x()"/>`, "event-handler-attribute"],
    ["javascript href", `<svg><a href="javascript:x">t</a></svg>`, "non-fragment-reference"],
    ["data href", `<svg><image href="data:image/png;base64,AAAA"/></svg>`, "non-fragment-reference"],
    ["external href", `<svg><image href="https://evil/x.png"/></svg>`, "non-fragment-reference"],
    ["doctype/entity", `<svg><!ENTITY x "y"/></svg>`, "doctype-or-entity"],
  ] as const)("rejects %s", (_label, source, rule) => {
    expect(findSvgSafetyViolation(source)?.rule).toBe(rule);
  });

  it.each([
    ["url(https:) in style element", `<svg><style>.a{background:url(https://evil/x)}</style></svg>`],
    ["url(data:) in style attr", `<svg><rect style="fill:url(data:image/png;base64,AA)"/></svg>`],
    ["@import external", `<svg><style>@import url(https://evil/x.css);</style></svg>`],
    ["@import quoted external", `<svg><style>@import "https://evil/x.css";</style></svg>`],
  ] as const)("rejects CSS-carried external reference: %s", (_label, source) => {
    expect(findSvgSafetyViolation(source)?.rule).toBe("css-external-reference");
  });

  it("allows url(#fragment) in CSS (gradients/clip paths)", () => {
    expect(
      findSvgSafetyViolation(`<svg><rect style="fill:url(#grad)"/></svg>`)
    ).toBeUndefined();
  });
});

describe("assertSafeSvg", () => {
  it("does not throw on a clean SVG", () => {
    expect(() => assertSafeSvg(CLEAN)).not.toThrow();
  });

  it("throws the single shared message on a hostile SVG", () => {
    expect(() => assertSafeSvg(`<svg><script/></svg>`)).toThrow(SVG_UNSAFE_MESSAGE);
  });
});

describe("decodeSvgSource (BOM-aware, spec 011 security corpus)", () => {
  const hostile = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;

  it("decodes UTF-8 (no BOM) unchanged", () => {
    expect(decodeSvgSource(new TextEncoder().encode(hostile))).toBe(hostile);
  });

  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(hostile)]);
    expect(decodeSvgSource(bytes)).toBe(hostile);
  });

  it("decodes UTF-16LE + BOM to the real characters", () => {
    expect(decodeSvgSource(utf16Bom(hostile, "le"))).toBe(hostile);
  });

  it("decodes UTF-16BE + BOM to the real characters", () => {
    expect(decodeSvgSource(utf16Bom(hostile, "be"))).toBe(hostile);
  });

  it("makes a UTF-16LE + BOM <script> payload visible to the scanner (must-reject)", () => {
    // The whole point: a naive UTF-8 decode would garble these bytes and the
    // <script> would be invisible. BOM-aware decoding exposes it.
    const decoded = decodeSvgSource(utf16Bom(hostile, "le"));
    expect(() => assertSafeSvg(decoded)).toThrow(SVG_UNSAFE_MESSAGE);
    // A naive UTF-8 decode does NOT contain the literal script tag (proving the
    // decode step is load-bearing).
    expect(new TextDecoder("utf-8").decode(utf16Bom(hostile, "le"))).not.toContain("<script>");
  });
});
