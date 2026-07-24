import { describe, expect, it } from "bun:test";
import {
  decorativeCalloutIcon,
  labelledCalloutIcon,
} from "./callout-accessibility.js";

describe("semantic callout icon accessibility spikes", () => {
  it("can mark a glyph as a PDF layout artifact", () => {
    expect(decorativeCalloutIcon('[#text("⚠")]')).toBe(
      'pdf.artifact(kind: "other", [#text("⚠")])',
    );
  });

  it("can give a glyph target-specific replacement text", () => {
    expect(labelledCalloutIcon('[#text("⚠")]', "Warning")).toBe(
      'figure([#text("⚠")], alt: "Warning", outlined: false)',
    );
  });
});
