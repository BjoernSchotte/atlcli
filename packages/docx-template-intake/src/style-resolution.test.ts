import { describe, expect, test } from "bun:test";
import { resolveDocxStyles } from "./style-resolution.js";

describe("DOCX style resolution", () => {
  test("resolves docDefaults, three basedOn levels, and direct formatting in order", async () => {
    const result = await resolveDocxStyles({
      docDefaults: {
        fonts: { ascii: { family: "Source Serif 4" } },
        sizeHalfPoints: 20,
        spacingAfterTwips: 120,
      },
      styles: [
        {
          styleId: "Base",
          kind: "paragraph",
          locator: "styles.0",
          properties: { sizeHalfPoints: 22, bold: false },
        },
        {
          styleId: "Middle",
          kind: "paragraph",
          basedOn: "Base",
          locator: "styles.1",
          properties: { color: { rgb: "112233" } },
        },
        {
          styleId: "Heading1",
          kind: "paragraph",
          basedOn: "Middle",
          locator: "styles.2",
          qFormat: true,
          properties: { outlineLevel: 0, spacingBeforeTwips: 240 },
        },
      ],
      usage: [
        {
          styleId: "Heading1",
          count: 3,
          story: "document",
          section: 0,
          locator: "document.p.4",
          direct: { sizeHalfPoints: 30, bold: true },
        },
      ],
    });

    const heading = result.styles.find(
      ({ styleRef }) => styleRef === "style.standard.h1"
    );
    expect(heading?.chain).toHaveLength(3);
    expect(heading?.properties).toMatchObject({
      fonts: { ascii: { family: "Source Serif 4" } },
      sizeHalfPoints: 22,
      bold: false,
      color: { rgb: "112233" },
      spacingBeforeTwips: 240,
      spacingAfterTwips: 120,
      outlineLevel: 0,
    });
    expect(heading?.uses[0]?.properties).toMatchObject({
      sizeHalfPoints: 30,
      bold: true,
      color: { rgb: "112233" },
    });
    expect(heading?.role).toBe("h1");
    expect(heading?.roleConfidence).toBe("conclusive");
  });

  test("diagnoses a missing parent, a cycle, and incorrectly typed properties", async () => {
    const result = await resolveDocxStyles({
      styles: [
        {
          styleId: "Missing",
          kind: "paragraph",
          basedOn: "Nowhere",
          locator: "styles.0",
          properties: { sizeHalfPoints: "large" },
        },
        {
          styleId: "CycleA",
          kind: "paragraph",
          basedOn: "CycleB",
          locator: "styles.1",
        },
        {
          styleId: "CycleB",
          kind: "paragraph",
          basedOn: "CycleA",
          locator: "styles.2",
        },
      ],
      usage: [],
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "DOCX_STYLE_CYCLE",
      "DOCX_STYLE_INVALID_PROPERTY",
      "DOCX_STYLE_MISSING_PARENT",
    ]);
    expect(
      result.diagnostics.every(({ params }) =>
        Object.values(params).every(
          (value) =>
            typeof value !== "string" ||
            (!value.includes("Missing") &&
              !value.includes("Cycle") &&
              !value.includes("Nowhere"))
        )
      )
    ).toBe(true);
    expect(
      result.styles
        .filter(({ evidence }) =>
          ["styles.1", "styles.2"].includes(evidence.locator)
        )
        .every(({ resolvable }) => !resolvable)
    ).toBe(true);
  });

  test("uses combined identity, localization, outline, inheritance, and usage evidence", async () => {
    const result = await resolveDocxStyles({
      styles: [
        {
          styleId: "Heading1",
          displayName: "Heading 1",
          kind: "paragraph",
          qFormat: true,
          uiPriority: 9,
          locator: "styles.0",
          properties: { outlineLevel: 0 },
        },
        {
          styleId: "GermanCustom",
          displayName: "Überschrift 1",
          kind: "paragraph",
          qFormat: true,
          uiPriority: 9,
          locator: "styles.1",
          properties: { outlineLevel: 0 },
        },
        {
          styleId: "OutlineCustom",
          displayName: "Executive band",
          kind: "paragraph",
          qFormat: true,
          locator: "styles.2",
          properties: { outlineLevel: 0 },
        },
        {
          styleId: "UnusedHeading",
          displayName: "Heading 1",
          kind: "paragraph",
          locator: "styles.3",
        },
      ],
      usage: [
        {
          styleId: "Heading1",
          count: 2,
          story: "document",
          section: 0,
          locator: "p.0",
        },
        {
          styleId: "GermanCustom",
          count: 4,
          story: "document",
          section: 0,
          locator: "p.1",
        },
        {
          styleId: "OutlineCustom",
          count: 1,
          story: "document",
          section: 0,
          locator: "p.2",
        },
      ],
    });
    const byLocator = new Map(
      result.styles.map((style) => [style.evidence.locator, style])
    );
    expect(byLocator.get("styles.0")).toMatchObject({
      role: "h1",
      roleConfidence: "conclusive",
    });
    expect(byLocator.get("styles.1")).toMatchObject({
      role: "h1",
      roleConfidence: "corroborated",
    });
    expect(byLocator.get("styles.2")).toMatchObject({
      role: "h1",
      roleConfidence: "corroborated",
    });
    expect(byLocator.get("styles.3")?.roleConfidence).toBeUndefined();
  });

  test("excludes deleted usage while retaining a revision signal", async () => {
    const result = await resolveDocxStyles({
      styles: [
        {
          styleId: "Heading1",
          kind: "paragraph",
          qFormat: true,
          locator: "styles.0",
          properties: { outlineLevel: 0 },
        },
      ],
      usage: [
        {
          styleId: "Heading1",
          count: 7,
          story: "document",
          section: 0,
          locator: "deleted.0",
          deleted: true,
        },
        {
          styleId: "Heading1",
          count: 2,
          story: "document",
          section: 0,
          locator: "visible.0",
        },
      ],
    });
    expect(result.styles[0]?.usageCount).toBe(2);
    expect(result.styles[0]?.uses).toHaveLength(1);
    expect(result.revisionsPresent).toBe(true);
  });
});
