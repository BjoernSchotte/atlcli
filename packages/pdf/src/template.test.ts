import { describe, expect, it } from "bun:test";
import { ATLCLI_TYPST_TEMPLATE } from "./template.js";

describe("atlcli Typst template settings rendering", () => {
  const template = ATLCLI_TYPST_TEMPLATE;

  it("reads page geometry from settings", () => {
    expect(template).toContain('let page-size = settings.at("page", default: "a4")');
    expect(template).toContain('if page-size == "letter" { "us-letter" } else { page-size }');
    expect(template).toContain("paper: paper-name");
    expect(template).toContain(
      'flipped: settings.at("orientation", default: "portrait") == "landscape"'
    );
  });

  it("defines the watermark layer and wires it as the page background", () => {
    expect(template).toContain("#let watermark-layer(wm)");
    expect(template).toContain('background: watermark-layer(settings.at("watermark", default: none))');
    expect(template).toContain("transparentize(");
    expect(template).toContain("place(center + horizon, rotate(");
  });

  it("wraps the cover and its trailing pagebreak in one guard", () => {
    const guard = template.match(/if settings\.at\("cover", default: true\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain("pagebreak()");
    expect(guard).toContain("meta.title");
  });

  it("wraps the outline and its trailing pagebreak in one guard", () => {
    const guard = template.match(/if settings\.at\("outline", default: true\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain("outline(title: contents-label, depth: 3)");
    expect(guard).toContain("pagebreak()");
  });

  it("keeps the intervening white page fill unconditional", () => {
    const betweenGuards = template.slice(
      template.indexOf('if settings.at("cover"'),
      template.indexOf('if settings.at("outline"')
    );
    expect(betweenGuards).toContain("set page(fill: white)");
  });

  it("derives the accent color, header, footer, and branding from settings", () => {
    expect(template).toContain('let indigo = rgb(settings.at("accent-color", default: "#4B57A3"))');
    expect(template).toContain('settings.at("header-text", default: none)');
    expect(template).toContain('settings.at("footer-text", default: none)');
    expect(template).toContain('settings.at("organization-name", default: none)');
    expect(template).toContain('settings.at("logo", default: none)');
    expect(template).toContain('settings.at("logo-alt", default: "")');
    expect(template).toContain('image(logo-path, height: 12mm, width: 45mm, fit: "contain", alt: logo-alt)');
  });

  it("contains no unescaped template-literal leftovers", () => {
    expect(template).not.toContain("${");
  });
});
