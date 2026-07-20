import { describe, expect, it } from "bun:test";
import {
  assertSafeSvg,
  findSvgSafetyViolation,
  SVG_UNSAFE_MESSAGE,
} from "./svg-safety.js";

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
