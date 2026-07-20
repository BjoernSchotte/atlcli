import { describe, expect, it } from "bun:test";
import { ATLCLI_TYPST_TEMPLATE } from "./template.js";

describe("atlcli Typst template settings rendering", () => {
  const template = ATLCLI_TYPST_TEMPLATE;

  it("reads page geometry from the resolved design (spec 012)", () => {
    expect(template).toContain('let page-size = page-config.at("size", default: "a4")');
    expect(template).toContain('if page-size == "letter" { "us-letter" } else { page-size }');
    expect(template).toContain("paper: paper-name");
    expect(template).toContain(
      'flipped: page-config.at("orientation", default: "portrait") == "landscape"'
    );
  });

  it("defines the watermark layer and wires it as the page background", () => {
    expect(template).toContain("#let watermark-layer(wm)");
    expect(template).toContain('background: watermark-layer(settings.at("watermark", default: none))');
    expect(template).toContain("transparentize(");
    expect(template).toContain("place(center + horizon, rotate(");
  });

  it("wraps the cover and its trailing pagebreak in one guard", () => {
    const guard = template.match(/if cover-config\.at\("enabled", default: true\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain("pagebreak()");
    expect(guard).toContain("meta.title");
  });

  it("wraps the outline and its trailing pagebreak in one guard", () => {
    const guard = template.match(/if outline-config\.at\("enabled", default: true\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain('outline(title: contents-label, depth: outline-config.at("depth", default: 3))');
    expect(guard).toContain("pagebreak()");
  });

  it("keeps the intervening white page fill unconditional", () => {
    const betweenGuards = template.slice(
      template.indexOf('if cover-config.at("enabled"'),
      template.indexOf('if outline-config.at("enabled"')
    );
    expect(betweenGuards).toContain("set page(fill: white)");
  });

  it("derives the accent color from the resolved design and keeps content reads (spec 012)", () => {
    expect(template).toContain('let indigo = rgb(brand.at("accent", default: "#4B57A3"))');
    expect(template).toContain('settings.at("header-text", default: none)');
    expect(template).toContain('settings.at("footer-text", default: none)');
    expect(template).toContain('brand.at("organization-name", default: none)');
    expect(template).toContain('settings.at("logo", default: none)');
    expect(template).toContain('settings.at("logo-alt", default: "")');
    expect(template).toContain('image(logo-path, height: 12mm, width: 45mm, fit: "contain", alt: logo-alt)');
  });

  it("interpolates static design tokens rather than hardcoding literals (spec 012)", () => {
    // The generated Typst carries the values (interpolated from the manifest);
    // the SOURCE file template.ts carries no bare literal — proven by the
    // hardcoding-ledger lint, not here. These pins prove the interpolation
    // wired the built-in defaults through unchanged.
    expect(template).toContain('font: "Source Serif 4"');
    expect(template).toContain('size: 18pt, weight: "semibold"');
    expect(template).toContain('fill: rgb("#172B4D")');
    expect(template).toContain('info: (rgb("#DEEBFF"), rgb("#0747A6"))');
  });

  it("contains no unescaped template-literal leftovers", () => {
    expect(template).not.toContain("${");
  });
});
